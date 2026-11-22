begin;
set local lock_timeout='1s';
set local statement_timeout='5s';
-- Forward admission-only revision. No capture, index, backfill or data changes.
-- BEGIN GENERATED ADMISSION REVISION
create or replace function app.private_invoice_admission_revision() returns text
language sql immutable set search_path='' as $$select '259ef42280b50c1a277f4525d2296c2fb0d9803bd04b67dbfe700cb542bcbb73'::text$$;
revoke all on function app.private_invoice_admission_revision() from public,anon,authenticated,service_role;
-- END GENERATED ADMISSION REVISION
commit;
