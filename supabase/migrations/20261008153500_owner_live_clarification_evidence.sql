-- Forward proposal: separate exact-file approval required before production apply.
-- Evidence grammar and denial guards only. No invoice/payment/message rows change.
begin;
do $known_sources$
begin
 if exists(select 1 from pg_catalog.pg_proc where oid in (
   'app.owner_payment_instruction(text)'::regprocedure,
   'public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure,
   'public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure,
   'public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure)
   and prosrc is distinct from replace(prosrc,chr(13),'')
   and prosrc is distinct from replace(replace(prosrc,chr(13),''),chr(10),chr(13)||chr(10))) then
  raise exception 'Unexpected installed owner evidence line endings; no changes applied';
 end if;
 if (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='app.owner_payment_instruction(text)'::regprocedure) not in ('b23518142d74e3c076c5dc18c644bf97','fc9b0e7319181b59fd716de8f87acc0f')
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure) not in ('4e91e1fc34a0b0e639673a4d39632fd7','0bd5f0e6ca732a8cbe7ddedee64acb45')
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure) not in ('f39fc6258f46e3fe933f87b77aadea2a','0ec3c131390877826e57e864b4d9ed22')
  or (select md5(prosrc) from pg_catalog.pg_proc where oid='public.whatsapp_owner_partial_payment_capability()'::regprocedure) not in ('fa99d7cbbbe81bead0ba56decb61e747','0658d4f13ee209f899e5f7680d485134')
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure)<>'6ed00f9c4aaabdb7673272ccef3d1390' then
   raise exception 'Unexpected installed owner evidence source; no changes applied';
 end if;
 if to_regprocedure('app.owner_payment_amount_mentioned(text)') is not null
  and (select md5(prosrc) from pg_catalog.pg_proc where oid=to_regprocedure('app.owner_payment_amount_mentioned(text)'))<>'cdf7e0257ebe342c904acfb937935d73' then
   raise exception 'Unexpected installed amount guard source; no changes applied';
 end if;
end;$known_sources$;
create or replace function app.owner_payment_instruction(p_text text) returns jsonb
language plpgsql immutable set search_path='' as $parse$
declare parts text[];leading_parts text[];amount numeric;
begin
 parts:=pg_catalog.regexp_match(pg_catalog.btrim(p_text),'^(?:please\s+)?(?:record|log)\s+(?:a\s+)?([A-Z]{3})\s+([0-9]{1,12}(?:\.[0-9]{1,2})?)\s+(?:(?:test|partial)\s+)?payment\s+(?:against|for|on)\s+(?:the\s+)?(?:dummy\s+)?invoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^.!?\n]+))?(?:[.!]\s*|$)(?:(?:This is only a dummy bookkeeping entry\.\s*)?(?:Keep customer messages and reminders off\.?|No customer messages or reminders\.?)?|This is a dummy bookkeeping entry only;\s*keep messages and reminders off\.?)$','i');
 if parts is null then
  leading_parts:=pg_catalog.regexp_match(pg_catalog.btrim(p_text),'^(?:please\s+)?for\s+(?:test\s+)?invoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^,.!?\n]+))?,\s*(?:please\s+)?(?:record|log)\s+(?:a\s+)?(?:partial\s+)?payment\s+of\s+([A-Z]{3})\s+([0-9]{1,12}(?:\.[0-9]{1,2})?)(?:[.!]\s*|$)(?:(?:This is only a dummy bookkeeping entry\.\s*)?(?:Keep customer messages and reminders off\.?|No customer messages or reminders\.?)?|This is a dummy bookkeeping entry only;\s*keep messages and reminders off\.?)$','i');
  if leading_parts is not null then parts:=array[leading_parts[3],leading_parts[4],leading_parts[1],leading_parts[2]];end if;
 end if;
 if parts is null or pg_catalog.array_to_string(parts,' ') ~* '\m(not|never|don''t|do not|undo|reverse|refund|transfer|instead|or)\M' or p_text ~ '["“”`]' then return null;end if;
 amount:=parts[2]::numeric;if amount<=0 then return null;end if;
 return jsonb_build_object('amount',amount,'currency',upper(parts[1]),'invoiceNumber',parts[3],'customerName',nullif(btrim(parts[4]),''));
