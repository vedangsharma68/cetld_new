-- DRAFT: separate exact-file approval required before production application.
-- Extend only the private payment parser, deny-only amount guard and capability.
-- Preserve legacy capability 4; bookkeepingInstructions=1 proves the new grammar.
-- Confirmation independently reparses the original persisted instruction unchanged.
-- No business-row DML, grants, ownership, SECURITY DEFINER or search_path changes.
begin;
do $payment_forward$
declare
 parser regprocedure:='app.owner_payment_instruction(text)'::regprocedure;
 amount_guard regprocedure:='app.owner_payment_amount_mentioned(text)'::regprocedure;
 confirmation regprocedure:='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure;
 direct_write regprocedure:='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure;
 capability regprocedure:='public.whatsapp_owner_partial_payment_capability()'::regprocedure;
 security_before jsonb;
begin
 if exists(select 1 from pg_catalog.pg_proc where oid in (parser,amount_guard,confirmation,direct_write,capability)
   and prosrc is distinct from replace(prosrc,chr(13),'')
   and prosrc is distinct from replace(replace(prosrc,chr(13),''),chr(10),chr(13)||chr(10))) then
  raise exception 'Unexpected installed owner payment line endings; no changes applied';
 end if;
 if (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=parser) not in ('dd97384b7b854a80c68357b6afa68ca5','3950ab33319643e13ef318190bf51ad0')
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=amount_guard) not in ('cdf7e0257ebe342c904acfb937935d73','849b8be4cbbafb0f8fbea8a5abe7d729')
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=capability) not in ('1b3efde31f586c71bc03be4dc953cf43','62d7fcf1bbd80d6971bb450126d054a4')
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=confirmation)<>'9a949d277cc600d6cb7f17964954465e'
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=direct_write)<>'2b66000528ea1d8a34dd483ce040b307' then
  raise exception 'Unexpected installed owner payment source; no changes applied';
 end if;
 select jsonb_agg(jsonb_build_object('oid',oid,'acl',proacl::text,'owner',proowner,'definer',prosecdef,'config',proconfig) order by oid)
 into security_before from pg_catalog.pg_proc where oid in (parser,amount_guard,confirmation,direct_write,capability);
 execute $parser_sql$
