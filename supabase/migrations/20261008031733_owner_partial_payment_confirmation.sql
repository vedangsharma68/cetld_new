-- FORWARD REVIEW PROPOSAL ONLY. No production application authorized by this file.
begin;
do $parser_source_guard$
begin
 if to_regprocedure('app.owner_payment_instruction(text)') is not null
   and (select md5(prosrc) from pg_proc where oid=to_regprocedure('app.owner_payment_instruction(text)'))
     not in ('39f1711c4d93b873013fedb9ce7cf54c','745dee54b826fe5525d6e1bc1357069e') then
  raise exception 'Unexpected installed owner payment instruction source; no changes applied';
 end if;
end;$parser_source_guard$;
create or replace function app.owner_payment_instruction(p_text text) returns jsonb
language plpgsql immutable set search_path='' as $parse$
declare parts text[];leading_parts text[];amount numeric;
begin
 parts:=pg_catalog.regexp_match(pg_catalog.btrim(p_text),'^(?:please\s+)?(?:record|log)\s+(?:a\s+)?([A-Z]{3})\s+([0-9]{1,12}(?:\.[0-9]{1,2})?)\s+(?:test\s+)?payment\s+(?:against|for|on)\s+invoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^.!?\n]+))?(?:[.!]\s*|$)(?:(?:This is only a dummy bookkeeping entry\.\s*)?(?:Keep customer messages and reminders off\.?|No customer messages or reminders\.?)?|This is a dummy bookkeeping entry only;\s*keep messages and reminders off\.?)$','i');
 if parts is null then
  leading_parts:=pg_catalog.regexp_match(pg_catalog.btrim(p_text),'^(?:please\s+)?for\s+(?:test\s+)?invoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^,.!?\n]+))?,\s*(?:please\s+)?(?:record|log)\s+(?:a\s+)?(?:partial\s+)?payment\s+of\s+([A-Z]{3})\s+([0-9]{1,12}(?:\.[0-9]{1,2})?)(?:[.!]\s*|$)(?:(?:This is only a dummy bookkeeping entry\.\s*)?(?:Keep customer messages and reminders off\.?|No customer messages or reminders\.?)?|This is a dummy bookkeeping entry only;\s*keep messages and reminders off\.?)$','i');
  if leading_parts is not null then parts:=array[leading_parts[3],leading_parts[4],leading_parts[1],leading_parts[2]];end if;
 end if;
 if parts is null or p_text ~* '\m(not|never|don''t|do not|undo|reverse|refund|transfer|instead|or)\M' or p_text ~ '["“”`]' then return null;end if;
 amount:=parts[2]::numeric;if amount<=0 then return null;end if;
 return jsonb_build_object('amount',amount,'currency',upper(parts[1]),'invoiceNumber',parts[3],'customerName',nullif(btrim(parts[4]),''));
exception when others then return null;
end;$parse$;
revoke all on function app.owner_payment_instruction(text) from public,anon,authenticated,service_role;

