-- At-most-once claims for neutral invoice-update tests. No reminder sender
-- invokes this table while policy review and the outbound flag remain pending.
create table public.whatsapp_invoice_update_claims (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid not null,
  customer_id uuid not null,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  idempotency_key text not null check (length(idempotency_key) between 12 and 120),
  invoice_updated_at timestamptz not null,
  claimed_at timestamptz not null default now(),
  primary key (workspace_id, invoice_id, idempotency_key),
  foreign key (workspace_id, invoice_id) references public.invoices(workspace_id, id) on delete cascade,
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id) on delete cascade
);

alter table public.whatsapp_invoice_update_claims enable row level security;
alter table public.whatsapp_invoice_update_claims force row level security;
revoke all on public.whatsapp_invoice_update_claims from anon, authenticated;
grant select, insert on public.whatsapp_invoice_update_claims to service_role;

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
revoke all on function public.whatsapp_claim_invoice_update(uuid,uuid,uuid,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.whatsapp_claim_invoice_update(uuid,uuid,uuid,text,text,timestamptz)
  to service_role;
