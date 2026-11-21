begin;
set local lock_timeout='1s';
set local statement_timeout='5s';

create table if not exists app.signup_invites (
 id uuid primary key default gen_random_uuid(),
 email text not null check(email=lower(btrim(email)) and length(email)<=254),
 code_hash bytea not null unique,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 google_authorized_until timestamptz,
 revoked_at timestamptz,
 consumed_at timestamptz,
 consumed_by uuid references auth.users(id) on delete set null deferrable initially deferred
);
create unique index if not exists signup_invites_active_email on app.signup_invites(email) where consumed_at is null and revoked_at is null;
alter table app.signup_invites enable row level security;
revoke all on app.signup_invites from public,anon,authenticated,service_role;

alter table app.signup_invites add column if not exists password_ticket_hash bytea;
alter table app.signup_invites add column if not exists password_ticket_expires_at timestamptz;
-- Upgrade v1 account-only consumption without minting a spare tenant grant.
-- Run this conversion ONLY when introducing the tenant-consumption column:
-- replay must preserve genuinely unused v2 grants for existing account holders.
do $tenant_upgrade$
declare legacy boolean:=not exists(select 1 from pg_catalog.pg_attribute where attrelid='app.signup_invites'::regclass and attname='workspace_consumed_at' and not attisdropped);
begin
 alter table app.signup_invites add column if not exists workspace_id uuid references public.workspaces(id) on delete set null deferrable initially deferred;
 alter table app.signup_invites add column if not exists workspace_consumed_at timestamptz;
 if legacy then
  update app.signup_invites i set workspace_id=(select w.id from public.workspaces w where w.owner_id=i.consumed_by order by w.created_at,w.id limit 1),workspace_consumed_at=i.consumed_at
  where i.consumed_at is not null and exists(select 1 from public.workspaces w where w.owner_id=i.consumed_by);
 end if;
end $tenant_upgrade$;

-- Only the operator's service-role credential can issue or replace a code.
create or replace function public.issue_signup_invite(p_email text,p_expires_at timestamptz default now()+interval '1 day') returns jsonb
language plpgsql security definer set search_path='' as $$
declare address text:=lower(btrim(p_email));code text;invite_id uuid;
begin
 if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 or p_expires_at is null or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '7 days' then
  raise exception 'A valid email and expiry within seven days are required' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(address,0));
 update app.signup_invites set revoked_at=clock_timestamp() where email=address and consumed_at is null and revoked_at is null;
 code:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 insert into app.signup_invites(email,code_hash,expires_at) values(address,sha256(convert_to(code,'UTF8')),p_expires_at) returning id into invite_id;
 return jsonb_build_object('id',invite_id,'email',address,'code',code,'expiresAt',p_expires_at,'entryPath','/invite.html');
end $$;
revoke all on function public.issue_signup_invite(text,timestamptz) from public,anon,authenticated;
grant execute on function public.issue_signup_invite(text,timestamptz) to service_role;

