-- Extends the existing immutable approval catalog and atomic authorization gate.
-- No sends, scheduling, consent changes or feature-flag changes.
begin;
create function app.reminder_outstanding_text(amount numeric,currency text) returns text
language plpgsql immutable strict set search_path='' as $$
declare whole text;fraction text;formatted text;
begin
  if amount<=0 or currency !~ '^[A-Z]{3}$' then return null;end if;
  formatted:=to_char(amount,'FM999999999999999999999999999999990.00');
  whole:=split_part(formatted,'.',1);fraction:=split_part(formatted,'.',2);
  if currency='INR' then
    if length(whole)>3 then whole:=regexp_replace(left(whole,-3),'([0-9])(?=([0-9]{2})+$)','\1,','g')||','||right(whole,3);end if;
    return '₹'||whole||case when fraction='00' then '' else '.'||fraction end;
  end if;
  return currency||' '||regexp_replace(whole,'([0-9])(?=([0-9]{3})+$)','\1,','g')||'.'||fraction;
end $$;
revoke all on function app.reminder_outstanding_text(numeric,text) from public,anon,authenticated,service_role;

-- Requires the approved sender predecessor migration. Missing patch points abort.
do $upgrade$
declare definition text;before_patch text;
begin
  alter table app.first_party_reminder_templates drop constraint first_party_reminder_templates_parameter_count_check;
  alter table app.first_party_reminder_templates add constraint first_party_reminder_templates_parameter_count_check check(parameter_count in (3,5));
  alter table app.first_party_reminder_templates drop constraint first_party_reminder_templates_tone_check;
  alter table app.first_party_reminder_templates add constraint first_party_reminder_templates_tone_check check(tone in ('gentle','relaxed','firm','professional'));
  insert into app.first_party_reminder_templates(waba_id,name,language,revision,body,approved,approval_reference,approved_at,category,parameter_count,button_variant,tone) values
('1734116767674237','cetld_invoice_details_relaxed_v1','en','approved-20261018','Hi {{1}} 👋 I''m Cetld, {{2}}''s assistant. A quick heads-up: invoice {{3}} has {{4}} outstanding, due on {{5}}. Questions? Just reply here 😊',true,'Owner verified Meta APPROVED Utility en, 2026-10-18',clock_timestamp(),'UTILITY',5,false,'relaxed'),
('1734116767674237','cetld_invoice_details_firm_v1','en','approved-20261018','Hi {{1}}, I''m Cetld, {{2}}''s assistant. 📌 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please confirm your expected payment date, or let us know if there is an issue.',true,'Owner verified Meta APPROVED Utility en, 2026-10-18',clock_timestamp(),'UTILITY',5,false,'firm'),
('1734116767674237','cetld_invoice_details_professional_v1','en','approved-20261018','Hi {{1}}, I''m Cetld, {{2}}''s assistant. 🧾 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please reply if you have any questions.',true,'Owner verified Meta APPROVED Utility en, 2026-10-18',clock_timestamp(),'UTILITY',5,false,'professional');
  definition:=pg_get_functiondef('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)'::regprocedure);
  before_patch:=definition;
  definition:=replace(definition,$old$  select * into i from public.invoices where workspace_id=p_workspace_id and id=(p_snapshot->>'invoiceId')::uuid for update;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  select * into x from public.customers where id=i.customer_id and workspace_id=p_workspace_id for share;$old$,$new$  -- Match tone invalidation's customer -> invoice lock order.
  select * into x from public.customers where workspace_id=p_workspace_id
    and id=(select customer_id from public.invoices where workspace_id=p_workspace_id and id=(p_snapshot->>'invoiceId')::uuid) for share;
  select * into i from public.invoices where workspace_id=p_workspace_id and id=(p_snapshot->>'invoiceId')::uuid for update;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  if x.id is null or x.id is distinct from i.customer_id then return '{"authorized":false}';end if;$new$);
  if definition=before_patch then raise exception 'Reminder customer lock patch point missing';end if;
  before_patch:=definition;
  definition:=replace(definition,$old$or t.tone<>(case when s.follow_up_preferences->>'tone'='gentle' then 'gentle' else 'professional' end)
    or t.button_variant<>coalesce((s.follow_up_preferences->>'templateButtons')::boolean,false)$old$,$new$or (t.parameter_count=3 and (x.reminder_tone is not null or
      case when s.follow_up_preferences ? 'templateName' then t.name is distinct from s.follow_up_preferences->>'templateName'
      else t.tone<>(case when s.follow_up_preferences->>'tone'='gentle' then 'gentle' else 'professional' end)
        or t.button_variant<>coalesce((s.follow_up_preferences->>'templateButtons')::boolean,false) end))
    or (t.parameter_count=5 and (
      t.tone<>(case coalesce(x.reminder_tone,s.follow_up_preferences->>'tone','professional') when 'gentle' then 'relaxed' when 'relaxed' then 'relaxed' when 'firm' then 'firm' else 'professional' end)
      or (x.reminder_tone is null and (coalesce((s.follow_up_preferences->>'templateButtons')::boolean,false) or s.follow_up_preferences ? 'templateName'))))$new$);
  if definition=before_patch then raise exception 'Reminder gate patch point missing';end if;
  before_patch:=definition;
  definition:=replace(definition,$old$facts:=jsonb_build_array(s.business_name,i.invoice_number,x.name);$old$,$new$if t.parameter_count=5 then
    if x.name ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]' then return '{"authorized":false}';end if;
    facts:=jsonb_build_array(
      coalesce(nullif(split_part(btrim(translate(x.name,U&'\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\202f\205f\3000\feff',repeat(' ',18))),' ',1),''),'there'),
      s.business_name,i.invoice_number,app.reminder_outstanding_text(i.total_amount-i.amount_paid,coalesce(i.currency,'INR')),
      to_char(i.due_date,'DD Mon YYYY'));
  else facts:=jsonb_build_array(s.business_name,i.invoice_number,x.name);end if;$new$);
  if definition=before_patch then raise exception 'Reminder gate patch point missing';end if;
  before_patch:=definition;
  definition:=replace(definition,$old$or position(chr(10) in v)>0 or position(chr(13) in v)>0 or v like '%{%' or v like '%}%'$old$,$new$or length(v)>256 or v ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]'$new$);
  if definition=before_patch then raise exception 'Reminder gate patch point missing';end if;
  before_patch:=definition;
  definition:=replace(definition,$old$for n in 1..3 loop$old$,$new$for n in 1..t.parameter_count loop$new$);
  if definition=before_patch then raise exception 'Reminder gate patch point missing';end if;
  before_patch:=definition;
  definition:=replace(definition,$old$if t.name is null or t.language<>'en' or not t.approved$old$,$new$if t.name is null or t.language<>'en' or not t.approved or t.waba_id<>'1734116767674237'$new$);
  if definition=before_patch then raise exception 'Reminder gate patch point missing';end if;
  execute definition;
  -- Accept the relaxed alias in the existing workspace settings validator.
  definition:=pg_get_functiondef('app.guard_messaging_settings()'::regprocedure);
  before_patch:=definition;
  definition:=replace(definition,$old$('gentle','professional','firm')$old$,$new$('gentle','relaxed','professional','firm')$new$);
  if definition=before_patch then raise exception 'Workspace tone patch point missing';end if;
  execute definition;
end $upgrade$;
commit;
