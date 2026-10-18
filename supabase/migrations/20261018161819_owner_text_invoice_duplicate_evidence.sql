-- A customer constraint or an allocated canonical-number conflict must not be
-- reported as proof that the owner's supplied invoice code exists. Preserve
-- the original write transaction, owner authorization, locks and grants.
begin;
do $migration$
declare
  target regprocedure := pg_catalog.to_regprocedure('public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)');
  definition text;
  old_handler text := $old$        exception when unique_violation then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVOICE_EXISTS');
        end;$old$;
  new_handler text := $new$        exception when unique_violation then
          -- The failed insert block has rolled back, including a new customer.
          -- Only persisted evidence in this workspace can establish a duplicate.
          if v_invoice_number is not null and exists(
            select 1 from public.invoices i where i.workspace_id=p_workspace_id
              and (i.invoice_number=v_invoice_number
                or i.customer_id=v_customer.id and (
                  i.metadata->>'printed_invoice_number'=v_invoice_number
                  or i.metadata->>'source_invoice_number'=v_invoice_number))) then
            return pg_catalog.jsonb_build_object('ok',false,'code','INVOICE_EXISTS');
          end if;
          return pg_catalog.jsonb_build_object('ok',false,'code','DATABASE_UNAVAILABLE');
        end;$new$;
begin
  if target is null then raise exception 'Owner direct write prerequisite missing'; end if;
  definition:=pg_catalog.replace(pg_catalog.pg_get_functiondef(target),chr(13),'');
  if pg_catalog.strpos(definition,new_handler)>0 then return; end if;
  if pg_catalog.strpos(definition,old_handler)=0
    or pg_catalog.strpos(pg_catalog.substr(definition,pg_catalog.strpos(definition,old_handler)+pg_catalog.length(old_handler)),old_handler)>0 then
    raise exception 'Unexpected owner invoice create handler; no changes applied';
  end if;
  execute pg_catalog.replace(definition,old_handler,new_handler);
end;
$migration$;
commit;
