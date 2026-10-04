-- FORWARD LOCAL REVIEW PROPOSAL. No production application or existing data edits.
begin;
-- Invoker role distinguishes raw dashboard DML from existing validated definer
-- RPCs. The JWT role alone is insufficient: those RPCs retain the owner's JWT.
create function app.guard_raw_invoice_source_metadata() returns trigger
language plpgsql set search_path='' as $$
declare k text;
begin
 if current_user<>'authenticated' or auth.role() is distinct from 'authenticated' then return new;end if;
 for k in select key from jsonb_object_keys(new.metadata) key
   union select key from jsonb_object_keys(case when tg_op='UPDATE' then old.metadata else '{}'::jsonb end) key
 loop
  if k ~ '^(source_|original_|extracted_|extraction($|_)|raw_text$)'
    or k in ('printed_invoice_number','invoice_number_override_audit','assistant_idempotency_key','whatsapp_corrections') then
   -- Browser extraction can submit a self-reported printed label/status on a
   -- NEW invoice; it is no attestation. Existing labels become immutable.
   -- Browser Assistant creation also supplies its own new idempotency key.
   if tg_op='INSERT' and k in ('source_invoice_number','extraction_status','assistant_idempotency_key') then
    if k='source_invoice_number' and (jsonb_typeof(new.metadata->k) is distinct from 'string'
      or length(btrim(new.metadata->>k)) not between 1 and 100 or new.metadata->>k ~ '[[:cntrl:]]') then
      raise exception 'invalid initial source invoice number' using errcode='22023';end if;
   elsif tg_op='INSERT' or new.metadata->k is distinct from old.metadata->k then
    raise exception 'invoice source and audit metadata is server managed' using errcode='42501';
   end if;
  end if;
 end loop;
 return new;
end; $$;
revoke all on function app.guard_raw_invoice_source_metadata() from public,anon,authenticated,service_role;
-- PostgreSQL orders equal-event triggers by name. Validate user input BEFORE
-- assign_consistent_invoice_number adds its trusted source_invoice_number.
create trigger a0_invoices_source_metadata_guard before insert or update on public.invoices
for each row execute function app.guard_raw_invoice_source_metadata();

-- The authenticated paid Assistant RPC is a definer and accepts p_metadata.
-- Reject forged attestations at that entrypoint too; retain its numbering,
-- membership, atomic receipt, direction, replay and immutable-money behavior.
do $paid_source_guard$
declare target regprocedure:='public.create_paid_assistant_invoice(uuid,uuid,text,date,date,text,numeric,text,jsonb,text,text)'::regprocedure;
 original text;marker text:='  insert into public.invoices(';old_acl aclitem[];
begin
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'paid Assistant source guard marker mismatch';end if;
 execute replace(original,marker,
  '  if auth.role()=''authenticated'' and exists(select 1 from jsonb_object_keys(p_metadata) x(key) where (key ~ ''^(source_|original_|extracted_|extraction($|_)|raw_text$)'' or key in (''printed_invoice_number'',''invoice_number_override_audit'',''whatsapp_corrections'')) and key not in (''source_invoice_number'',''extraction_status'')) then raise exception ''invoice source and audit metadata is server managed'' using errcode=''42501'';end if;'||chr(10)||
  '  if auth.role()=''authenticated'' and p_metadata ? ''source_invoice_number'' and (jsonb_typeof(p_metadata->''source_invoice_number'') is distinct from ''string'' or length(btrim(p_metadata->>''source_invoice_number'')) not between 1 and 100 or p_metadata->>''source_invoice_number'' ~ ''[[:cntrl:]]'') then raise exception ''invalid initial source invoice number'' using errcode=''22023'';end if;'||chr(10)||marker);
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'paid Assistant source guard ACL changed';end if;
end; $paid_source_guard$;

-- File upload remains append-only for authenticated clients: app.js uploads a
-- new Storage object, then INSERTs this scoped row. Existing source bindings
-- cannot be moved/replaced/deleted through raw owner/member Data API requests.
create function app.guard_raw_invoice_source_file() returns trigger
language plpgsql set search_path='' as $$
declare parts text[];
begin
 if current_user='authenticated' and auth.role()='authenticated' then
  if tg_op='INSERT' then
   parts:=string_to_array(new.storage_path,'/');
   if coalesce(array_length(parts,1),0)<>3 or parts[1] is distinct from new.workspace_id::text
     or parts[2] is distinct from new.invoice_id::text or parts[3] in ('','.','..') or parts[3] ~ '[[:cntrl:]]' then
    raise exception 'invoice source file path must match its workspace and invoice' using errcode='42501';end if;
  elsif tg_op='DELETE' or to_jsonb(new)-'updated_at' is distinct from to_jsonb(old)-'updated_at' then
   raise exception 'existing invoice source file metadata is server managed' using errcode='42501';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end; $$;
revoke all on function app.guard_raw_invoice_source_file() from public,anon,authenticated,service_role;
create trigger a0_invoice_files_source_guard before insert or update or delete on public.invoice_files
for each row execute function app.guard_raw_invoice_source_file();

-- Policies are ORed. Fail closed if an unreviewed permissive write policy could
-- bypass these named predicates. No managed Storage table/trigger/grant changes.
do $storage_policy_review$
begin
 if (select count(*) from pg_policy where polrelid='storage.objects'::regclass and polname in ('invoice_files_object_update','invoice_files_object_delete'))<>2
  or exists(select 1 from pg_policy where polrelid='storage.objects'::regclass and polpermissive and polcmd in ('w','d','*')
    and exists(select 1 from unnest(polroles) r(role_oid) where case when role_oid=0 then true
      else pg_has_role('authenticated',role_oid,'USAGE') end) and polname not in ('invoice_files_object_update','invoice_files_object_delete')) then
  raise exception 'Storage write policies require explicit source preservation review';end if;
end; $storage_policy_review$;
alter policy invoice_files_object_update on storage.objects
 using (bucket_id='invoice-files' and app.valid_invoice_file_path(name)
  and not exists(select 1 from public.invoice_files f where f.storage_path=storage.objects.name))
 with check (bucket_id='invoice-files' and app.valid_invoice_file_path(name)
  and not exists(select 1 from public.invoice_files f where f.storage_path=storage.objects.name));
alter policy invoice_files_object_delete on storage.objects
 using (bucket_id='invoice-files' and app.valid_invoice_file_path(name)
  and not exists(select 1 from public.invoice_files f where f.storage_path=storage.objects.name));
commit;