exception when others then return null;
end;$parse$;
revoke all on function app.owner_payment_instruction(text) from public,anon,authenticated,service_role;
create or replace function app.owner_payment_amount_mentioned(p_text text) returns boolean
language sql immutable set search_path='' as $amount_guard$
 select coalesce(p_text,'') ~* '\mpartial\s+payment\M|\mpayment\s+(?:of\s+)?(?:[A-Z]{3}\s+)?[0-9]|\m(?:[A-Z]{3}\s+)?[0-9]+(?:\.[0-9]+)?\s+(?:(?:partial|test)\s+)?payment\M';
$amount_guard$;
revoke all on function app.owner_payment_amount_mentioned(text) from public,anon,authenticated,service_role;

do $narrow_changes$
declare target regprocedure;definition text;old_acl aclitem[];old_owner oid;old_definer boolean;old_config text[];marker text;replacement text;
begin
 foreach target in array array[
  'public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure,
  'public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure] loop
  select proacl,proowner,prosecdef,proconfig into old_acl,old_owner,old_definer,old_config from pg_catalog.pg_proc where oid=target;
  definition:=replace(pg_catalog.pg_get_functiondef(target),chr(13),'');
  if target='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure then
   if (select md5(prosrc) from pg_catalog.pg_proc where oid=target)='0bd5f0e6ca732a8cbe7ddedee64acb45' then continue;end if;
   marker:=$old$and app.owner_payment_instruction(src.message_text) is not null) then return$old$;
   replacement:=$new$and app.owner_payment_amount_mentioned(src.message_text)) then return$new$;
  else
   if (select md5(prosrc) from pg_catalog.pg_proc where oid=target)='0ec3c131390877826e57e864b4d9ed22' then continue;end if;
   marker:=$old$        or v_owner_quote !~* '\m(it|this( invoice)?|the invoice)[[:space:]]+is[[:space:]]+unpaid\M'$old$;
   replacement:=$new$        or not (v_owner_quote ~* '\m(it|this( invoice)?|the invoice)[[:space:]]+is[[:space:]]+unpaid\M'
          or (v_owner_quote ~* '\mno payment has been received\M'
            and v_owner_quote ~* '\msave (it|this( invoice)?|the invoice) as an unpaid draft\M'))
        or regexp_replace(v_owner_quote,'\mno payment has been received\M','','gi')
          ~* '\mpayment (has been|was|is) received\M|\mreceived (a |the )?payment\M'$new$;
  end if;
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then raise exception 'Owner evidence marker mismatch';end if;
  execute replace(definition,marker,replacement);
  if exists(select 1 from pg_catalog.pg_proc where oid=target and
    (proacl is distinct from old_acl or proowner is distinct from old_owner or prosecdef is distinct from old_definer or proconfig is distinct from old_config)) then
   raise exception 'Owner evidence routine security changed';
  end if;
 end loop;
end;$narrow_changes$;
create or replace function public.whatsapp_owner_partial_payment_capability() returns jsonb
language sql security invoker set search_path='' as $capability$
 select case when
  (select md5(prosrc) from pg_catalog.pg_proc where oid='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure)='0bd5f0e6ca732a8cbe7ddedee64acb45'
  and (select md5(prosrc) from pg_catalog.pg_proc where oid='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure)='6ed00f9c4aaabdb7673272ccef3d1390'
  and (select md5(prosrc) from pg_catalog.pg_proc where oid='app.owner_payment_instruction(text)'::regprocedure)='fc9b0e7319181b59fd716de8f87acc0f'
  and (select md5(prosrc) from pg_catalog.pg_proc where oid='app.owner_payment_amount_mentioned(text)'::regprocedure)='cdf7e0257ebe342c904acfb937935d73'
 then jsonb_build_object('ok',true,'version',3) else jsonb_build_object('ok',false) end;
$capability$;
revoke all on function public.whatsapp_owner_partial_payment_capability() from public,anon,authenticated,service_role;
grant execute on function public.whatsapp_owner_partial_payment_capability() to service_role;
commit;
