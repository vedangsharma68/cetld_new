-- WhatsApp consent is scoped to a workspace and a specific customer phone.
-- Owner attestation permits storing a phone; it is not recipient opt-in.
alter table public.workspace_settings
  add column whatsapp_owner_attested_at timestamptz,
  add column whatsapp_owner_attested_by uuid references auth.users(id) on delete restrict;

create or replace function app.guard_whatsapp_owner_attestation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  v_owner_id uuid;
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.whatsapp_owner_attested_at is not null or new.whatsapp_owner_attested_by is not null;
  else
    v_changed := new.whatsapp_owner_attested_at is distinct from old.whatsapp_owner_attested_at
                 or new.whatsapp_owner_attested_by is distinct from old.whatsapp_owner_attested_by;
  end if;
  if v_changed then
    if tg_op = 'UPDATE' and old.whatsapp_owner_attested_at is not null then
      raise exception 'WhatsApp owner attestation cannot be changed' using errcode = '42501';
    end if;
    select owner_id into v_owner_id from public.workspaces where id = new.workspace_id;
    if v_owner_id is distinct from auth.uid() or new.whatsapp_owner_attested_at is null then
      raise exception 'Only the workspace owner may attest to WhatsApp client agreement' using errcode = '42501';
    end if;
    new.whatsapp_owner_attested_at := now();
    new.whatsapp_owner_attested_by := v_owner_id;
  end if;
  return new;
end;
$$;

create trigger workspace_settings_whatsapp_attestation_guard
before insert or update on public.workspace_settings for each row
execute function app.guard_whatsapp_owner_attestation();

create or replace function app.prevent_whatsapp_attestation_delete()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  -- The parent workspace is already invisible during a cascade delete.
  if old.whatsapp_owner_attested_at is not null
     and exists (select 1 from public.workspaces where id = old.workspace_id) then
    raise exception 'WhatsApp owner attestation cannot be deleted' using errcode = '42501';
  end if;
  return old;
end;
$$;
create trigger workspace_settings_whatsapp_attestation_delete_guard
before delete on public.workspace_settings for each row
execute function app.prevent_whatsapp_attestation_delete();

create or replace function app.require_whatsapp_phone_attestation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' and new.phone is not distinct from old.phone then
    return new;
  end if;
  if nullif(btrim(new.phone), '') is not null
     and not exists (
       select 1 from public.workspace_settings s
       where s.workspace_id = new.workspace_id and s.whatsapp_owner_attested_at is not null
     ) then
    raise exception 'Workspace owner must attest before a client phone can be saved' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger customers_whatsapp_phone_attestation_guard
before insert or update of phone on public.customers for each row
execute function app.require_whatsapp_phone_attestation();

create table public.whatsapp_consents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  customer_id uuid not null,
  categories text[] not null default array['invoice_updates']::text[]
    check (cardinality(categories) > 0 and categories <@ array['invoice_updates', 'customer_service']::text[]),
  consent_text_version text not null check (length(btrim(consent_text_version)) between 1 and 80),
  source text not null check (source in ('owner_attestation', 'invoice_line', 'inbound_message', 'verbal')),
  consented_at timestamptz not null default now(),
  consented_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_via text check (revoked_via in ('stop', 'refusal', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, phone),
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id) on delete cascade,
  check ((revoked_at is null) = (revoked_via is null))
);

create index whatsapp_consents_customer_idx on public.whatsapp_consents(workspace_id, customer_id);
create trigger whatsapp_consents_updated_at before update on public.whatsapp_consents
for each row execute function app.set_updated_at();
create trigger whatsapp_consents_workspace_immutable before update on public.whatsapp_consents
for each row execute function app.prevent_workspace_change();

create table public.whatsapp_suppressions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  suppressed_at timestamptz not null default now(),
  reason text not null check (reason in ('stop', 'refusal', 'manual')),
  source_message_id text,
  primary key (workspace_id, phone)
);