do $payment_forward$
declare target regprocedure;original text;marker text;replacement text;old_acl aclitem[];
begin
 -- Reapplication is a no-op only for the exact pair produced by this migration.
 if (select md5(prosrc) from pg_proc where oid='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure)='4e91e1fc34a0b0e639673a4d39632fd7'
   and (select md5(prosrc) from pg_proc where oid='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure)='6ed00f9c4aaabdb7673272ccef3d1390' then return;end if;
 target:='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure;
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 if (select md5(prosrc) from pg_proc where oid=target)<>'abcea06cef9727248dba104703ca7268' then raise exception 'Unexpected installed owner invoice confirmation source; no changes applied';end if;
 marker:=$old$  if change is distinct from '{"status":"paid"}'::jsonb then raise exception 'Invalid payment request';end if;
  perform public.record_invoice_payment(p_workspace_id,invoice.id,null,'wa_owner_payment_'||pending.id,
   'Confirmed by owner on WhatsApp',true);
  audit:=jsonb_build_object('status',jsonb_build_object('old',invoice.status,'new','paid'),
   'amountPaid',jsonb_build_object('old',invoice.amount_paid,'new',invoice.total_amount));$old$;
 replacement:=$new$  if change ? 'amount' then
   if not (regexp_replace(lower(btrim(coalesce(event.message_text,''))),'[.!]$','') in ('yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve')
     or (event.interaction_id like 'oab1.%' and coalesce((select owner_bot_preferences->>'confirmationMode' from public.workspace_settings where workspace_id=p_workspace_id),'direct')='buttons'))
     or (select count(*) from jsonb_object_keys(change))<>2 or jsonb_typeof(change->'amount')<>'number'
     or change->>'currency' is distinct from invoice.currency or (change->>'amount')::numeric<=0
     or (change->>'amount')::numeric<>round((change->>'amount')::numeric,2)
     or (change->>'amount')::numeric>invoice.total_amount-invoice.amount_paid
     or pending.action->>'customerId' is distinct from invoice.customer_id::text
     or (pending.action->>'amountPaidBefore')::numeric is distinct from invoice.amount_paid
     or pending.action->>'sourceMessageId'=p_confirmation_message_id
     or invoice.deleted_at is not null or app.invoice_has_external_ledger(invoice)
     or invoice.metadata->>'invoice_direction' is distinct from 'receivable' then
    return jsonb_build_object('ok',false,'reason','invalid_payment');end if;
   -- Original owner source event, current binding, exact amount/currency/target.
   if not exists(select 1 from public.whatsapp_inbound_events src
     cross join lateral (select app.owner_payment_instruction(src.message_text) facts) evidence
     where src.provider_message_id=pending.action->>'sourceMessageId' and src.sender_phone=p_phone
       and src.received_at<=pending.created_at and evidence.facts is not null
       and evidence.facts->'amount'=change->'amount' and evidence.facts->>'currency'=change->>'currency'
       and evidence.facts->>'invoiceNumber'=pending.action->>'requestedInvoiceNumber'
       and (evidence.facts->>'invoiceNumber' in (invoice.invoice_number,invoice.metadata->>'printed_invoice_number',invoice.metadata->>'source_invoice_number'))
       and evidence.facts->>'customerName' is not distinct from pending.action->>'requestedCustomerName'
       and (evidence.facts->>'customerName' is null or exists(select 1 from public.customers c where c.workspace_id=p_workspace_id and c.id=invoice.customer_id
         and lower(btrim(evidence.facts->>'customerName')) in (lower(btrim(c.name)),lower(btrim(c.company_name)))))) then
    return jsonb_build_object('ok',false,'reason','invalid_payment');end if;
   -- Verify that historical immutable receipts agree with the current net paid.
   if invoice.amount_paid is distinct from (select coalesce(sum(p.amount-coalesce((select sum(r.amount) from public.payment_reversals r where r.workspace_id=p_workspace_id and r.invoice_id=invoice.id and r.payment_id=p.id),0)),0) from public.payments p where p.workspace_id=p_workspace_id and p.invoice_id=invoice.id) then
    return jsonb_build_object('ok',false,'reason','invalid_payment');end if;
   perform public.record_invoice_payment(p_workspace_id,invoice.id,(change->>'amount')::numeric,'wa_owner_payment_'||pending.id,'Confirmed by owner on WhatsApp',false);
   update public.invoices set metadata=metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'approved_reminder_text',null,'approved_preferences_updated_at',null,'outstanding_amount',total_amount-amount_paid) where workspace_id=p_workspace_id and id=invoice.id;
   audit:=jsonb_build_object('paymentAmount',change->'amount','currency',invoice.currency,
     'amountPaid',jsonb_build_object('old',invoice.amount_paid,'new',invoice.amount_paid+(change->>'amount')::numeric));
  else
   if exists(select 1 from public.whatsapp_inbound_events src where src.provider_message_id=pending.action->>'sourceMessageId' and src.sender_phone=p_phone and app.owner_payment_instruction(src.message_text) is not null) then return jsonb_build_object('ok',false,'reason','invalid_payment');end if;
   if change is distinct from '{"status":"paid"}'::jsonb then raise exception 'Invalid payment request';end if;
   perform public.record_invoice_payment(p_workspace_id,invoice.id,null,'wa_owner_payment_'||pending.id,'Confirmed by owner on WhatsApp',true);
   audit:=jsonb_build_object('status',jsonb_build_object('old',invoice.status,'new','paid'),'amountPaid',jsonb_build_object('old',invoice.amount_paid,'new',invoice.total_amount));
  end if;$new$;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'payment amount confirmation marker mismatch';end if;
 original:=replace(original,marker,replacement);
 marker:=$old$'invoiceId',id,'actionType',pending.action->>'type')$old$;
 replacement:=$new$'invoiceId',id,'actionType',pending.action->>'type','updatedAt',updated_at,
   'paymentId',case when pending.action->>'type'='owner_invoice_payment' then (select id from public.payments where workspace_id=p_workspace_id and invoice_id=invoice.id and idempotency_key='wa_owner_payment_'||pending.id) end,
   'paymentAmount',case when change ? 'amount' then (change->>'amount')::numeric end,'currency',currency,'amountPaid',amount_paid,'outstandingAmount',total_amount-amount_paid)$new$;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'payment amount receipt marker mismatch';end if;
 execute replace(original,marker,replacement);
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'payment confirmation ACL changed';end if;
 target:='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure;
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 if (select md5(prosrc) from pg_proc where oid=target)<>'2e817f4bb2dca966b03cbfc015720152' then raise exception 'Unexpected installed direct owner write source; no changes applied';end if;
 marker:=$old$      if v_pending_type='owner_invoice_payment'
         and (v_invoice.status::text<>'paid' or v_invoice.amount_paid<v_invoice.total_amount) then$old$;
 replacement:=$new$      if v_pending_type='owner_invoice_payment' and
         (case when v_pending.action->'changes' ? 'amount' then
           v_invoice.currency is distinct from v_pending.action->'changes'->>'currency'
           or v_invoice.amount_paid is distinct from (v_pending.action->>'amountPaidBefore')::numeric+(v_pending.action->'changes'->>'amount')::numeric
         else v_invoice.status::text<>'paid' or v_invoice.amount_paid<v_invoice.total_amount end) then$new$;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'payment button verification marker mismatch';end if;
 original:=replace(original,marker,replacement);
 marker:=$old$v_action:=case when v_pending_type='owner_invoice_payment' then 'invoice.paid' else 'invoice.updated' end;$old$;
 replacement:=$new$v_action:=case when v_pending_type='owner_invoice_payment' then case when v_pending.action->'changes' ? 'amount' then 'invoice.payment_recorded' else 'invoice.paid' end else 'invoice.updated' end;$new$;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'payment button action marker mismatch';end if;
 execute replace(original,marker,replacement);
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'payment button ACL changed';end if;
end;$payment_forward$;
-- Read-only capability proof. Runtime requires this before preparing or confirming
-- an amount proposal; the old schema cannot expose a confirmable partial payment.
create or replace function public.whatsapp_owner_partial_payment_capability() returns jsonb
language sql security invoker set search_path='' as $capability$
 select case when
  (select md5(prosrc) from pg_catalog.pg_proc where oid='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure)='4e91e1fc34a0b0e639673a4d39632fd7'
  and (select md5(prosrc) from pg_catalog.pg_proc where oid='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure)='6ed00f9c4aaabdb7673272ccef3d1390'
  and (select md5(prosrc) from pg_catalog.pg_proc where oid='app.owner_payment_instruction(text)'::regprocedure)='745dee54b826fe5525d6e1bc1357069e'
 then jsonb_build_object('ok',true,'version',2) else jsonb_build_object('ok',false) end;
$capability$;
revoke all on function public.whatsapp_owner_partial_payment_capability() from public,anon,authenticated,service_role;
grant execute on function public.whatsapp_owner_partial_payment_capability() to service_role;
commit;
