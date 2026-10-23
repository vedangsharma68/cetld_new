-- Additive extension of the already-applied 20261023061702 contract.
-- Code first, then this complete transaction. No existing proposal or receipt is deleted.
begin;
create table app.reminder_approvals (
 id uuid primary key, workspace_id uuid not null, owner_id uuid not null, invoice_id uuid not null,
 approved_form text not null check(approved_form in ('template','freeform')),
 delivery jsonb not null, approved_text text not null, approved_template jsonb, approved_fallback_template jsonb,
 approved_at timestamptz not null default clock_timestamp(), window_deadline timestamptz,
 dispatch_outcome text not null default 'pending', evaluated_at timestamptz,
 foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id) on delete cascade,
 foreign key(invoice_id) references public.invoices(id) on delete cascade
);
create index reminder_approvals_business_invoice on app.reminder_approvals(workspace_id,invoice_id);
alter table app.reminder_approvals enable row level security;
revoke all on app.reminder_approvals from public,anon,authenticated,service_role;
create table app.reminder_delivery_evaluations (
 id bigint generated always as identity primary key, approval_id uuid not null references app.reminder_approvals(id) on delete cascade,
 claim_id uuid, evaluated_at timestamptz not null default clock_timestamp(), window_deadline timestamptz,
 outcome text not null, delivery_form text, delivery jsonb
);
alter table app.reminder_delivery_evaluations enable row level security;
revoke all on app.reminder_delivery_evaluations from public,anon,authenticated,service_role;

-- Only customer-audience inbound messages can open a service window. Use the
-- provider's event timestamp when present, never a delayed worker processing time.
create function app.reminder_window_deadline(p_workspace_id uuid,p_customer_id uuid,p_phone text) returns timestamptz
language sql stable security definer set search_path='' as $$
 select max(least(m.created_at,coalesce(e.provider_timestamp,e.received_at,m.created_at)))+interval '24 hours'
 from public.whatsapp_messages m left join public.whatsapp_inbound_events e on e.provider_message_id=m.provider_message_id and e.sender_phone=m.phone
 where m.workspace_id=p_workspace_id and m.customer_id=p_customer_id and m.phone=p_phone
 and m.audience='customer' and m.direction='inbound' and m.status='received'
 and m.created_at<=clock_timestamp()
$$;
revoke all on function app.reminder_window_deadline(uuid,uuid,text) from public,anon,authenticated,service_role;