-- A STOP from a number with no known workspace binding must still take effect
-- before that number can be added to a workspace later.
create table public.whatsapp_global_suppressions (
  phone text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  suppressed_at timestamptz not null default now(),
  source_message_id text
);

alter table public.whatsapp_consents enable row level security;
alter table public.whatsapp_consents force row level security;
alter table public.whatsapp_suppressions enable row level security;
alter table public.whatsapp_suppressions force row level security;
alter table public.whatsapp_global_suppressions enable row level security;
alter table public.whatsapp_global_suppressions force row level security;
grant select on public.whatsapp_consents, public.whatsapp_suppressions to authenticated;
grant select, insert, update on public.whatsapp_consents, public.whatsapp_suppressions to service_role;
grant select, insert on public.whatsapp_global_suppressions to service_role;
grant select on public.customers to service_role;
create policy whatsapp_consents_select on public.whatsapp_consents for select to authenticated
using (app.is_workspace_member(workspace_id));
create policy whatsapp_suppressions_select on public.whatsapp_suppressions for select to authenticated
using (app.is_workspace_member(workspace_id));

-- A member may record evidence of a customer's verbal agreement, but cannot
-- clear a STOP or fabricate consent for a phone that is not on that customer.
create or replace function public.whatsapp_record_verbal_consent(
  p_workspace_id uuid, p_customer_id uuid, p_phone text,
  p_consent_text_version text default 'invoice_updates_v1'
)
returns public.whatsapp_consents
language plpgsql security definer set search_path = '' as $$
declare
  v_result public.whatsapp_consents;
begin
  if not app.is_workspace_member(p_workspace_id, auth.uid()) then
    raise exception 'Not a workspace member' using errcode = '42501';
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
revoke all on function public.whatsapp_record_verbal_consent(uuid, uuid, text, text) from public, anon;
grant execute on function public.whatsapp_record_verbal_consent(uuid, uuid, text, text) to authenticated;

-- STOP and refusals are one transaction. The inserted suppression row is also
-- the one-time claim for a confirmation; repeats cannot produce another send.
create or replace function public.whatsapp_revoke_phone(
  p_workspace_id uuid, p_phone text, p_via text, p_message_id text default null
)
returns table(revoked boolean, confirmation_due boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_claimed integer := 0;
  v_revoked integer := 0;
begin
  if p_via not in ('stop', 'refusal', 'manual') then
    raise exception 'Invalid revocation reason' using errcode = '23514';
  end if;
  insert into public.whatsapp_suppressions(workspace_id, phone, reason, source_message_id)
  select p_workspace_id, p_phone, p_via, p_message_id
  where exists (select 1 from public.whatsapp_consents c
                where c.workspace_id = p_workspace_id and c.phone = p_phone)
  on conflict (workspace_id, phone) do nothing;
  get diagnostics v_claimed = row_count;
  update public.whatsapp_consents c
     set revoked_at = now(), revoked_via = p_via
   where c.workspace_id = p_workspace_id and c.phone = p_phone and c.revoked_at is null;
  get diagnostics v_revoked = row_count;
  return query select v_revoked > 0, v_claimed > 0;
end;
$$;
revoke all on function public.whatsapp_revoke_phone(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_revoke_phone(uuid, text, text, text) to service_role;

create or replace function public.whatsapp_suppress_unknown_phone(
  p_phone text, p_message_id text default null
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_claimed integer := 0;
begin
  insert into public.whatsapp_global_suppressions(phone, source_message_id)
  select p_phone, p_message_id
  where not exists (select 1 from public.whatsapp_consents c where c.phone = p_phone)
  on conflict (phone) do nothing;
  get diagnostics v_claimed = row_count;
  return v_claimed > 0;
end;
$$;
revoke all on function public.whatsapp_suppress_unknown_phone(text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_suppress_unknown_phone(text, text) to service_role;