create or replace function app.owner_payment_instruction(p_text text) returns jsonb
language plpgsql immutable set search_path='' as $parse$
declare
 text_value text:=pg_catalog.regexp_replace(btrim(coalesce(p_text,'')),',\s*please[.!]?\s*$','.','i');rest text;after_leading text;
 money text:=$rx$([A-Z]{3})\s+([0-9]{1,12}(?:\.[0-9]{1,2})?)$rx$;
 command text:=$rx$(?:please\s+)?(?:record|log|register)\s+(?:a\s+)?$rx$;
 qualifier text:=$rx$(?:(?:test|partial)\s+)?(?:bookkeeping\s+)?$rx$;
 reference text:=$rx$(?:the\s+)?(?:(?:dummy|test|disposable\s+QA)\s+)?(?:([^.!?;\n]{1,255}?)\s+)?invoice(?:\s+(?:number|no\.?|ref(?:erence)?))?\s+(?:#\s*)?([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^.!?;\n]{1,255}?))?$rx$;
 ending text:=$rx$(?:[.!;]\s*|$)$rx$;payment_end text;
 leading_parts text[];payment text[];target text[];remaining text[];bookkeeping text[];quiet text[];polite text[];clause text[];
 seen text[]:='{}';kind text;amount numeric;currency text;facts jsonb;
begin
 if text_value='' or char_length(text_value)>2400 or text_value ~ '["“”`?]' then return null;end if;
 leading_parts:=pg_catalog.regexp_match(text_value,'^((?:please\s+)?for\s+)','i');
 if leading_parts is not null then
  after_leading:=substr(text_value,length(leading_parts[1])+1);
  target:=pg_catalog.regexp_match(after_leading,'^('||reference||'\s*,\s*)','i');
  if target is null then return null;end if;
  rest:=substr(after_leading,length(target[1])+1);payment_end:=ending;
 else
  rest:=text_value;payment_end:='\s+(?:against|for|on)\s+';
 end if;
 payment:=pg_catalog.regexp_match(rest,'^('||command||money||'\s+'||qualifier||'payment'||payment_end||')','i');
 if payment is null then
  payment:=pg_catalog.regexp_match(rest,'^('||command||qualifier||'payment\s+of\s+'||money||payment_end||')','i');
 end if;
 if payment is null then return null;end if;
 rest:=substr(rest,length(payment[1])+1);
 if leading_parts is null then
  target:=pg_catalog.regexp_match(rest,'^('||reference||ending||')','i');
  if target is null then return null;end if;
  rest:=substr(rest,length(target[1])+1);
 end if;
 if (target[2] is not null and target[4] is not null)
  or (payment[1]||' '||target[1]) ~* '\m(not|never|don''t|do not|undo|reverse|refund|transfer|instead|or)\M' then return null;end if;
 amount:=payment[3]::numeric;currency:=upper(payment[2]);if amount<=0 then return null;end if;
 facts:=jsonb_build_object('currency',currency,'amount',amount,'invoiceNumber',target[3],'customerName',nullif(btrim(coalesce(target[2],target[4])),''));
 while rest<>'' loop
  remaining:=pg_catalog.regexp_match(rest,'^((?:leave|keep)\s+'||money||'\s+(?:outstanding|remaining)'||ending||')','i');
  bookkeeping:=pg_catalog.regexp_match(rest,'^(this\s+is\s+(?:only\s+)?a\s+(?:dummy|test)\s+bookkeeping\s+entry(?:\s+only)?'||ending||')','i');
  quiet:=pg_catalog.regexp_match(rest,'^((?:keep\s+reminders\s+paused(?:\s+and\s+do\s+not\s+contact\s+anyone)?|do\s+not\s+contact\s+anyone|keep\s+(?:customer\s+)?messages\s+and\s+reminders\s+off|no\s+(?:customer\s+)?messages\s+or\s+reminders|do\s+not\s+send\s+(?:any\s+)?(?:customer\s+)?messages\s+or\s+reminders)'||ending||')','i');
  polite:=pg_catalog.regexp_match(rest,'^(please'||ending||')','i');
  kind:=case when remaining is not null then 'remaining' when bookkeeping is not null then 'bookkeeping' when quiet is not null then 'quiet' when polite is not null then 'polite' end;
  clause:=coalesce(remaining,bookkeeping,quiet,polite);
  if clause is null or kind=any(seen) then return null;end if;
  seen:=array_append(seen,kind);
  if remaining is not null then
   if upper(remaining[2])<>currency then return null;end if;
   facts:=facts||jsonb_build_object('expectedOutstanding',remaining[3]::numeric);
  end if;
  rest:=substr(rest,length(clause[1])+1);
 end loop;
 if text_value ~* '\mbookkeeping\s+payment\M|\mdisposable\s+QA\M|\mkeep\s+reminders\s+paused\M|\mdo\s+not\s+contact\s+anyone\M' then facts:=facts||jsonb_build_object('instructionVersion',5);end if;
 return facts;
exception when others then return null;
end;$parse$;
$parser_sql$;
 execute $guard_sql$
create or replace function app.owner_payment_amount_mentioned(p_text text) returns boolean
language sql immutable set search_path='' as $amount_guard$
 select coalesce(p_text,'') ~* '\mpartial\s+(?:bookkeeping\s+)?payment\M|\m(?:bookkeeping\s+)?payment\s+(?:of\s+)?(?:[A-Z]{3}\s+)?[0-9]|\m(?:[A-Z]{3}\s+)?[0-9]+(?:\.[0-9]+)?\s+(?:(?:partial|test)\s+)?(?:bookkeeping\s+)?payment\M';
$amount_guard$;
$guard_sql$;
 execute $capability_sql$
create or replace function public.whatsapp_owner_partial_payment_capability() returns jsonb
language sql security invoker set search_path='' as $capability$
 select case when
  (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure)='9a949d277cc600d6cb7f17964954465e'
  and (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure)='2b66000528ea1d8a34dd483ce040b307'
  and (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='app.owner_payment_instruction(text)'::regprocedure)='3950ab33319643e13ef318190bf51ad0'
  and (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid='app.owner_payment_amount_mentioned(text)'::regprocedure)='849b8be4cbbafb0f8fbea8a5abe7d729'
 then jsonb_build_object('ok',true,'version',4,'bookkeepingInstructions',1) else jsonb_build_object('ok',false) end;
$capability$;
$capability_sql$;
 if (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=parser)<>'3950ab33319643e13ef318190bf51ad0'
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=amount_guard)<>'849b8be4cbbafb0f8fbea8a5abe7d729'
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=capability)<>'62d7fcf1bbd80d6971bb450126d054a4'
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=confirmation)<>'9a949d277cc600d6cb7f17964954465e'
  or (select md5(replace(prosrc,chr(13),'')) from pg_catalog.pg_proc where oid=direct_write)<>'2b66000528ea1d8a34dd483ce040b307' then
  raise exception 'Owner payment installed source verification failed';
 end if;
 if (select jsonb_agg(jsonb_build_object('oid',oid,'acl',proacl::text,'owner',proowner,'definer',prosecdef,'config',proconfig) order by oid)
   from pg_catalog.pg_proc where oid in (parser,amount_guard,confirmation,direct_write,capability)) is distinct from security_before then
  raise exception 'Owner payment routine security changed';
 end if;
end;$payment_forward$;
commit;
