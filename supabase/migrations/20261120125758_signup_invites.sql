begin;
set local lock_timeout='1s';
set local statement_timeout='5s';

create table app.signup_invites (
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
create unique index signup_invites_active_email on app.signup_invites(email) where consumed_at is null and revoked_at is null;
alter table app.signup_invites enable row level security;
revoke all on app.signup_invites from public,anon,authenticated,service_role;

-- Only the operator's service-role credential can issue or replace a code.
create function public.issue_signup_invite(p_email text,p_expires_at timestamptz default now()+interval '1 day') returns jsonb
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
 return jsonb_build_object('id',invite_id,'email',address,'code',code,'expiresAt',p_expires_at);
end $$;
revoke all on function public.issue_signup_invite(text,timestamptz) from public,anon,authenticated;
grant execute on function public.issue_signup_invite(text,timestamptz) to service_role;

-- Google cannot carry custom signup metadata. A valid code authorizes only
-- this exact email for ten minutes; GoTrue must then prove that Google identity.
-- Preparation does not consume the code, and never creates an account.
create function public.prepare_signup_invite(p_email text,p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 update app.signup_invites set google_authorized_until=least(expires_at,clock_timestamp()+interval '10 minutes')
 where email=lower(btrim(p_email)) and code_hash=sha256(convert_to(lower(btrim(p_code)),'UTF8'))
 and consumed_at is null and revoked_at is null and expires_at>clock_timestamp();
 if not found then raise exception 'Access is by invite. Request a new invitation from Cetld.' using errcode='P0001';end if;
 return '{"ok":true}'::jsonb;
end $$;
revoke all on function public.prepare_signup_invite(text,text) from public;
grant execute on function public.prepare_signup_invite(text,text) to anon,authenticated;

create function app.enforce_signup_invite() returns trigger
language plpgsql security definer set search_path='' as $$
declare invitation app.signup_invites%rowtype;provider text:=new.raw_app_meta_data->>'provider';
begin
 if provider='email' then
  select * into invitation from app.signup_invites
  where email=lower(btrim(new.email)) and code_hash=sha256(convert_to(lower(btrim(new.raw_user_meta_data->>'signup_invite_code')),'UTF8')) for update;
 elsif provider='google' then
  select * into invitation from app.signup_invites
  where email=lower(btrim(new.email)) and consumed_at is null and revoked_at is null for update;
 else
  raise exception 'Access is by invite. Request an invitation from Cetld.' using errcode='P0001';
 end if;
 if invitation.id is null or invitation.consumed_at is not null or invitation.revoked_at is not null
 or invitation.expires_at<=clock_timestamp()
 or (provider='google' and (invitation.google_authorized_until is null or invitation.google_authorized_until<=clock_timestamp())) then
  raise exception 'Access is by invite. Request a new invitation from Cetld.' using errcode='P0001';
 end if;
 update app.signup_invites set consumed_at=clock_timestamp(),consumed_by=new.id,google_authorized_until=null where id=invitation.id;
 -- A bearer credential must not be persisted into editable user metadata.
 new.raw_user_meta_data:=coalesce(new.raw_user_meta_data,'{}'::jsonb)-'signup_invite_code';
 return new;
end $$;
revoke all on function app.enforce_signup_invite() from public,anon,authenticated,service_role;

-- Hosted Supabase GoTrue uses supabase_auth_admin for BOTH password signup and
-- first social sign-in. Enforce at INSERT, before any user/profile/workspace
-- exists. Existing sign-ins/refreshes are UPDATE/read paths and are unaffected.
-- Trusted database-owner maintenance/seeding is not an end-user auth path.
create trigger require_signup_invite before insert on auth.users for each row
when (current_user not in ('postgres','supabase_admin')) execute function app.enforce_signup_invite();
commit;
