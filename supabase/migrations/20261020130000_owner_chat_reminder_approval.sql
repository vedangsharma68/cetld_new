-- Chat approval uses the existing pending-action CAS and receipt flow.
-- Delivery is exclusively the existing scheduler/claim/authorization pipeline.
begin;
create function public.whatsapp_owner_reminder(
  p_workspace_id uuid,p_owner_id uuid,p_phone text,p_message_id text,p_user_message text,
  p_action text,p_invoice_id uuid default null,p_send_now boolean default false,
  p_preview text default null,p_approval_text text default null,p_template jsonb default null,p_snapshot jsonb default null,
  p_pending_id bigint default null,p_pending_version bigint default null,p_interaction_id text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  o record;e public.whatsapp_inbound_events%rowtype;a public.whatsapp_pending_actions%rowtype;
  i public.invoices%rowtype;s public.workspace_settings%rowtype;x public.customers%rowtype;
  r public.whatsapp_direct_write_receipts%rowtype;v_result jsonb;v_request jsonb;v_generation bigint;v_stored record;
  v_now timestamptz:=clock_timestamp();v_phone text;v_template record;v_body text;v_n integer;v_parameter text;v_payment jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.role(),'')<>'service_role'
    or p_workspace_id is null or p_owner_id is null or p_phone is null or p_phone!~'^\+[1-9][0-9]{7,14}$'
    or p_message_id is null or length(p_message_id) not between 1 and 256 or p_user_message is null or length(p_user_message)>4000
    or p_action is null or p_action not in ('prepare','pending','confirm','cancel') then
    return jsonb_build_object('ok',false,'code','DENIED');end if;
  -- Serialize with owner cancellation, replacement and other confirmed actions.
  perform pg_advisory_xact_lock(hashtextextended(p_phone,0));
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone))<>1 then
    return jsonb_build_object('ok',false,'code','DENIED');end if;
  select * into o from public.whatsapp_resolve_verified_owner(p_phone) b where b.workspace_id=p_workspace_id and b.owner_id=p_owner_id;
  if not found then return jsonb_build_object('ok',false,'code','DENIED');end if;
  select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id and sender_phone=p_phone and status in ('processing','done');
  if not found or e.message_text is distinct from p_user_message then return jsonb_build_object('ok',false,'code','DENIED');end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||o.customer_id::text||':'||p_phone,0));
  v_request:=jsonb_build_object('operation','reminder.'||p_action,'pendingId',p_pending_id,'pendingVersion',p_pending_version,'interactionId',p_interaction_id);
  select * into r from public.whatsapp_direct_write_receipts where provider_message_id=p_message_id;
  if found then
    if r.workspace_id is distinct from p_workspace_id or r.owner_id is distinct from p_owner_id or r.phone is distinct from p_phone or r.request is distinct from v_request then
      return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');end if;
    return r.result||jsonb_build_object('replayed',true);end if;
  select * into a from public.whatsapp_pending_actions b where b.workspace_id=p_workspace_id and b.customer_id=o.customer_id and b.phone=p_phone
    and b.consumed_at is null order by b.generation desc limit 1 for update;
  if p_action='prepare' then
    if a.id is not null and a.action->>'type'='owner_reminder_approval'
      and ((a.action->>'expiresAt')::timestamptz<=v_now or a.created_at<v_now-interval '10 minutes') then
      update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
      if a.action->>'sourceMessageId'=p_message_id then return jsonb_build_object('ok',false,'code','EXPIRED');end if;
      a:=null;
    end if;
    if a.id is not null then
      if a.action->>'type'='owner_reminder_approval' and a.action->>'sourceMessageId'=p_message_id and (a.action->>'invoiceId')::uuid=p_invoice_id then
        return jsonb_build_object('ok',true,'pending',true,'requiresConfirmation',true,'invoiceNumber',a.action->>'invoiceNumber',
          'preview',a.action->>'preview','sendNow',a.action->'sendNow');end if;
      return jsonb_build_object('ok',false,'code','PENDING');end if;
    if p_invoice_id is null or p_interaction_id is not null or p_send_now is null or p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
      or p_preview is null or length(p_preview) not between 1 and 2000 or p_approval_text is null or length(p_approval_text)>4000
      or p_template is null or jsonb_typeof(p_template)<>'object' then return jsonb_build_object('ok',false,'code','INVALID');end if;
  else
    if a.id is null or a.id is distinct from p_pending_id or a.version is distinct from p_pending_version or a.action->>'type' is distinct from 'owner_reminder_approval' then
      return jsonb_build_object('ok',false,'code','NO_PENDING_ACTION');end if;
    if (a.action->>'expiresAt')::timestamptz<=v_now or a.created_at<v_now-interval '10 minutes' then
      update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
      return jsonb_build_object('ok',false,'code','EXPIRED');end if;
    if p_action<>'pending' then
      if a.action->>'sourceMessageId'=p_message_id or e.received_at<a.created_at or coalesce(e.provider_timestamp,e.received_at)+interval '1 second'<a.created_at then
        return jsonb_build_object('ok',false,'code','STALE');end if;
      -- Signed native decisions are verified by the existing server HMAC path.
      if p_interaction_id is not null then
        if e.interaction_id is distinct from p_interaction_id or p_interaction_id!~'^oab1\.' then return jsonb_build_object('ok',false,'code','INVALID');end if;
      elsif p_action='confirm' and p_user_message!~*'^\s*(yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve)\s*[.!]?\s*$'
        or p_action='cancel' and p_user_message!~*'^\s*(no|cancel|never mind|nevermind|discard)\s*[.!]?\s*$' then
        return jsonb_build_object('ok',false,'code','INVALID');end if;
      if p_action='cancel' then
        update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
        v_result:=jsonb_build_object('ok',true,'completed',true,'action','pending.cancelled');
      end if;
    end if;
    p_invoice_id:=(a.action->>'invoiceId')::uuid;p_send_now:=(a.action->>'sendNow')::boolean;
    p_preview:=a.action->>'preview';p_approval_text:=a.action->>'approvalText';p_template:=a.action->'template';p_snapshot:=a.action->'snapshot';
  end if;
  if v_result is null then
    -- Match delivery's phone -> settings -> customer -> invoice lock order.
    select c.phone into v_phone from public.customers c join public.invoices v on v.workspace_id=c.workspace_id and v.customer_id=c.id
      where v.workspace_id=p_workspace_id and v.id=p_invoice_id;
    if v_phone is null or v_phone!~'^\+[1-9][0-9]{7,14}$' then return jsonb_build_object('ok',false,'code','missing_contact');end if;
    perform pg_advisory_xact_lock(hashtextextended(v_phone,0));
    select * into s from public.workspace_settings where workspace_id=p_workspace_id for share;
    select c.* into x from public.customers c where c.workspace_id=p_workspace_id and c.id=(select customer_id from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id) for share;
    select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id for update;
    if i.id is null or i.deleted_at is not null then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
    if s.workspace_id is null or nullif(btrim(s.business_name),'') is null then return jsonb_build_object('ok',false,'code','business_name_required');end if;
    if x.id is distinct from i.customer_id or x.phone is distinct from v_phone then return jsonb_build_object('ok',false,'code','STALE');end if;
    if i.status::text<>'sent' or i.total_amount<=0 or i.amount_paid>=i.total_amount or i.due_date is null or i.metadata->>'invoice_direction' is distinct from 'receivable' then
      return jsonb_build_object('ok',false,'code','ineligible_invoice');end if;
    if i.metadata->'followup_exception' is not null and i.metadata->'followup_exception'<>'null'::jsonb and coalesce(i.metadata->'followup_exception'->>'resolved_at','')='' then
      return jsonb_build_object('ok',false,'code','unresolved_exception');end if;
    if exists(select 1 from public.whatsapp_global_suppressions where phone=v_phone) then return jsonb_build_object('ok',false,'code','globally_suppressed');end if;
    if exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=v_phone) then return jsonb_build_object('ok',false,'code','suppressed');end if;
    if not exists(select 1 from public.whatsapp_consents c where c.workspace_id=p_workspace_id and c.phone=v_phone and c.customer_id=x.id
      and c.revoked_at is null and c.source in ('verbal','inbound_message') and c.categories @> array['invoice_updates']::text[]) then
      return jsonb_build_object('ok',false,'code','missing_consent');end if;
    if i.reminder_count>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then return jsonb_build_object('ok',false,'code','reminder_limit');end if;
    if p_send_now and app.core_next_contact(v_now,s.follow_up_preferences,s.default_timezone)>v_now then return jsonb_build_object('ok',false,'code','contact_hours');end if;
    if exists(select 1 from public.cetld_core_automation_delivery_claims c where c.workspace_id=p_workspace_id and c.invoice_id=i.id and c.status in ('claimed','sending','quarantined')) then
      return jsonb_build_object('ok',false,'code','delivery_in_progress');end if;
    v_payment:=public.cetld_core_check_local_reminder_payment(p_owner_id,p_workspace_id,i.id);
    if v_payment->>'ok' is distinct from 'true' then return jsonb_build_object('ok',false,'code',coalesce(v_payment->>'reason','payment_balance_mismatch'));end if;
    if i.automation_version::text is distinct from p_snapshot->>'invoiceVersion' or i.updated_at is distinct from (p_snapshot->>'invoiceUpdatedAt')::timestamptz
      or s.updated_at is distinct from (p_snapshot->>'settingsUpdatedAt')::timestamptz
      or jsonb_build_object('id',x.id,'name',x.name,'phone',x.phone,'reminder_tone',x.reminder_tone) is distinct from p_snapshot->'customer' then
      return jsonb_build_object('ok',false,'code','STALE');end if;
    -- The private server renders the existing catalog with existing parameter
    -- builders. Never accept a model-authored body, template or greeting here.
    select * into v_template from app.first_party_reminder_templates where waba_id='1734116767674237' and name=p_template->>'name'
      and language=p_template->>'language' and revision=p_template->>'revision' and approved;
    if not found or jsonb_typeof(p_template->'parameters') is distinct from 'array' or jsonb_array_length(p_template->'parameters')<>v_template.parameter_count then
      return jsonb_build_object('ok',false,'code','template_unavailable');end if;
    v_body:=v_template.body;
    for v_n in 1..v_template.parameter_count loop
      v_parameter:=p_template->'parameters'->>(v_n-1);
      if v_parameter is null or length(btrim(v_parameter))=0 or length(v_parameter)>256 or v_parameter ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]' then
        return jsonb_build_object('ok',false,'code','template_unavailable');end if;
      v_body:=replace(v_body,'{{'||v_n::text||'}}',v_parameter);
    end loop;
    if v_body is distinct from p_preview or p_approval_text is distinct from app.normalize_reminder_punctuation(p_preview)||E'\n\n'||app.normalize_reminder_punctuation(s.business_name) then
      return jsonb_build_object('ok',false,'code','template_unavailable');end if;
    if p_action in ('prepare','pending') then
      if p_action='prepare' then
        select coalesce(max(b.generation),0) into v_generation from public.whatsapp_pending_actions b where b.workspace_id=p_workspace_id and b.customer_id=o.customer_id and b.phone=p_phone;
        select * into v_stored from public.whatsapp_store_pending_action(p_workspace_id,o.customer_id,p_phone,
          jsonb_build_object('type','owner_reminder_approval','invoiceId',i.id,'invoiceNumber',i.invoice_number,'sendNow',p_send_now,
            'preview',p_preview,'approvalText',p_approval_text,'template',p_template,'snapshot',p_snapshot,
            'sourceMessageId',p_message_id,'expiresAt',v_now+interval '10 minutes'),'whatsapp',v_generation,null,null);
        if not found then raise exception 'pending action changed';end if;
      end if;
      return jsonb_build_object('ok',true,'pending',true,'proposal',true,'requiresConfirmation',true,'invoiceNumber',i.invoice_number,'preview',p_preview,'sendNow',p_send_now);
    end if;
    -- Exactly the dashboard approval metadata, with now only for Send now.
    -- Existing branded/fact/preference invalidation triggers remain active.
    update public.invoices set metadata=(metadata-'reminder_review_reason')||jsonb_build_object('followup_state','approved',
      'reminder_text',p_approval_text,'approved_reminder_text',p_approval_text,'approved_preferences_updated_at',s.updated_at,
      'next_follow_up_at',case when p_send_now then v_now else next_follow_up_at end),
      followup_state='approved',next_follow_up_at=case when p_send_now then v_now else next_follow_up_at end
      where workspace_id=p_workspace_id and id=i.id returning * into i;
    if i.followup_state<>'approved' or i.metadata->>'approved_reminder_text' is distinct from p_approval_text then raise exception 'approval invalidated';end if;
    update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
    v_result:=jsonb_build_object('ok',true,'completed',true,'action','reminder.approved','invoiceNumber',i.invoice_number,'sendNow',p_send_now);
  end if;
  insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
    values(p_message_id,p_workspace_id,p_owner_id,p_phone,'ownerreminder_'||md5(p_message_id),v_request,v_result);
  return v_result;
end $$;
revoke all on function public.whatsapp_owner_reminder(uuid,uuid,text,text,text,text,uuid,boolean,text,text,jsonb,jsonb,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.whatsapp_owner_reminder(uuid,uuid,text,text,text,text,uuid,boolean,text,text,jsonb,jsonb,bigint,bigint,text) to service_role;
commit;
