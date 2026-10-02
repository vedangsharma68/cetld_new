-- Pre-release ad hoc owner verification schema/function snapshot (2026-10-02).
-- Read-only inspection; no production account data, credentials, or verification codes.
create table public.whatsapp_owner_verifications (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 phone text not null,
 requested_by uuid not null references auth.users(id) on delete cascade,
 code_hash text not null,
 attempts integer not null default 0,
 expires_at timestamptz not null,
 verified_at timestamptz,
 created_at timestamptz not null default now()
);
CREATE OR REPLACE FUNCTION public.owner_bind_whatsapp_core(p_workspace_id uuid, p_phone text, p_uid uuid)
 RETURNS TABLE(customer_id uuid, phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_uid uuid := p_uid;
  v_customer uuid;
  v_old text;
begin
  if v_uid is null or not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = v_uid) then
    raise exception 'Only the workspace owner can link a WhatsApp number' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter the number with country code, like +919876543210' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));
  if not exists (select 1 from public.workspace_settings s where s.workspace_id = p_workspace_id and s.whatsapp_owner_attested_at is not null) then
    raise exception 'Confirm the WhatsApp client agreement first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_settings s where s.workspace_id = p_workspace_id and nullif(btrim(s.business_name), '') is not null) then
    raise exception 'Set your business name in Settings first. It is shown in every reminder.' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_global_suppressions g where g.phone = p_phone)
     or exists (select 1 from public.whatsapp_suppressions s where s.workspace_id = p_workspace_id and s.phone = p_phone) then
    raise exception 'This number sent STOP and cannot be linked' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_consents c where c.phone = p_phone and c.workspace_id <> p_workspace_id and c.revoked_at is null) then
    raise exception 'This number is already linked to another cetld account. Unlink it there first.' using errcode = '23505';
  end if;

  select c.id, c.phone into v_customer, v_old from public.customers c
   where c.workspace_id = p_workspace_id and c.metadata->>'whatsapp_owner' = 'true' limit 1;
  if v_customer is null then
    select c.id, c.phone into v_customer, v_old from public.customers c
     where c.workspace_id = p_workspace_id and c.phone = p_phone limit 1;
  end if;
  if v_customer is null then
    insert into public.customers (workspace_id, name, phone, metadata)
    values (p_workspace_id, 'Owner (WhatsApp)', p_phone, '{"whatsapp_owner": true}'::jsonb)
    returning id into v_customer;
  else
    if v_old is distinct from p_phone and v_old is not null then
      update public.whatsapp_consents wc set revoked_at = now(), revoked_via = 'manual'
       where wc.workspace_id = p_workspace_id and wc.phone = v_old and wc.revoked_at is null;
    end if;
    update public.customers c set phone = p_phone, metadata = c.metadata || '{"whatsapp_owner": true}'::jsonb
     where c.id = v_customer and c.workspace_id = p_workspace_id;
  end if;

  insert into public.whatsapp_consents (workspace_id, phone, customer_id, categories, consent_text_version, source, consented_by)
  values (p_workspace_id, p_phone, v_customer, array['invoice_updates'], 'owner_binding_v1', 'verbal', v_uid)
  on conflict (workspace_id, phone) do update
    set customer_id = excluded.customer_id, consent_text_version = excluded.consent_text_version,
        consented_at = now(), consented_by = v_uid, source = 'verbal', revoked_at = null, revoked_via = null
    where public.whatsapp_consents.revoked_at is null or public.whatsapp_consents.revoked_via = 'manual';
  if not exists (select 1 from public.whatsapp_consents wc where wc.workspace_id = p_workspace_id and wc.phone = p_phone and wc.revoked_at is null) then
    raise exception 'This number opted out and cannot be linked' using errcode = '23514';
  end if;
  return query select v_customer, p_phone;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.owner_start_whatsapp_verification(p_workspace_id uuid, p_phone text)
 RETURNS TABLE(code text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare v_id uuid := gen_random_uuid(); v_code text; v_exp timestamptz := now() + interval '10 minutes';
begin
  if auth.uid() is null or not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'Only the workspace owner can link a WhatsApp number' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter the number with country code, like +919876543210' using errcode = '23514';
  end if;
  if not exists (select 1 from public.workspace_settings s where s.workspace_id = p_workspace_id and s.whatsapp_owner_attested_at is not null) then
    raise exception 'Confirm the WhatsApp client agreement first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_settings s where s.workspace_id = p_workspace_id and nullif(btrim(s.business_name), '') is not null) then
    raise exception 'Set your business name in Settings first. It is shown in every reminder.' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_global_suppressions g where g.phone = p_phone)
     or exists (select 1 from public.whatsapp_suppressions s where s.workspace_id = p_workspace_id and s.phone = p_phone) then
    raise exception 'This number sent STOP and cannot be linked' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_consents c where c.phone = p_phone and c.workspace_id <> p_workspace_id and c.revoked_at is null) then
    raise exception 'This number is already linked to another cetld account. Unlink it there first.' using errcode = '23505';
  end if;
  if (select count(*) from public.whatsapp_owner_verifications v where v.workspace_id = p_workspace_id and v.created_at > now() - interval '1 hour') >= 8 then
    raise exception 'Too many attempts. Try again in an hour.' using errcode = '23514';
  end if;
  -- one active code per workspace
  update public.whatsapp_owner_verifications v set expires_at = now()
   where v.workspace_id = p_workspace_id and v.verified_at is null and v.expires_at > now();
  v_code := lpad((('x' || substr(gen_random_uuid()::text, 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into public.whatsapp_owner_verifications (id, workspace_id, phone, requested_by, code_hash, expires_at)
  values (v_id, p_workspace_id, p_phone, auth.uid(), encode(sha256(convert_to(v_id::text || ':' || v_code, 'UTF8')), 'hex'), v_exp);
  return query select v_code, v_exp;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.owner_unbind_whatsapp(p_workspace_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_phone text;
begin
  if auth.uid() is null or not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'Only the workspace owner can unlink a WhatsApp number' using errcode = '42501';
  end if;
  select c.phone into v_phone from public.customers c
   where c.workspace_id = p_workspace_id and c.metadata->>'whatsapp_owner' = 'true' limit 1;
  if v_phone is null then return false; end if;
  update public.whatsapp_consents wc set revoked_at = now(), revoked_via = 'manual'
   where wc.workspace_id = p_workspace_id and wc.phone = v_phone and wc.revoked_at is null;
  return true;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.owner_whatsapp_verification_status(p_workspace_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v public.whatsapp_owner_verifications;
begin
  if auth.uid() is null or not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'Only the workspace owner can link a WhatsApp number' using errcode = '42501';
  end if;
  select * into v from public.whatsapp_owner_verifications x where x.workspace_id = p_workspace_id order by x.created_at desc limit 1;
  if v.id is null then return 'none'; end if;
  if v.verified_at is not null then return 'linked'; end if;
  if v.expires_at <= now() then return 'expired'; end if;
  return 'pending';
end;
$function$
;
CREATE OR REPLACE FUNCTION public.whatsapp_verify_owner_code(p_phone text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v public.whatsapp_owner_verifications;
begin
  select * into v from public.whatsapp_owner_verifications x
   where x.phone = p_phone and x.verified_at is null and x.expires_at > now()
   order by x.created_at desc limit 1 for update;
  if v.id is null then return jsonb_build_object('ok', false, 'reason', 'no_active_code'); end if;
  if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  if v.code_hash is distinct from encode(sha256(convert_to(v.id::text || ':' || coalesce(p_code, ''), 'UTF8')), 'hex') then
    update public.whatsapp_owner_verifications x set attempts = x.attempts + 1 where x.id = v.id;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code');
  end if;
  begin
    perform public.owner_bind_whatsapp_core(v.workspace_id, v.phone, v.requested_by);
  exception when others then
    update public.whatsapp_owner_verifications x set expires_at = now() where x.id = v.id;
    return jsonb_build_object('ok', false, 'reason', 'bind_refused', 'detail', sqlerrm);
  end;
  update public.whatsapp_owner_verifications x set verified_at = now(), expires_at = now() where x.id = v.id;
  return jsonb_build_object('ok', true, 'workspace_id', v.workspace_id);
end;
$function$
;
