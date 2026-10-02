-- Paste-ready verification: select public.whatsapp_record_verbal_consent_service('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','+919876543210','invoice_updates_v1');
-- Service-role counterpart for a consent answer received through the verified owner chat.
create or replace function public.whatsapp_record_verbal_consent_service(
  p_workspace_id uuid, p_customer_id uuid, p_phone text,
  p_consent_text_version text default 'invoice_updates_v1'
)
returns public.whatsapp_consents
language plpgsql security definer set search_path = '' as $$
declare
  v_result public.whatsapp_consents;
begin
  if p_phone !~ '^\+[1-9][0-9]{7,14}$' or p_consent_text_version <> 'invoice_updates_v1' then
    raise exception 'Invalid consent evidence' using errcode = '23514';
  end if;
  if not exists (select 1 from public.workspace_settings s
                 where s.workspace_id = p_workspace_id and s.whatsapp_owner_attested_at is not null) then
    raise exception 'Owner attestation is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers c
                 where c.workspace_id = p_workspace_id and c.id = p_customer_id and c.phone = p_phone) then
    raise exception 'Customer phone does not match' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_suppressions s
             where s.workspace_id = p_workspace_id and s.phone = p_phone)
     or exists (select 1 from public.whatsapp_global_suppressions s where s.phone = p_phone) then
    raise exception 'Phone is suppressed' using errcode = '23514';
  end if;
  insert into public.whatsapp_consents
    (workspace_id, phone, customer_id, categories, consent_text_version, source, consented_by)
  values (p_workspace_id, p_phone, p_customer_id, array['invoice_updates'],
          p_consent_text_version, 'verbal', null)
  on conflict (workspace_id, phone) do update
    set customer_id = excluded.customer_id,
        categories = excluded.categories,
        consent_text_version = excluded.consent_text_version,
        consented_at = now(), consented_by = null, source = 'verbal'
    where public.whatsapp_consents.revoked_at is null
  returning * into v_result;
  if v_result.id is null then
    raise exception 'Revoked consent cannot be restored' using errcode = '23514';
  end if;
  return v_result;
end;
$$;
revoke all on function public.whatsapp_record_verbal_consent_service(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_record_verbal_consent_service(uuid, uuid, text, text) to service_role;
