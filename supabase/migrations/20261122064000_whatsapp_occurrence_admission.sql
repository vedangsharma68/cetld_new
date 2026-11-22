set local lock_timeout='1s';
set local statement_timeout='5s';
-- Admission-only forward revision. Capture functions, stored source terms,
-- existing deliveries and terminal quarantine are deliberately unchanged.
-- BEGIN GENERATED ADMISSION REVISION
create or replace function app.private_invoice_admission_revision() returns text
language sql immutable set search_path='' as $$select 'a34506f4d5961666b5b95e947aefcfdaebea187ee83d0a0f442757fa62627692'::text$$;
revoke all on function app.private_invoice_admission_revision() from public,anon,authenticated,service_role;
-- END GENERATED ADMISSION REVISION
