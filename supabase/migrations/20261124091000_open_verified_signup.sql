begin;
set local lock_timeout='1s';
set local statement_timeout='5s';
-- Remove access gates only. Keep invitation records and credential scrubbers intact.
drop trigger if exists require_signup_invite on auth.users;
drop trigger if exists z_provision_invited_tenant on auth.users;
create or replace function app.require_workspace_invite() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if session_user in ('postgres','supabase_admin') and current_setting('role',true) in ('none','postgres','supabase_admin') then return new;end if;
 if auth.uid() is distinct from new.owner_id then raise exception 'Business owner must match signed-in user' using errcode='42501';end if;
 if not exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null) then raise exception 'Confirm your email before creating a business' using errcode='42501';end if;
 -- Serialize self-serve creation to cap each account without changing existing business access.
 perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,12));
 if (select count(*) from public.workspaces where owner_id=new.owner_id and created_at>clock_timestamp()-interval '1 day')>=10 then raise exception 'Too many new businesses. Try again later.' using errcode='54000';end if;
 return new;
end $$;
revoke all on function app.require_workspace_invite() from public,anon,authenticated,service_role;
-- Name kept for compatibility. Capability now declares open signup deliberately.
create or replace function public.signup_invite_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare index_ready boolean:=false;
begin
 if to_regclass('app.private_dispatch_index_state') is not null and to_regprocedure('app.private_dispatch_index_revision()') is not null then
 select exists(select 1 from app.private_dispatch_index_state s where s.singleton and s.revision=app.private_dispatch_index_revision()) into index_ready;
 end if;
 return jsonb_build_object('version',2,'privacyRepairRevision',3,'openSignup',true,'verifiedBusinessCreation',exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.workspaces'::regclass and tgname='require_workspace_invite' and tgenabled<>'D'),
 'accountInvites',false,'tenantInvites',false,
 'identityCredentialScrub',exists(select 1 from pg_catalog.pg_trigger where tgrelid=to_regclass('auth.identities') and tgname='strip_identity_invite' and tgenabled<>'D'),
 'globalPrivacyIndex',index_ready,'dispatchProtocol',to_regprocedure('public.whatsapp_claim_reserved_reply(uuid,text,text,text,text,text,text,boolean,uuid)') is not null and to_regprocedure('public.whatsapp_release_reply_dispatch(uuid,text,text,text,text,uuid)') is not null);
end $$;
revoke all on function public.signup_invite_status() from public;
grant execute on function public.signup_invite_status() to anon,authenticated,service_role;
commit;
