-- FORWARD REVIEW PROPOSAL. Requires separate approval before production use.
-- Existing invoices, duplicates, payments, files and numbering remain unchanged.
begin;

create function app.guard_invoice_source_duplicate() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  source_number text;
  save_key text := nullif(new.metadata->>'assistant_idempotency_key','');
begin
  if tg_op='UPDATE' and (old.deleted_at is null or new.deleted_at is not null) then return new;end if;
  -- Only explicit source metadata activates this guard. Ordinary owner creates
  -- without source metadata and AUTO/missing-number invoices remain supported.
  source_number := coalesce(
    case when pg_catalog.jsonb_typeof(new.metadata->'printed_invoice_number')='string'
      then nullif(pg_catalog.btrim(new.metadata->>'printed_invoice_number'),'') end,
    case when pg_catalog.jsonb_typeof(new.metadata->'source_invoice_number')='string'
      then nullif(pg_catalog.btrim(new.metadata->>'source_invoice_number'),'') end);
  if source_number is null or source_number='AUTO' then return new;end if;

  -- Share the numbering trigger's workspace lock and acquire it before lookup.
  -- A common lock order prevents deadlocks between multi-row invoice inserts.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.workspace_id::text,92741));
  if exists(select 1 from public.invoices i
    where i.workspace_id=new.workspace_id and i.customer_id=new.customer_id
      and i.id is distinct from new.id
      and i.deleted_at is null
      and (i.metadata->>'printed_invoice_number'=source_number
        or i.metadata->>'source_invoice_number'=source_number
        or (i.metadata->>'printed_invoice_number' is null and i.metadata->>'source_invoice_number' is null
          and i.invoice_number=source_number))
      and (tg_op='UPDATE' or save_key is null or i.metadata->>'assistant_idempotency_key' is distinct from save_key)) then
    raise exception 'source invoice already exists for customer'
      using errcode='23505',constraint='invoices_source_invoice_customer_unique';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_invoice_source_duplicate() from public,anon,authenticated,service_role;

-- PostgreSQL orders BEFORE triggers by name: validate raw metadata first, then
-- guard its source identity before the numbering trigger rewrites the number.
create trigger a1_invoices_source_duplicate_guard before insert or update of deleted_at on public.invoices
for each row execute function app.guard_invoice_source_duplicate();

commit;