-- Google cannot carry custom signup metadata. A valid code authorizes only
-- this exact email for ten minutes; GoTrue must then prove that Google identity.
-- Preparation does not consume the code, and never creates an account.
create or replace function public.prepare_signup_invite(p_email text,p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ticket text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
begin
 update app.signup_invites set google_authorized_until=least(expires_at,clock_timestamp()+interval '10 minutes'),
 password_ticket_hash=sha256(convert_to(ticket,'UTF8')),password_ticket_expires_at=least(expires_at,clock_timestamp()+interval '10 minutes')
 where email=lower(btrim(p_email)) and code_hash=sha256(convert_to(lower(btrim(p_code)),'UTF8'))
 and consumed_at is null and revoked_at is null and expires_at>clock_timestamp();
 if not found then raise exception 'Access is by invite. Request a new invitation from Cetld.' using errcode='P0001';end if;
 return jsonb_build_object('ok',true,'schemaVersion',2,'ticket',ticket);
end $$;
revoke all on function public.prepare_signup_invite(text,text) from public;
grant execute on function public.prepare_signup_invite(text,text) to anon,authenticated;

create or replace function app.enforce_signup_invite() returns trigger
language plpgsql security definer set search_path='' as $$
declare invitation app.signup_invites%rowtype;provider text:=new.raw_app_meta_data->>'provider';
begin
 if provider='email' and new.raw_user_meta_data ? 'signup_invite_code' then
  raise exception 'Use the invitation entry to upgrade this signup request. Existing sign-in remains available.' using errcode='P0001';
 end if;
 if provider='email' then
  select * into invitation from app.signup_invites
  where email=lower(btrim(new.email)) and (code_hash=sha256(convert_to(lower(btrim(new.raw_user_meta_data->>'signup_invite_code')),'UTF8'))
   or password_ticket_hash=sha256(convert_to(new.raw_user_meta_data->>'signup_invite_ticket','UTF8'))) for update;
 elsif provider='google' then
  select * into invitation from app.signup_invites
  where email=lower(btrim(new.email)) and consumed_at is null and revoked_at is null for update;
 else
  raise exception 'Access is by invite. Request an invitation from Cetld.' using errcode='P0001';
 end if;
 if invitation.id is null or invitation.consumed_at is not null or invitation.revoked_at is not null
 or invitation.expires_at<=clock_timestamp()
 or (provider='email' and not coalesce(invitation.code_hash=sha256(convert_to(lower(btrim(new.raw_user_meta_data->>'signup_invite_code')),'UTF8')),false) and (invitation.password_ticket_expires_at is null or invitation.password_ticket_expires_at<=clock_timestamp()))
 or (provider='google' and (invitation.google_authorized_until is null or invitation.google_authorized_until<=clock_timestamp())) then
  raise exception 'Access is by invite. Request a new invitation from Cetld.' using errcode='P0001';
 end if;
 update app.signup_invites set consumed_at=clock_timestamp(),consumed_by=new.id,google_authorized_until=null,password_ticket_hash=null,password_ticket_expires_at=null where id=invitation.id;
 -- A bearer credential must not be persisted into editable user metadata.
 new.raw_user_meta_data:=coalesce(new.raw_user_meta_data,'{}'::jsonb)-'signup_invite_code'-'signup_invite_ticket';
 return new;
end $$;
revoke all on function app.enforce_signup_invite() from public,anon,authenticated,service_role;

-- Hosted Supabase GoTrue uses supabase_auth_admin for BOTH password signup and
-- first social sign-in. Enforce at INSERT, before any user/profile/workspace
-- exists. Existing sign-ins/refreshes are UPDATE/read paths and are unaffected.
-- Trusted database-owner maintenance/seeding is not an end-user auth path.
drop trigger if exists require_signup_invite on auth.users;
create trigger require_signup_invite before insert on auth.users for each row
when (current_user not in ('postgres','supabase_admin')) execute function app.enforce_signup_invite();

-- Credential metadata is never a user profile field, including later updates.
create or replace function app.strip_user_invite_metadata() returns trigger
language plpgsql set search_path='' as $$begin new.raw_user_meta_data:=coalesce(new.raw_user_meta_data,'{}'::jsonb)-'signup_invite_code'-'signup_invite_ticket';return new;end $$;
revoke all on function app.strip_user_invite_metadata() from public,anon,authenticated,service_role;
create or replace trigger strip_user_invite_metadata before update of raw_user_meta_data on auth.users for each row execute function app.strip_user_invite_metadata();
update auth.users set raw_user_meta_data=raw_user_meta_data-'signup_invite_code'-'signup_invite_ticket' where raw_user_meta_data ?| array['signup_invite_code','signup_invite_ticket'];

-- GoTrue builds identities from its in-memory user model, after the users trigger.
-- Sanitize that independent persistence boundary as well (including later updates).
create or replace function app.strip_identity_invite() returns trigger
language plpgsql set search_path='' as $$begin
 new.identity_data:=coalesce(new.identity_data,'{}'::jsonb)-'signup_invite_code'-'signup_invite_ticket';return new;
end $$;
revoke all on function app.strip_identity_invite() from public,anon,authenticated,service_role;
do $identity$
begin
 if to_regclass('auth.identities') is not null then
  create or replace trigger strip_identity_invite before insert or update of identity_data on auth.identities for each row execute function app.strip_identity_invite();
  update auth.identities set identity_data=identity_data-'signup_invite_code'-'signup_invite_ticket' where identity_data ?| array['signup_invite_code','signup_invite_ticket'];
 end if;
end $identity$;

-- Every API path that inserts a tenant, including direct REST and nested RPCs,
-- consumes one invitation grant. Existing tenant reads/session updates do not.
create or replace function app.require_workspace_invite() returns trigger
language plpgsql security definer set search_path='' as $$
declare invitation uuid;
begin
 if session_user in ('postgres','supabase_admin') and current_setting('role',true) in ('none','postgres','supabase_admin') then return new;end if;
 if auth.uid() is distinct from new.owner_id then raise exception 'Workspace invitation required' using errcode='42501';end if;
 select id into invitation from app.signup_invites where consumed_by=new.owner_id and consumed_at is not null
 and workspace_consumed_at is null and revoked_at is null order by consumed_at,id limit 1 for update;
 if invitation is null then raise exception 'Access is by invite. Redeem an invitation to create a new business.' using errcode='42501';end if;
 update app.signup_invites set workspace_id=new.id,workspace_consumed_at=clock_timestamp() where id=invitation;
 return new;
end $$;
revoke all on function app.require_workspace_invite() from public,anon,authenticated,service_role;
create or replace trigger require_workspace_invite before insert on public.workspaces for each row execute function app.require_workspace_invite();

-- Provision the initial tenant inside the SAME successful Auth transaction.
-- This also supports cached pre-gate clients: after sign-in they find an
-- existing workspace, rather than racing separate bootstrap requests.
create or replace function app.provision_invited_tenant() returns trigger
language plpgsql security definer set search_path='' as $$
declare prior_subject text:=current_setting('request.jwt.claim.sub',true);business text;
begin
 if not exists(select 1 from app.signup_invites where consumed_by=new.id and workspace_consumed_at is null and consumed_at is not null and revoked_at is null) then return new;end if;
 business:=left(coalesce(nullif(btrim(new.raw_user_meta_data->>'business_name'),''),'My business'),100);
 perform set_config('request.jwt.claim.sub',new.id::text,true);
 perform public.create_workspace(business,null);
 perform set_config('request.jwt.claim.sub',coalesce(prior_subject,''),true);
 return new;
end $$;
revoke all on function app.provision_invited_tenant() from public,anon,authenticated,service_role;
create or replace trigger z_provision_invited_tenant after insert on auth.users for each row
 when(current_user not in ('postgres','supabase_admin')) execute function app.provision_invited_tenant();

create or replace function public.redeem_workspace_invite(p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare address text;invitation uuid;caller uuid:=auth.uid();
begin
 if caller is null then raise exception 'Authentication required' using errcode='42501';end if;
 select lower(btrim(email)) into address from auth.users where id=caller;
 select id into invitation from app.signup_invites where email=address
 and code_hash=sha256(convert_to(lower(btrim(p_code)),'UTF8')) and consumed_at is null and revoked_at is null for update;
 if invitation is null or not exists(select 1 from app.signup_invites where id=invitation and expires_at>clock_timestamp()) then
 raise exception 'Access is by invite. Request a new invitation from Cetld.' using errcode='P0001';end if;
 update app.signup_invites set consumed_at=clock_timestamp(),consumed_by=caller,google_authorized_until=null,password_ticket_hash=null,password_ticket_expires_at=null where id=invitation;
 if not exists(select 1 from public.workspaces where owner_id=caller) then perform public.create_workspace('My business',null);end if;
 return '{"ok":true}'::jsonb;
end $$;
revoke all on function public.redeem_workspace_invite(text) from public,anon;
grant execute on function public.redeem_workspace_invite(text) to authenticated;
create or replace function public.signup_invite_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare index_ready boolean:=false;
begin
 if to_regclass('app.private_dispatch_index_state') is not null and to_regprocedure('app.private_dispatch_index_revision()') is not null then
  select exists(select 1 from app.private_dispatch_index_state s where s.singleton and s.revision=app.private_dispatch_index_revision()) into index_ready;
 end if;
 return jsonb_build_object('version',2,'privacyRepairRevision',3,
 'accountInvites',exists(select 1 from pg_catalog.pg_trigger where tgrelid='auth.users'::regclass and tgname='require_signup_invite' and tgenabled<>'D'),
 'tenantInvites',exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.workspaces'::regclass and tgname='require_workspace_invite' and tgenabled<>'D'),
 'identityCredentialScrub',exists(select 1 from pg_catalog.pg_trigger where tgrelid=to_regclass('auth.identities') and tgname='strip_identity_invite' and tgenabled<>'D'),
 'globalPrivacyIndex',index_ready,'dispatchProtocol',to_regprocedure('public.whatsapp_claim_reserved_reply(uuid,text,text,text,text,text,text,boolean,uuid)') is not null and to_regprocedure('public.whatsapp_release_reply_dispatch(uuid,text,text,text,text,uuid)') is not null);
end $$;
revoke all on function public.signup_invite_status() from public;
grant execute on function public.signup_invite_status() to anon,authenticated,service_role;
commit;
