-- Containment only: no persisted invoice can prove its immutable original account.
-- No business-row DML, provenance capture/backfill, grants or schema objects.
begin;
set local search_path=pg_catalog,public;
do $contain$
declare entry record; target oid; original text; updated text; body text;
  marker text; replacement text; before_security jsonb; after_security jsonb;
begin
  -- Exact pg_get_functiondef UTF8 SHA256 predecessors. Both audited core variants
  -- (base invoker and optional approved-reminder definer) are supported.
  for entry in select * from (values
    ('app.invoice_has_external_ledger(public.invoices)',array['80321aeca14fc9c5f333f74ab938ff238a99869b7645edabb91235a4e6dfecde']::text[]),
    ('app.reminder_external_read_matches(public.invoices,uuid)',array['73dafbdb036ae4dc03431dc547f2f63fbc40e4f7536c23437e1f982450883ce9']::text[]),
    ('app.reminder_local_status_payable(public.invoices)',array['e36d0a1f718bf10ae9005f9ed2cb628199e54a50610803f69c7a4c696be4b57a']::text[]),
    ('public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)',array['ed0ea611b1367778031fe4c6d4e9b8e086e7eb3659a0764a1afaffa9a880ee23','70bc302dc086e6da8321a16439591669e97856e876fd5db1427d65901b279464']::text[]),
    ('public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)',array['c579a14174d421dc6ac71452ef0ac7502ffebed1e5a2f18b6b1e08812849e1a1','7e648b333362bd3fb554c6c81cace69f897797c479c264b010cc4fb18ae628a0']::text[])
  ) sources(signature,hashes)
  loop
    target:=to_regprocedure(entry.signature);
    if target is null then raise exception 'containment predecessor missing: %',entry.signature;end if;
    original:=pg_get_functiondef(target);
    if not encode(sha256(convert_to(original,'UTF8')),'hex')=any(entry.hashes) then
      raise exception 'containment predecessor source drift: %',entry.signature;
    end if;
    -- Private predicates have only owner EXECUTE. Public core gates additionally
    -- permit service_role EXECUTE, without grant option. No caller authority added.
    if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=target and (a.grantee<>p.proowner and
        (entry.signature not like 'public.%' or a.grantee<>'service_role'::regrole or a.is_grantable))) then
      raise exception 'containment predecessor ACL drift: %',entry.signature;
    end if;
  end loop;

  foreach target in array array[
    'app.reminder_external_read_matches(public.invoices,uuid)'::regprocedure::oid,
    'app.reminder_local_status_payable(public.invoices)'::regprocedure::oid,
    'public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)'::regprocedure::oid,
    'public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'::regprocedure::oid
  ] loop
    select jsonb_build_object('owner',proowner,'acl',proacl,'definer',prosecdef,'config',proconfig,
      'volatility',provolatile,'language',prolang,'leakproof',proleakproof),pg_get_functiondef(oid),prosrc
      into before_security,original,body from pg_proc where oid=target;
    updated:=original;
    case (select proname from pg_proc where oid=target)
      when 'reminder_external_read_matches' then
        marker:=body;
        replacement:=E'\nbegin\n -- Current organization, matching facts, metadata and old evidence are not provenance.\n return false;\nend;\n';
      when 'reminder_local_status_payable' then
        marker:='select i.status in (''sent'',''overdue'');';
        replacement:='select i.status in (''sent'',''overdue'') and not app.invoice_has_external_ledger(i);';
      when 'cetld_core_claim_due_followups' then
        if strpos(original,'for candidate in')>0 then
          marker:='and v.followup_state in';
          replacement:='and not (nullif(btrim(v.external_provider),'''') is not null or nullif(btrim(v.external_invoice_id),'''') is not null or nullif(btrim(v.metadata->>''accounting_provider''),'''') is not null or nullif(btrim(v.metadata->>''bookkeeping_record_id''),'''') is not null) and v.followup_state in';
          if (length(updated)-length(replace(updated,marker,'')))/length(marker)<>1 then
            raise exception 'containment candidate patch point drift';end if;
          updated:=replace(updated,marker,replacement);
          marker:='if i.id is null or i.deleted_at is not null or i.followup_state';
          replacement:='if i.id is null or (nullif(btrim(i.external_provider),'''') is not null or nullif(btrim(i.external_invoice_id),'''') is not null or nullif(btrim(i.metadata->>''accounting_provider''),'''') is not null or nullif(btrim(i.metadata->>''bookkeeping_record_id''),'''') is not null) or i.deleted_at is not null or i.followup_state';
        else
          marker:='and i.status::text not in';
          replacement:='and not (nullif(btrim(i.external_provider),'''') is not null or nullif(btrim(i.external_invoice_id),'''') is not null or nullif(btrim(i.metadata->>''accounting_provider''),'''') is not null or nullif(btrim(i.metadata->>''bookkeeping_record_id''),'''') is not null) and i.status::text not in';
        end if;
      when 'cetld_core_authorize_delivery' then
        marker:='i.status::text in (''paid'',''void'',''cancelled'')';
        replacement:='(nullif(btrim(i.external_provider),'''') is not null or nullif(btrim(i.external_invoice_id),'''') is not null or nullif(btrim(i.metadata->>''accounting_provider''),'''') is not null or nullif(btrim(i.metadata->>''bookkeeping_record_id''),'''') is not null) or i.status::text in (''paid'',''void'',''cancelled'')';
    end case;
    if (length(updated)-length(replace(updated,marker,'')))/length(marker)<>1 then
      raise exception 'containment patch point drift: %',target::regprocedure;end if;
    execute replace(updated,marker,replacement);
    select jsonb_build_object('owner',proowner,'acl',proacl,'definer',prosecdef,'config',proconfig,
      'volatility',provolatile,'language',prolang,'leakproof',proleakproof)
      into after_security from pg_proc where oid=target;
    if after_security is distinct from before_security then
      raise exception 'containment changed function security: %',target::regprocedure;end if;
  end loop;
end $contain$;
commit;
