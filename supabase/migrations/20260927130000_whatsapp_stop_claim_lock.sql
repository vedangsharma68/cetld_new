-- Serialize consent, invoice claims, and STOP for the same phone. A STOP also
-- installs a global marker before inbound processing discovers workspaces.
alter table public.whatsapp_global_suppressions
  add column confirmation_due boolean not null default false;

create or replace function app.guard_whatsapp_active_consent()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.revoked_at is not null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.phone, 0));
  if exists (select 1 from public.whatsapp_global_suppressions g where g.phone = new.phone) then
    raise exception 'Phone is globally suppressed' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_suppressions s
             where s.workspace_id = new.workspace_id and s.phone = new.phone) then
    raise exception 'Phone is suppressed' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger whatsapp_consents_suppression_guard
before insert or update on public.whatsapp_consents for each row
execute function app.guard_whatsapp_active_consent();

create or replace function public.whatsapp_record_verbal_consent(
  p_workspace_id uuid, p_customer_id uuid, p_phone text,
  p_consent_text_version text default 'invoice_updates_v1'
)
returns public.whatsapp_consents
language plpgsql security definer set search_path = '' as $$
declare v_result public.whatsapp_consents;
begin
  if not app.is_workspace_member(p_workspace_id, auth.uid()) then
    raise exception 'Not a workspace member' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));
  if not exists (select 1 from public.workspace_settings s
                 where s.workspace_id = p_workspace_id and s.whatsapp_owner_attested_at is not null) then
    raise exception 'Owner attestation is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers c
                 where c.workspace_id = p_workspace_id and c.id = p_customer_id and c.phone = p_phone) then
    raise exception 'Customer phone does not match' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_suppressions s
             where s.workspace_id = p_workspace_id and s.phone = p_phone) then
    raise exception 'Phone is suppressed' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_global_suppressions s where s.phone = p_phone) then
    raise exception 'Phone is globally suppressed' using errcode = '23514';
  end if;
  insert into public.whatsapp_consents
    (workspace_id, phone, customer_id, categories, consent_text_version, source, consented_by)
  values (p_workspace_id, p_phone, p_customer_id, array['invoice_updates'], p_consent_text_version, 'verbal', auth.uid())
  on conflict (workspace_id, phone) do update
    set customer_id = excluded.customer_id,
        consent_text_version = excluded.consent_text_version,
        consented_at = now(), consented_by = auth.uid(), source = 'verbal'
    where public.whatsapp_consents.revoked_at is null
  returning * into v_result;
  if v_result.id is null then
    raise exception 'Revoked consent cannot be restored by owner attestation' using errcode = '23514';
  end if;
  return v_result;
end;
$$;

create or replace function public.whatsapp_revoke_phone(
  p_workspace_id uuid, p_phone text, p_via text, p_message_id text default null
)
returns table(revoked boolean, confirmation_due boolean)
language plpgsql security definer set search_path = '' as $$
declare v_claimed integer := 0; v_revoked integer := 0; v_replay boolean := false;
begin
  if p_via not in ('stop', 'refusal', 'manual') then
    raise exception 'Invalid revocation reason' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));
  insert into public.whatsapp_suppressions(workspace_id, phone, reason, source_message_id)
  select p_workspace_id, p_phone, p_via, p_message_id
  where exists (select 1 from public.whatsapp_consents c
                where c.workspace_id = p_workspace_id and c.phone = p_phone)
  on conflict (workspace_id, phone) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 and p_message_id is not null then
    select exists (select 1 from public.whatsapp_suppressions s
                   where s.workspace_id = p_workspace_id and s.phone = p_phone
                     and s.source_message_id = p_message_id) into v_replay;
  end if;
  update public.whatsapp_consents c
     set revoked_at = now(), revoked_via = p_via
   where c.workspace_id = p_workspace_id and c.phone = p_phone and c.revoked_at is null;
  get diagnostics v_revoked = row_count;
  return query select v_revoked > 0, v_claimed > 0 or v_replay;
end;
$$;

create or replace function public.whatsapp_suppress_unknown_phone(
  p_phone text, p_message_id text default null
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_due boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));
  insert into public.whatsapp_global_suppressions(phone, source_message_id, confirmation_due)
  select p_phone, p_message_id,
    not exists (select 1 from public.whatsapp_consents c where c.phone = p_phone)
  on conflict (phone) do nothing
  returning confirmation_due into v_due;
  if v_due is null and p_message_id is not null then
    select g.confirmation_due into v_due from public.whatsapp_global_suppressions g
    where g.phone = p_phone and g.source_message_id = p_message_id;
  end if;
  return coalesce(v_due, false);
end;
$$;

create or replace function public.whatsapp_claim_invoice_update(
  p_workspace_id uuid, p_invoice_id uuid, p_customer_id uuid, p_phone text,
  p_idempotency_key text, p_expected_updated_at timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_claimed integer := 0;
begin
  if p_idempotency_key !~ '^[A-Za-z0-9_-]{12,120}$' then
    raise exception 'Invalid WhatsApp idempotency key' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));
  insert into public.whatsapp_invoice_update_claims
    (workspace_id, invoice_id, customer_id, phone, idempotency_key, invoice_updated_at)
  select i.workspace_id, i.id, c.id, p_phone, p_idempotency_key, i.updated_at
  from public.invoices i
  join public.customers c on c.workspace_id = i.workspace_id and c.id = i.customer_id
  join public.workspace_settings s on s.workspace_id = i.workspace_id
  join public.whatsapp_consents wc on wc.workspace_id = i.workspace_id and wc.customer_id = c.id and wc.phone = p_phone
  where i.workspace_id = p_workspace_id and i.id = p_invoice_id
    and c.id = p_customer_id and c.phone = p_phone
    and i.updated_at = p_expected_updated_at and i.status::text in ('sent', 'paid')
    and s.whatsapp_owner_attested_at is not null
    and wc.revoked_at is null and wc.source in ('verbal', 'inbound_message')
    and 'invoice_updates' = any(wc.categories)
    and not exists (select 1 from public.whatsapp_suppressions ws
                    where ws.workspace_id = i.workspace_id and ws.phone = p_phone)
    and not exists (select 1 from public.whatsapp_global_suppressions gs where gs.phone = p_phone)
  on conflict (workspace_id, invoice_id, idempotency_key) do nothing;
  get diagnostics v_claimed = row_count;
  return v_claimed > 0;
end;
$$;
