-- Preserve owner-authored numbers without changing numbering for imported
-- customer source documents or touching payment RPC capability fingerprints.
begin;
do $migration$
declare
  target regprocedure := 'public.assign_consistent_invoice_number()'::regprocedure;
  definition text;
  marker text := '  with recent as (';
begin
  definition := pg_get_functiondef(target);
  if position('source_owner_invoice_number' in definition)>0 then return; end if;
  if position(marker in definition)=0 then raise exception 'invoice numbering implementation changed'; end if;
  definition := replace(definition,marker,$patch$
  -- These idempotency namespaces are set by the verified owner create paths.
  -- Raw authenticated metadata cannot opt into this service-only exception.
  -- Preserve the retry lookup and business allocation lock above this branch.
  if auth.role()='service_role' and source_number is not null and source_number<>'AUTO'
    and (new.metadata->>'source_owner_invoice_number'=source_number
      or new.metadata->>'printed_invoice_number'=source_number and (new.metadata->>'assistant_idempotency_key' like 'ownerwrite\_%' escape '\'
      or new.metadata->>'assistant_idempotency_key' like 'wa\_owner\_create\_%' escape '\')) then
    new.invoice_number := source_number;
    new.metadata := coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('source_invoice_number',source_number);
    return new;
  end if;

  with recent as ($patch$);
  execute definition;
end;
$migration$;
commit;