create function app.reminder_template_core(d jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('type','template','name',d->'name','language',d->'language','revision',d->'revision',
 'parameters',d->'parameters','body',d->'body','buttonVariant',d->'buttonVariant')
$$;
revoke all on function app.reminder_template_core(jsonb) from public,anon,authenticated,service_role;

-- Legacy branded approval metadata stays compatible; the outgoing service body
-- remains the exact unnormalized owner-reviewed text in the immutable receipt.
create function app.review_approval_text(body text,business text) returns text language plpgsql immutable set search_path='' as $$
declare b text:=app.normalize_reminder_punctuation(body);n text:=app.normalize_reminder_punctuation(business);
begin
 if b=n then return n;end if;
 if right(b,length(n))=n then return rtrim(left(b,length(b)-length(n)))||E'\n\n'||n;end if;
 return b||E'\n\n'||n;
end $$;
revoke all on function app.review_approval_text(text,text) from public,anon,authenticated,service_role;

-- Rebuild every named parameter from current database facts. Per-message tone
-- selects a catalog artifact at review; no tone regenerates approved words later.
create function app.checked_reminder_template(i public.invoices,s public.workspace_settings,x public.customers,d jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t record; facts jsonb;body text;n integer;
begin
 select * into t from app.first_party_reminder_templates where waba_id='1734116767674237'
 and name=d->>'name' and language=d->>'language' and revision=d->>'revision' and approved for share;
 if not found then return null;end if;
 if t.parameter_count=5 then
  if x.name ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]' then return null;end if;
  facts:=jsonb_build_array(coalesce(nullif(btrim(x.name,U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff'),''),'there'),
   s.business_name,i.invoice_number,app.reminder_outstanding_text(i.total_amount-i.amount_paid,coalesce(i.currency,'INR')),to_char(i.due_date,'DD Mon YYYY'));
 else facts:=jsonb_build_array(s.business_name,i.invoice_number,x.name);end if;
 if facts is distinct from d->'parameters' or exists(select 1 from jsonb_array_elements_text(facts) v where v is null or length(btrim(v)) not between 1 and 256 or v ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]') then return null;end if;
 body:=t.body;for n in 1..t.parameter_count loop body:=replace(body,'{{'||n||'}}',facts->>(n-1));end loop;
 if app.reminder_template_core(d) is distinct from jsonb_build_object('type','template','name',t.name,'language',t.language,'revision',t.revision,'parameters',facts,'body',body,'buttonVariant',t.button_variant) then return null;end if;
 return app.reminder_template_core(d);
end $$;
revoke all on function app.checked_reminder_template(public.invoices,public.workspace_settings,public.customers,jsonb) from public,anon,authenticated,service_role;

create function app.evaluate_reminder_form(d jsonb,deadline timestamptz,at_time timestamptz) returns jsonb
language plpgsql immutable set search_path='' as $$
begin
 if d->>'type'='template' then return jsonb_build_object('ok',true,'form','template','delivery',app.reminder_template_core(d),'windowDeadline',deadline);end if;
 -- Cetld product rule: scheduled reminders are always templates, even in an open service window.
 if d->>'type' is distinct from 'freeform' or d->>'mode' is distinct from 'immediate' then return '{"ok":false,"reason":"delivery_form_review"}';end if;
 if deadline>at_time then return jsonb_build_object('ok',true,'form','freeform','delivery',jsonb_build_object('type','freeform','body',d->'body'),'windowDeadline',deadline);end if;
 if d->'fallback'->>'type'='template' then return jsonb_build_object('ok',true,'form','template_fallback','delivery',app.reminder_template_core(d->'fallback'),'windowDeadline',deadline);end if;
 return '{"ok":false,"reason":"undeliverable_window_expired"}';
end $$;
revoke all on function app.evaluate_reminder_form(jsonb,timestamptz,timestamptz) from public,anon,authenticated,service_role;

-- Preserve #173's complete consent/snapshot/payment/contact gates and signature.
do $preserve$
declare def text;
begin
 def:=pg_get_functiondef('app.owner_assistant_reminder(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean)'::regprocedure);
 def:=replace(def,'app.owner_assistant_reminder(', 'app.owner_assistant_reminder_template_gate(');
 execute def;
end $preserve$;
revoke all on function app.owner_assistant_reminder_template_gate(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;

create or replace function app.owner_assistant_reminder(p_workspace_id uuid,p_owner_id uuid,p_invoice_id uuid,p_send_now boolean,p_preview text,p_approval_text text,p_template jsonb,p_snapshot jsonb,p_apply boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;d jsonb:=p_template->'reviewedDelivery';i public.invoices%rowtype;s public.workspace_settings%rowtype;x public.customers%rowtype;
 deadline timestamptz;core jsonb;fallback jsonb;approval_id uuid;stamp timestamptz:=clock_timestamp();t record;
begin
 if d is null then return app.owner_assistant_reminder_template_gate(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_preview,p_approval_text,p_template,p_snapshot,p_apply);end if;
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then return '{"ok":false,"code":"DENIED"}';end if;
 -- The old gate locks and rechecks every eligibility fact without applying an approval.
 r:=app.owner_assistant_reminder_template_gate(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_template->>'templatePreview',
 app.normalize_reminder_punctuation(p_template->>'templatePreview')||E'\n\n'||(select app.normalize_reminder_punctuation(business_name) from public.workspace_settings where workspace_id=p_workspace_id),p_template,p_snapshot,false);
 if r->>'ok' is distinct from 'true' then return r;end if;
 select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id;
 select * into s from public.workspace_settings where workspace_id=p_workspace_id;
 select * into x from public.customers where workspace_id=p_workspace_id and id=i.customer_id;
 deadline:=app.reminder_window_deadline(p_workspace_id,x.id,x.phone);stamp:=clock_timestamp();
 if d->>'version' is distinct from '2' or d->>'type' not in ('template','freeform') or d->>'tone' not in ('gentle','relaxed','firm','professional')
 or d->>'mode' is distinct from (case when p_send_now then 'immediate' else 'scheduled' end)
 or d->>'body' is distinct from p_preview or length(p_preview) not between 1 and 4000 or d ? 'approvalId' then return '{"ok":false,"code":"INVALID"}';end if;
 -- The tone is frozen to the exact template proposed at review, not business defaults at dispatch.
 select * into t from app.first_party_reminder_templates where waba_id='1734116767674237' and name=p_template->>'name' and revision=p_template->>'revision' and language=p_template->>'language' and approved;
 if not found or t.parameter_count<>5 or t.tone is distinct from (case d->>'tone' when 'gentle' then 'relaxed' else d->>'tone' end) then return '{"ok":false,"code":"template_unavailable"}';end if;
 core:=jsonb_build_object('type','template','name',t.name,'language',t.language,'revision',t.revision,'parameters',p_template->'parameters','body',p_template->'templatePreview','buttonVariant',t.button_variant);
 if app.checked_reminder_template(i,s,x,core) is null then return '{"ok":false,"code":"template_unavailable"}';end if;
 if d->>'type'='template' then
  if app.reminder_template_core(d) is distinct from core or p_approval_text is distinct from app.review_approval_text(p_preview,s.business_name) or d->'fallback' not in ('null'::jsonb) then return '{"ok":false,"code":"INVALID"}';end if;
 else
  if not p_send_now then return '{"ok":false,"code":"scheduled_template_only"}';end if;
  if p_approval_text is distinct from app.review_approval_text(p_preview,s.business_name) or d->>'body' ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' then return '{"ok":false,"code":"INVALID"}';end if;
  if d->'fallback' is not null and d->'fallback'<>'null'::jsonb then
   fallback:=app.checked_reminder_template(i,s,x,d->'fallback');
   if fallback is null or fallback is distinct from core then return '{"ok":false,"code":"INVALID_FALLBACK"}';end if;
  end if;
  -- A deadline snapshot never grants a new window. Confirmation rechecks the current one.
  if deadline is null or deadline<=stamp or (d->>'windowExpiresAt')::timestamptz is distinct from deadline then return '{"ok":false,"code":"undeliverable_window_expired"}';end if;
 end if;
 if not p_apply then return jsonb_build_object('ok',true,'preview',p_preview,'delivery',d,'windowExpiresAt',deadline);end if;
 approval_id:=gen_random_uuid();d:=d||jsonb_build_object('approvalId',approval_id);
 insert into app.reminder_approvals(id,workspace_id,owner_id,invoice_id,approved_form,delivery,approved_text,approved_template,approved_fallback_template,window_deadline,approved_at)
 values(approval_id,p_workspace_id,p_owner_id,p_invoice_id,d->>'type',d,p_preview,case when d->>'type'='template' then core end,fallback,deadline,stamp);
 update public.invoices set metadata=(metadata-'reminder_review_reason')||jsonb_build_object('followup_state','approved','reminder_text',p_approval_text,'reminder_draft_text',p_template->>'dashboardDraft','reminder_draft_tone',d->>'tone','approved_reminder_text',p_approval_text,
 'approved_preferences_updated_at',s.updated_at,'approved_reminder_delivery_reviewed_at',stamp,'approved_reminder_delivery',d,'next_follow_up_at',case when p_send_now then stamp else next_follow_up_at end),
 followup_state='approved',next_follow_up_at=case when p_send_now then stamp else next_follow_up_at end where workspace_id=p_workspace_id and id=i.id returning * into i;
 if i.followup_state<>'approved' or i.metadata->'approved_reminder_delivery' is distinct from d then raise exception 'approval invalidated';end if;
 return jsonb_build_object('ok',true,'completed',true,'action','reminder.approved','invoiceNumber',i.invoice_number,'sendNow',p_send_now,'delivery',d);
end $$;
revoke all on function app.owner_assistant_reminder(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;

create function public.owner_assistant_reminder_window(p_workspace_id uuid,p_owner_id uuid,p_invoice_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype;x public.customers%rowtype;
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'owner required' using errcode='42501';end if;
 select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id and deleted_at is null;
 select * into x from public.customers where workspace_id=p_workspace_id and id=i.customer_id;
 return jsonb_build_object('windowExpiresAt',app.reminder_window_deadline(p_workspace_id,x.id,x.phone));
end $$;
revoke all on function public.owner_assistant_reminder_window(uuid,uuid,uuid) from public,anon;
grant execute on function public.owner_assistant_reminder_window(uuid,uuid,uuid) to authenticated,service_role;

create function public.owner_assistant_reminder_status(p_workspace_id uuid,p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'owner required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('invoiceId',r.invoice_id,'approvalId',r.id,'outcome',r.dispatch_outcome,'evaluatedAt',r.evaluated_at,'followupState',i.followup_state,'reviewReason',i.metadata->>'reminder_review_reason'))
 from app.reminder_approvals r join public.invoices i on i.id=r.invoice_id and i.workspace_id=r.workspace_id
 where r.workspace_id=p_workspace_id and i.metadata#>>'{approved_reminder_delivery,approvalId}'=r.id::text),'[]'::jsonb);
end $$;
revoke all on function public.owner_assistant_reminder_status(uuid,uuid) from public,anon;
grant execute on function public.owner_assistant_reminder_status(uuid,uuid) to authenticated,service_role;

-- Pure selection is shared by preparation and final reservation. The final call
-- additionally records the attempt and holds an undeliverable approval visibly.
create function app.evaluate_reviewed_reminder(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid,p_claim_id uuid,p_snapshot jsonb default null,p_hash text default null,p_record boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype;s public.workspace_settings%rowtype;x public.customers%rowtype;r app.reminder_approvals%rowtype;
 d jsonb;actual jsonb;e jsonb;deadline timestamptz;outcome text;valid boolean;
begin
 select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id;
 select * into s from public.workspace_settings where workspace_id=p_workspace_id;
 select * into x from public.customers where workspace_id=p_workspace_id and id=i.customer_id;
 d:=i.metadata->'approved_reminder_delivery';
 select * into r from app.reminder_approvals where id::text=d->>'approvalId' and workspace_id=p_workspace_id and invoice_id=i.id and owner_id=p_owner_id;
 if r.id is null or r.delivery is distinct from d or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id)
 or i.metadata->>'approved_reminder_text' is distinct from app.review_approval_text(r.approved_text,s.business_name) then
  return '{"authorized":false,"ok":false,"reason":"delivery_form_review"}';end if;
 deadline:=app.reminder_window_deadline(p_workspace_id,x.id,x.phone);
 e:=app.evaluate_reminder_form(d,deadline,clock_timestamp());
 -- An immediate service approval cannot be repurposed as a later schedule.
 if r.approved_form='freeform' and i.next_follow_up_at is distinct from r.approved_at then e:='{"ok":false,"reason":"scheduled_template_only"}';end if;
 actual:=e->'delivery';
 if e->>'ok'='true' and actual->>'type'='template' and app.checked_reminder_template(i,s,x,actual) is null then e:='{"ok":false,"reason":"delivery_form_review"}';end if;
 valid:=e->>'ok'='true';
 if valid and p_snapshot is not null then
  valid:=(
    (d->>'type'='template' and p_snapshot->'delivery' is not distinct from app.reminder_template_core(d) and p_snapshot->>'deliveryForm'='template')
    or (d->>'type'='freeform' and p_snapshot->'delivery' is not distinct from jsonb_build_object('type','freeform','body',d->'body') and p_snapshot->>'deliveryForm'='freeform')
    or (d->>'type'='freeform' and d->'fallback'->>'type'='template' and p_snapshot->'delivery' is not distinct from app.reminder_template_core(d->'fallback') and p_snapshot->>'deliveryForm'='template_fallback'))
   and p_snapshot->>'body' is not distinct from p_snapshot#>>'{delivery,body}'
   and p_snapshot#>>'{template,wabaId}'='1734116767674237' and p_snapshot#>>'{template,phoneNumberId}' ~ '^[0-9]{5,30}$'
   and p_snapshot->>'phone' in ('+919871367051','+919818685252')
   and encode(sha256(convert_to(app.reminder_canonical_json(p_snapshot),'UTF8')),'hex')=p_hash;
  if not coalesce(valid,false) then e:='{"ok":false,"reason":"delivery_form_review"}';end if;
 end if;
 outcome:=case when e->>'ok'='true' then e->>'form' else e->>'reason' end;
 if p_record or e->>'ok' is distinct from 'true' then
  update app.reminder_approvals set dispatch_outcome=outcome,evaluated_at=clock_timestamp() where id=r.id;
  insert into app.reminder_delivery_evaluations(approval_id,claim_id,window_deadline,outcome,delivery_form,delivery)
   values(r.id,p_claim_id,deadline,outcome,e->>'form',actual);
  if e->>'ok' is distinct from 'true' then
   update public.invoices set followup_state='paused',next_follow_up_at=null,
    metadata=metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'reminder_review_reason',outcome)
    where workspace_id=p_workspace_id and id=i.id;
  end if;
 end if;
 return e||jsonb_build_object('authorized',e->>'ok'='true','body',actual->'body');
end $$;
revoke all on function app.evaluate_reviewed_reminder(uuid,uuid,uuid,uuid,jsonb,text,boolean) from public,anon,authenticated,service_role;

create function public.owner_assistant_reminder_dispatch_preview(p_workspace_id uuid,p_owner_id uuid,p_invoice_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service required' using errcode='42501';end if;
 return app.evaluate_reviewed_reminder(p_owner_id,p_workspace_id,p_invoice_id,null);
end $$;
revoke all on function public.owner_assistant_reminder_dispatch_preview(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.owner_assistant_reminder_dispatch_preview(uuid,uuid,uuid) to service_role;

-- Extend the installed gate at its delivery-validation block only. The complete
-- lock/claim/suppression/consent/payment/contact/version/receipt prefix and suffix
-- remain verbatim. Abort rather than partially patch an unexpected definition.
do $dispatch$
declare def text;start_at integer;end_at integer;old_block text;receipt text;marker text;
begin
 if to_regprocedure('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)') is not null then
  def:=pg_get_functiondef('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)'::regprocedure);
  -- A 4,000-character message appears in both body and exact delivery form.
  -- Preserve the legacy size bound after identifying the invoice receipt.
  if position('length(p_snapshot::text)>8000' in def)=0 then raise exception 'Reminder snapshot size patch point changed';end if;
  def:=replace(def,'length(p_snapshot::text)>8000','length(p_snapshot::text)>32768');
  def:=replace(def,'  if i.id is null or c.id is null','  if i.metadata#>>''{approved_reminder_delivery,version}'' is distinct from ''2'' and length(p_snapshot::text)>8000 then return ''{"authorized":false}'';end if;
  if i.id is null or c.id is null');
  start_at:=position('  select * into t from app.first_party_reminder_templates' in def);
  end_at:=position('  token:=encode(sha256' in def);
  if start_at=0 or end_at<=start_at or position('approved_reminder_delivery' in def)=0 then raise exception 'Expected #173 reminder gate is missing';end if;
  old_block:=substring(def from start_at for end_at-start_at);
  def:=replace(def,'payment jsonb;','payment jsonb;review_result jsonb;');
  def:=replace(def,old_block,$new$
  if i.metadata#>>'{approved_reminder_delivery,version}'='2' then
    review_result:=app.evaluate_reviewed_reminder(p_owner_id,p_workspace_id,i.id,c.id,p_snapshot,p_snapshot_hash,true);
    if review_result->>'authorized' is distinct from 'true' then return jsonb_build_object('authorized',false,'reason','needs_re_review','reviewReason',review_result->>'reason');end if;
    -- The reservation may cross the window boundary after JS preparation.
    -- Choose only an already approved artifact, and bind the durable receipt to
    -- the final selected words/form. The provider verifies this returned hash.
    body:=review_result->>'body';
    p_snapshot:=p_snapshot||jsonb_build_object('body',body,'delivery',review_result->'delivery','deliveryForm',review_result->'form');
    p_snapshot_hash:=encode(sha256(convert_to(app.reminder_canonical_json(p_snapshot),'UTF8')),'hex');
  else
$new$||old_block||E'\n  end if;\n');
  marker:=$old$return jsonb_build_object('authorized',true,'snapshot_hash',p_snapshot_hash,'callback_token',token);$old$;
  if position(marker in def)=0 then raise exception 'Reminder gate receipt patch point changed';end if;
  def:=replace(def,marker,$new$return jsonb_build_object('authorized',true,'snapshot_hash',p_snapshot_hash,'callback_token',token)||case when review_result is null then '{}'::jsonb else jsonb_build_object('delivery',review_result->'delivery','deliveryForm',review_result->'form','windowDeadline',review_result->'windowDeadline') end;$new$);
  execute def;
  -- Immediate approvals are one-off sends, never an implicit recurring free-form schedule.
  receipt:=pg_get_functiondef('public.cetld_core_record_first_party_receipt(text,text,text,text,text,text)'::regprocedure);
  marker:='      next_at:=i.next_follow_up_at;';
  if position(marker in receipt)=0 then raise exception 'Reminder receipt patch point changed';end if;
  receipt:=replace(receipt,marker,marker||E'\n      if i.metadata#>>''{approved_reminder_delivery,version}''=''2'' and i.metadata#>>''{approved_reminder_delivery,mode}''=''immediate'' then next_at:=null;end if;');
  marker:='      if i.automation_version=(d.snapshot->>''invoiceVersion'')::bigint and i.followup_state in (''approved'',''active'',''scheduled'')';
  if position(marker in receipt)=0 then raise exception 'Reminder receipt cadence patch point changed';end if;
  receipt:=replace(receipt,marker,marker||E'\n        and not (i.metadata#>>''{approved_reminder_delivery,version}''=''2'' and i.metadata#>>''{approved_reminder_delivery,mode}''=''immediate'')');
  execute receipt;
 end if;
end $dispatch$;

-- Backfill mapping: valid #173 template receipts and their schedules/claims are
-- unchanged. Missing/legacy free-form receipts retain their text/history and
-- become visibly paused for re-review. Pending proposals remain in their shared
-- slot and keep the existing prepare/decide semantics. No approval is deleted.
update public.invoices i set followup_state='paused',next_follow_up_at=null,
 metadata=i.metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'reminder_review_reason','delivery_form_review')
 where i.followup_state in ('approved','active','scheduled') and not exists(
 select 1 from public.workspace_settings s join public.customers x on x.workspace_id=s.workspace_id
 where i.workspace_id=s.workspace_id and x.id=i.customer_id
 and i.metadata#>>'{approved_reminder_delivery,type}'='template'
 and app.checked_reminder_template(i,s,x,i.metadata->'approved_reminder_delivery') is not null);
-- A v2 reminder carries both exact text and the separately reviewed template.
-- Leave other proposal sizes and the single-slot trigger unchanged.
do $proposal_size$
declare def text;old text:='octet_length(p_proposal::text)>32768';
begin
 def:=pg_get_functiondef('public.owner_assistant_propose(uuid,uuid,jsonb)'::regprocedure);
 if position(old in def)=0 then raise exception 'Proposal size patch point changed';end if;
 def:=replace(def,old,'octet_length(p_proposal::text)>(case when p_proposal->>''type''=''owner_reminder'' and p_proposal#>>''{payload,template,reviewedDelivery,version}''=''2'' then 131072 else 32768 end)');
 execute def;
end $proposal_size$;
commit;
