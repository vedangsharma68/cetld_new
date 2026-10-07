begin;

-- Repair only the JSON-expression precedence in the installed continuation
-- function. CREATE OR REPLACE preserves its owner, ACL, signature and scope
-- checks. No table, invoice, payment, review row or setting is changed.
do $repair$
declare
  v_target regprocedure := 'public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure;
  v_definition text := pg_catalog.pg_get_functiondef(v_target);
  v_original text[] := array[
    $old$p_action->'ownerProvidedFacts' - v_resolved_fields$old$,
    $old$p_action->'invoice' - v_resolved_invoice_keys$old$,
    $old$v_current_action->'invoice' - v_resolved_invoice_keys$old$
  ];
  v_corrected text[] := array[
    $fixed$(p_action->'ownerProvidedFacts') - v_resolved_fields$fixed$,
    $fixed$(p_action->'invoice') - v_resolved_invoice_keys$fixed$,
    $fixed$(v_current_action->'invoice') - v_resolved_invoice_keys$fixed$
  ];
  v_index integer;
begin
  if pg_catalog.strpos(v_definition, v_original[1]) = 0
    and pg_catalog.strpos(v_definition, v_original[2]) = 0
    and pg_catalog.strpos(v_definition, v_original[3]) = 0
    and pg_catalog.strpos(v_definition, v_corrected[1]) > 0
    and pg_catalog.strpos(v_definition, v_corrected[2]) > 0
    and pg_catalog.strpos(v_definition, v_corrected[3]) > 0 then
    return;
  end if;
  for v_index in 1..3 loop
    if (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_original[v_index], '')))
      / pg_catalog.length(v_original[v_index]) <> 1 then
      raise exception 'Unexpected invoice review continuation source; no repair applied';
    end if;
  end loop;
  for v_index in 1..3 loop
    v_definition := pg_catalog.replace(v_definition, v_original[v_index], v_corrected[v_index]);
  end loop;
  execute v_definition;
end
$repair$;

commit;
