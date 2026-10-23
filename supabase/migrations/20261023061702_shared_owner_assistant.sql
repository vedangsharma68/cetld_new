-- Deploy code first, then apply this entire transaction. No customer history is imported.
begin;
create table public.owner_assistant_turns (
 id bigint generated always as identity primary key,
 workspace_id uuid not null, owner_id uuid not null,
 event_key text not null check(length(event_key) between 1 and 512),
 channel text not null check(channel in ('web','whatsapp')),
 role text not null check(role in ('user','assistant')),
 content text not null check(length(content) between 1 and 4000),
 pending_action jsonb, source_message_id text, created_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id) on delete cascade,
 unique(workspace_id,owner_id,event_key)
);
create index owner_assistant_turns_recent on public.owner_assistant_turns(workspace_id,owner_id,id desc);
create table public.owner_assistant_proposals (
 id uuid primary key,workspace_id uuid not null,owner_id uuid not null,
 action jsonb not null check(jsonb_typeof(action)='object'),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default (clock_timestamp()+interval '10 minutes'),
 state text not null default 'pending' check(state in ('pending','confirmed','cancelled','expired')),
 result jsonb,
 foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id) on delete cascade
);
create unique index owner_assistant_one_pending on public.owner_assistant_proposals(workspace_id,owner_id) where state='pending';
alter table public.owner_assistant_turns enable row level security;
alter table public.owner_assistant_turns force row level security;
alter table public.owner_assistant_proposals enable row level security;
alter table public.owner_assistant_proposals force row level security;
revoke all on public.owner_assistant_turns,public.owner_assistant_proposals from public,anon,authenticated;
grant select on public.owner_assistant_turns,public.owner_assistant_proposals to authenticated;
create policy owner_assistant_turns_read on public.owner_assistant_turns for select to authenticated
 using(owner_id=(select auth.uid()) and exists(select 1 from public.workspaces w join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id and m.role='owner' where w.id=owner_assistant_turns.workspace_id and w.owner_id=(select auth.uid())));
create policy owner_assistant_proposals_read on public.owner_assistant_proposals for select to authenticated
 using(owner_id=(select auth.uid()) and exists(select 1 from public.workspaces w join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id and m.role='owner' where w.id=owner_assistant_proposals.workspace_id and w.owner_id=(select auth.uid())));

-- Preserve only currently verified OWNER transcript; never infer ownership
-- from customer rows, shared phones, or customer-audience messages.
insert into public.owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content,created_at,source_message_id)
select workspace_id,owner_id,case when direction='inbound' and provider_message_id is not null then 'wa:'||provider_message_id||':user' when direction='outbound' and idempotency_key like 'reply:%' then 'wa:'||substr(idempotency_key,7)||':assistant' else 'wa-message:'||id::text end,'whatsapp',case when direction='inbound' then 'user' else 'assistant' end,left(body,4000),created_at,case when direction='inbound' then provider_message_id else null end
from (
 select m.*,w.owner_id,row_number() over(partition by w.id,w.owner_id order by m.created_at desc,m.id desc) as position
 from public.whatsapp_messages m join public.workspaces w on w.id=m.workspace_id
 join public.workspace_settings s on s.workspace_id=w.id and s.whatsapp_owner_phone=m.phone
 join lateral public.whatsapp_resolve_verified_owner(m.phone) b on b.workspace_id=w.id and b.owner_id=w.owner_id
 where m.audience='owner' and m.direction in ('inbound','outbound') and m.status in ('received','accepted','sent','delivered','read')
 and m.created_at>=(select max(v.verified_at) from public.whatsapp_owner_verifications v where v.workspace_id=w.id and v.requested_by=w.owner_id and v.phone=m.phone and v.verified_at is not null)
 and coalesce(m.idempotency_key,'') not like 'ack:%' and length(btrim(m.body))>0
) recent where position<=20 order by created_at,id on conflict do nothing;

create function app.owner_assistant_authorized(p_workspace_id uuid,p_owner_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_workspace_id is not null and p_owner_id is not null
 and (auth.role()='service_role' or (auth.role()='authenticated' and auth.uid()=p_owner_id))
 and exists(select 1 from public.workspaces w join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id
   where w.id=p_workspace_id and w.owner_id=p_owner_id and m.role='owner');
$$;
revoke all on function app.owner_assistant_authorized(uuid,uuid) from public,anon,authenticated,service_role;
create function public.owner_assistant_history(p_workspace_id uuid,p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'owner required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from
   (select id,event_key,role,content,channel,pending_action,created_at,source_message_id from public.owner_assistant_turns
    where workspace_id=p_workspace_id and owner_id=p_owner_id order by id desc limit 20) t),'[]'::jsonb);
end $$;
create function public.owner_assistant_append(p_workspace_id uuid,p_owner_id uuid,p_event_key text,p_channel text,p_role text,p_content text,p_pending_action jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.owner_assistant_turns%rowtype;
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'owner required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||p_owner_id::text||':assistant',0));
 insert into public.owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content,pending_action,source_message_id)
 values(p_workspace_id,p_owner_id,p_event_key,p_channel,p_role,p_content,p_pending_action,case when p_channel='whatsapp' and p_role='user' and p_event_key like 'wa:%:user' then substring(p_event_key from 4 for length(p_event_key)-8) else null end) on conflict do nothing returning * into t;
 if not found then
  select * into t from public.owner_assistant_turns where workspace_id=p_workspace_id and owner_id=p_owner_id and event_key=p_event_key;
  if t.role is distinct from p_role or t.channel is distinct from p_channel or (p_role='user' and t.content is distinct from p_content) then raise exception 'turn replay mismatch';end if;
  if p_role='assistant' and t.content is distinct from p_content then
   insert into public.owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content,pending_action)
   values(p_workspace_id,p_owner_id,p_event_key||':'||md5(p_content),p_channel,p_role,p_content,p_pending_action) on conflict do nothing;
  end if;
 end if;
 delete from public.owner_assistant_turns where workspace_id=p_workspace_id and owner_id=p_owner_id and id in
  (select id from public.owner_assistant_turns where workspace_id=p_workspace_id and owner_id=p_owner_id order by id desc offset 20);
 return jsonb_build_object('id',t.id);
end $$;
create function public.owner_assistant_pending(p_workspace_id uuid,p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'owner required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||p_owner_id::text||':assistant',0));
 update public.owner_assistant_proposals set state='expired' where workspace_id=p_workspace_id and owner_id=p_owner_id and state='pending' and expires_at<=clock_timestamp();
 update public.owner_assistant_turns t set pending_action=jsonb_set(t.pending_action,'{status}','"expired"') where t.workspace_id=p_workspace_id and t.owner_id=p_owner_id and exists(select 1 from public.owner_assistant_proposals p where p.id::text=t.pending_action->>'proposalId' and p.state='expired');
 return (select to_jsonb(p) from public.owner_assistant_proposals p where workspace_id=p_workspace_id and owner_id=p_owner_id and state='pending');
end $$;
create function public.owner_assistant_propose(p_workspace_id uuid,p_owner_id uuid,p_proposal jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.owner_assistant_proposals%rowtype;
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'owner required' using errcode='42501';end if;
 perform public.owner_assistant_pending(p_workspace_id,p_owner_id);
 if jsonb_typeof(p_proposal) is distinct from 'object' or p_proposal->>'type' not in ('owner_reminder','owner_payment','owner_correction','owner_schedule','create_invoice','update_invoice')
  or octet_length(p_proposal::text)>32768 then raise exception 'invalid proposal';end if;
 select * into p from public.owner_assistant_proposals where workspace_id=p_workspace_id and owner_id=p_owner_id and id=(p_proposal->>'id')::uuid;
 if found then
  if p.action is distinct from p_proposal then raise exception 'proposal replay mismatch';end if;
  return to_jsonb(p);
 end if;
 if exists(select 1 from public.workspace_settings s
  join lateral public.whatsapp_resolve_verified_owner(s.whatsapp_owner_phone) b on b.workspace_id=s.workspace_id and b.owner_id=p_owner_id
  join public.whatsapp_pending_actions a on a.workspace_id=b.workspace_id and a.customer_id=b.customer_id and a.phone=s.whatsapp_owner_phone
  where s.workspace_id=p_workspace_id and a.consumed_at is null and not (a.action->>'type'='invoice_review_draft' and a.action->>'stage' in ('saved','canceled'))) then
  return jsonb_build_object('code','PENDING');
 end if;
 insert into public.owner_assistant_proposals(id,workspace_id,owner_id,action)
 values((p_proposal->>'id')::uuid,p_workspace_id,p_owner_id,p_proposal) returning * into p;
 return to_jsonb(p);
end $$;

-- Native WhatsApp proposals and web proposals share one approval slot. Acquire
-- the thread lock without waiting: native RPCs already hold phone/row locks,
-- and a web reminder decision can hold the thread lock before taking those.
create function app.guard_owner_assistant_pending() returns trigger
language plpgsql security definer set search_path='' as $$
declare b record;
begin
 if new.consumed_at is not null or (new.action->>'type'='invoice_review_draft' and new.action->>'stage' in ('saved','canceled')) then return new;end if;
 select * into b from public.whatsapp_resolve_verified_owner(new.phone) o
  where o.workspace_id=new.workspace_id and o.customer_id=new.customer_id;
 if not found then return new;end if;
 if not pg_try_advisory_xact_lock(hashtextextended(new.workspace_id::text||':'||b.owner_id::text||':assistant',0)) then
  raise exception 'owner approval busy; retry' using errcode='40001';end if;
 if exists(select 1 from public.owner_assistant_proposals p where p.workspace_id=new.workspace_id and p.owner_id=b.owner_id and p.state='pending' and p.expires_at>clock_timestamp()) then
  raise exception 'finish or cancel the pending owner approval first' using errcode='40001';end if;
 return new;
end $$;
revoke all on function app.guard_owner_assistant_pending() from public,anon,authenticated,service_role;
create trigger guard_owner_assistant_pending before insert or update of action,consumed_at on public.whatsapp_pending_actions
 for each row execute function app.guard_owner_assistant_pending();

-- One gate implementation for both channels, including consent, STOP, contact
-- hours, payment audit, in-flight delivery, snapshot and approved-template checks.
create function app.owner_assistant_reminder(
 p_workspace_id uuid,p_owner_id uuid,p_invoice_id uuid,p_send_now boolean,p_preview text,p_approval_text text,p_template jsonb,p_snapshot jsonb,p_apply boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype;s public.workspace_settings%rowtype;x public.customers%rowtype;
 v_phone text;v_now timestamptz:=clock_timestamp();v_payment jsonb;v_template record;v_body text;v_n integer;v_parameter text;
begin
 if p_send_now is null or p_apply is null or p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
  or p_template is null or jsonb_typeof(p_template)<>'object' or p_preview is null or p_approval_text is null then
  return jsonb_build_object('ok',false,'code','INVALID');end if;
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

 if not p_apply then return jsonb_build_object('ok',true,'requiresConfirmation',true,'invoiceNumber',i.invoice_number,'preview',p_preview,'sendNow',p_send_now);end if;
    -- Exactly the dashboard approval metadata, with now only for Send now.
    -- Existing branded/fact/preference invalidation triggers remain active.
    update public.invoices set metadata=(metadata-'reminder_review_reason')||jsonb_build_object('followup_state','approved',
      'reminder_text',p_approval_text,'approved_reminder_text',p_approval_text,'approved_preferences_updated_at',s.updated_at,
      'approved_reminder_delivery_reviewed_at',v_now,'approved_reminder_delivery',jsonb_build_object('type','template','name',p_template->>'name','language',p_template->>'language','revision',p_template->>'revision','parameters',p_template->'parameters','body',p_preview,'buttonVariant',v_template.button_variant),
      'next_follow_up_at',case when p_send_now then v_now else next_follow_up_at end),
      followup_state='approved',next_follow_up_at=case when p_send_now then v_now else next_follow_up_at end
      where workspace_id=p_workspace_id and id=i.id returning * into i;
    if i.followup_state<>'approved' or i.metadata->>'approved_reminder_text' is distinct from p_approval_text then raise exception 'approval invalidated';end if;

 return jsonb_build_object('ok',true,'completed',true,'action','reminder.approved','invoiceNumber',i.invoice_number,'sendNow',p_send_now);
end $$;
revoke all on function app.owner_assistant_reminder(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;
create or replace function public.whatsapp_owner_reminder(
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
    v_result:=app.owner_assistant_reminder(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_preview,p_approval_text,p_template,p_snapshot,p_action='confirm');
    if v_result->>'ok' is distinct from 'true' then return v_result;end if;
    if p_action in ('prepare','pending') then
      if p_action='prepare' then
        select coalesce(max(b.generation),0) into v_generation from public.whatsapp_pending_actions b where b.workspace_id=p_workspace_id and b.customer_id=o.customer_id and b.phone=p_phone;
        select * into v_stored from public.whatsapp_store_pending_action(p_workspace_id,o.customer_id,p_phone,
          jsonb_build_object('type','owner_reminder_approval','invoiceId',p_invoice_id,'invoiceNumber',v_result->>'invoiceNumber','sendNow',p_send_now,
            'preview',p_preview,'approvalText',p_approval_text,'template',p_template,'snapshot',p_snapshot,
            'sourceMessageId',p_message_id,'expiresAt',v_now+interval '10 minutes'),'whatsapp',v_generation,null,null);
        if not found then raise exception 'pending action changed';end if;
      end if;
      return jsonb_build_object('ok',true,'pending',true,'proposal',true,'requiresConfirmation',true,'invoiceNumber',v_result->>'invoiceNumber','preview',p_preview,'sendNow',p_send_now);
    end if;
    update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
  end if;
  insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
    values(p_message_id,p_workspace_id,p_owner_id,p_phone,'ownerreminder_'||md5(p_message_id),v_request,v_result);
  return v_result;
end $$;
revoke all on function public.whatsapp_owner_reminder(uuid,uuid,text,text,text,text,uuid,boolean,text,text,jsonb,jsonb,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.whatsapp_owner_reminder(uuid,uuid,text,text,text,text,uuid,boolean,text,text,jsonb,jsonb,bigint,bigint,text) to service_role;
create function public.owner_assistant_preview_reminder(p_workspace_id uuid,p_owner_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'owner required' using errcode='42501';end if;
 return app.owner_assistant_reminder(p_workspace_id,p_owner_id,(p_payload->>'invoiceId')::uuid,(p_payload->>'sendNow')::boolean,
   p_payload->>'preview',p_payload->>'approvalText',p_payload->'template',p_payload->'snapshot',false);
end $$;
create function public.owner_assistant_decide(p_workspace_id uuid,p_owner_id uuid,p_id uuid,p_confirmed boolean,p_phone text default null,p_message_id text default null,p_user_message text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.owner_assistant_proposals%rowtype;i public.invoices%rowtype;s public.workspace_settings%rowtype;
 v jsonb;r jsonb;facts jsonb;payment public.payments%rowtype;old_sub text:=current_setting('request.jwt.claim.sub',true);
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) or p_confirmed is null then return jsonb_build_object('ok',false,'code','DENIED');end if;
 -- Service calls are only decisions received from this owner's verified phone.
 if auth.role()='service_role' and (p_phone is null or p_message_id is null
  or not exists(select 1 from public.whatsapp_resolve_verified_owner(p_phone) o where o.workspace_id=p_workspace_id and o.owner_id=p_owner_id)
  or not exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_message_id and e.sender_phone=p_phone
   and e.message_text=p_user_message and e.status in ('processing','done'))
  or (p_confirmed and p_user_message!~*'^\s*(yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve)\s*[.!]?\s*$')
  or (not p_confirmed and p_user_message!~*'^\s*(no|cancel|never mind|nevermind|discard)\s*[.!]?\s*$')) then return jsonb_build_object('ok',false,'code','DENIED');end if;
 perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||p_owner_id::text||':assistant',0));
 select * into p from public.owner_assistant_proposals where workspace_id=p_workspace_id and owner_id=p_owner_id and id=p_id for update;
 if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
 if p.state='confirmed' and p_confirmed then return p.result||jsonb_build_object('replayed',true);end if;
 if p.state<>'pending' then return jsonb_build_object('ok',false,'code','NO_PENDING_ACTION');end if;
 if p.expires_at<=clock_timestamp() then update public.owner_assistant_proposals set state='expired' where id=p.id;return jsonb_build_object('ok',false,'code','EXPIRED');end if;
 if auth.role()='service_role' and exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_message_id
   and (e.received_at<p.created_at or coalesce(e.provider_timestamp,e.received_at)+interval '1 second'<p.created_at)) then return jsonb_build_object('ok',false,'code','STALE');end if;
 if not p_confirmed then
  if p.action->>'confirmationToken' is not null then
   r:=public.owner_assistant_claim_token(p_workspace_id,p_owner_id,p.action->>'confirmationToken',false);
   if r->>'ok' is distinct from 'true' then return jsonb_build_object('ok',false,'code','ALREADY_STARTED');end if;
  end if;
  update public.owner_assistant_proposals set state='cancelled' where id=p.id;
  update public.owner_assistant_turns set pending_action=jsonb_set(pending_action,'{status}','"cancelled"') where workspace_id=p_workspace_id and owner_id=p_owner_id and pending_action->>'proposalId'=p.id::text;
  return jsonb_build_object('ok',true,'completed',true,'answer','Canceled. No change was made.');
 end if;
 v:=p.action->'payload';
 if p.action->>'type'='owner_reminder' then
  r:=app.owner_assistant_reminder(p_workspace_id,p_owner_id,(v->>'invoiceId')::uuid,(v->>'sendNow')::boolean,v->>'preview',v->>'approvalText',v->'template',v->'snapshot',true);
  if r->>'ok'='true' then r:=r||jsonb_build_object('answer',case when (v->>'sendNow')::boolean then 'Approved and queued the reminder. The scheduler will recheck all delivery requirements. It has not been sent yet.' else 'Approved the reminder draft. Delivery follows your WhatsApp settings. It has not been sent yet.' end);end if;
 elsif p.action->>'type'='owner_correction' then
  r:=app.apply_owner_invoice_correction(p_workspace_id,p_owner_id,(v->>'invoiceId')::uuid,(v->>'updatedAt')::timestamptz,v->'values','dashboard',p.id::text);
  if r->>'ok'='true' then r:=jsonb_build_object('ok',true,'completed',true,'updated',true,'answer','Updated the invoice. Its correction audit and payment history were retained.');end if;
 elsif p.action->>'type'='owner_schedule' then
  select * into s from public.workspace_settings where workspace_id=p_workspace_id for update;
  if s.updated_at is distinct from (v->>'updatedAt')::timestamptz then return jsonb_build_object('ok',false,'code','STALE');end if;
  if jsonb_typeof(v->'patch') is distinct from 'object' or v->'patch'='{}'::jsonb or exists(select 1 from jsonb_object_keys(v->'patch') k where k not in
   ('tone','maxReminders','cadenceDays','firstReminderDays','contactStart','contactEnd','allowedWeekdays','pauseOnReply','dailySummary')) then return jsonb_build_object('ok',false,'code','INVALID');end if;
  -- The existing settings validation and approval-invalidation triggers run.
  update public.workspace_settings set follow_up_preferences=follow_up_preferences||(v->'patch') where workspace_id=p_workspace_id;
  r:=jsonb_build_object('ok',true,'completed',true,'answer','Updated the follow-up schedule. Existing reminder approvals need review again.');
 elsif p.action->>'type'='owner_payment' then
  select * into i from public.invoices where workspace_id=p_workspace_id and id=(v->>'invoiceId')::uuid for update;
  if not found or i.updated_at is distinct from (v->>'updatedAt')::timestamptz then return jsonb_build_object('ok',false,'code','STALE');end if;
  facts:=app.owner_payment_instruction(p.action->>'instruction');
  if facts is null or facts->>'currency' is distinct from i.currency or (facts->>'amount')::numeric is distinct from (v->>'amount')::numeric
   or not exists(select 1 from unnest(array[i.invoice_number,i.metadata->>'printed_invoice_number',i.metadata->>'source_invoice_number']) ref where lower(ref)=lower(facts->>'invoiceNumber'))
   or (facts->>'customerName' is not null and not exists(select 1 from public.customers c where c.workspace_id=p_workspace_id and c.id=i.customer_id and lower(c.name)=lower(facts->>'customerName')))
   or (facts?'expectedOutstanding' and i.total_amount-i.amount_paid-(facts->>'amount')::numeric<>(facts->>'expectedOutstanding')::numeric)
   then return jsonb_build_object('ok',false,'code','INVALID_PAYMENT');end if;
  perform set_config('request.jwt.claim.sub',p_owner_id::text,true);
  payment:=public.record_invoice_payment(p_workspace_id,i.id,(v->>'amount')::numeric,'owner_assistant_'||p.id::text,'Confirmed by business owner in chat',false);
  perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
  r:=jsonb_build_object('ok',true,'completed',true,'answer','Recorded '||i.currency||' '||payment.amount::text||' against invoice '||i.invoice_number||'.');
 else return jsonb_build_object('ok',false,'code','INVALID');end if;
 if r->>'ok' is distinct from 'true' then return r;end if;
 update public.owner_assistant_proposals set state='confirmed',result=r where id=p.id;
 update public.owner_assistant_turns set pending_action=jsonb_set(pending_action,'{status}','"confirmed"') where workspace_id=p_workspace_id and owner_id=p_owner_id and pending_action->>'proposalId'=p.id::text;
 return r;
exception when others then
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
 return jsonb_build_object('ok',false,'code','UNAVAILABLE');
end $$;
create table public.owner_assistant_token_receipts (
 workspace_id uuid not null,owner_id uuid not null,token_hash text not null,
 state text not null check(state in ('executing','confirmed','cancelled')),result jsonb,
 created_at timestamptz not null default clock_timestamp(),
 primary key(workspace_id,owner_id,token_hash),
 foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id) on delete cascade
);
alter table public.owner_assistant_token_receipts enable row level security;
alter table public.owner_assistant_token_receipts force row level security;
revoke all on public.owner_assistant_token_receipts from public,anon,authenticated,service_role;
create function public.owner_assistant_claim_token(p_workspace_id uuid,p_owner_id uuid,p_token text,p_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h text;r public.owner_assistant_token_receipts%rowtype;
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) or p_confirmed is null or p_token is null or length(p_token)>16000 then raise exception 'owner required' using errcode='42501';end if;
 h:=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||p_owner_id::text||':'||h,0));
 select * into r from public.owner_assistant_token_receipts where workspace_id=p_workspace_id and owner_id=p_owner_id and token_hash=h for update;
 if found then
  if r.state='cancelled' then return jsonb_build_object('ok',not p_confirmed,'cancelled',true);end if;
  if not p_confirmed then return jsonb_build_object('ok',false,'code','ALREADY_STARTED');end if;
  if r.state='confirmed' then return jsonb_build_object('ok',true,'replayed',true,'result',r.result);end if;
 else
  insert into public.owner_assistant_token_receipts(workspace_id,owner_id,token_hash,state) values(p_workspace_id,p_owner_id,h,case when p_confirmed then 'executing' else 'cancelled' end);
 end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.owner_assistant_claim_token(uuid,uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.owner_assistant_claim_token(uuid,uuid,text,boolean) to authenticated,service_role;

create function public.owner_assistant_resolve_token(p_workspace_id uuid,p_owner_id uuid,p_token text,p_status text,p_result jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) or p_status not in ('confirmed','cancelled') then raise exception 'owner required' using errcode='42501';end if;
 if p_status='confirmed' then
  update public.owner_assistant_token_receipts set state='confirmed',result=p_result where workspace_id=p_workspace_id and owner_id=p_owner_id and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and state='executing';
  if not found then raise exception 'confirmation was not claimed';end if;
 end if;
 update public.owner_assistant_proposals set state=p_status,result=p_result where workspace_id=p_workspace_id and owner_id=p_owner_id and action->>'confirmationToken'=p_token and state='pending';
 update public.owner_assistant_turns set pending_action=jsonb_set(pending_action,'{status}',to_jsonb(p_status))
 where workspace_id=p_workspace_id and owner_id=p_owner_id and pending_action->>'confirmationToken'=p_token;
end $$;
revoke all on function public.owner_assistant_history(uuid,uuid),public.owner_assistant_append(uuid,uuid,text,text,text,text,jsonb),
 public.owner_assistant_pending(uuid,uuid),public.owner_assistant_propose(uuid,uuid,jsonb),
 public.owner_assistant_preview_reminder(uuid,uuid,jsonb),public.owner_assistant_decide(uuid,uuid,uuid,boolean,text,text,text),
 public.owner_assistant_resolve_token(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.owner_assistant_history(uuid,uuid),public.owner_assistant_append(uuid,uuid,text,text,text,text,jsonb),
 public.owner_assistant_pending(uuid,uuid),public.owner_assistant_propose(uuid,uuid,jsonb),
 public.owner_assistant_preview_reminder(uuid,uuid,jsonb),public.owner_assistant_decide(uuid,uuid,uuid,boolean,text,text,text),
 public.owner_assistant_resolve_token(uuid,uuid,text,text,jsonb) to authenticated,service_role;

create function public.owner_assistant_require_reminder_review(p_workspace_id uuid,p_owner_id uuid,p_invoice_id uuid,p_expected_version bigint) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if auth.role()<>'service_role' or not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then return false;end if;
 update public.invoices set followup_state='paused',next_follow_up_at=null,
  metadata=metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'reminder_review_reason','delivery_form_review')
 where workspace_id=p_workspace_id and id=p_invoice_id and automation_version=p_expected_version and deleted_at is null;
 return found;
end $$;
revoke all on function public.owner_assistant_require_reminder_review(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.owner_assistant_require_reminder_review(uuid,uuid,uuid,bigint) to service_role;
-- Transport persistence is also a memory write boundary. This covers retries,
-- durable reply receipts, and inbound turns recorded before a worker starts.
create function app.sync_owner_assistant_whatsapp_turn() returns trigger
language plpgsql security definer set search_path='' as $$
declare b record;k text;r text;
begin
 if new.audience is distinct from 'owner' or new.direction not in ('inbound','outbound')
  or new.status not in ('received','pending','accepted','sent','delivered','read')
  or coalesce(new.idempotency_key,'') like 'ack:%' or nullif(btrim(new.body),'') is null then return new;end if;
 select * into b from public.whatsapp_resolve_verified_owner(new.phone) o where o.workspace_id=new.workspace_id;
 if not found then return new;end if;
 r:=case when new.direction='inbound' then 'user' else 'assistant' end;
 k:=case when new.direction='inbound' and new.provider_message_id is not null then 'wa:'||new.provider_message_id||':user'
  when new.direction='outbound' and new.idempotency_key like 'reply:%' then 'wa:'||substr(new.idempotency_key,7)||':assistant'
  else 'wa-message:'||new.id::text end;
 perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text||':'||b.owner_id::text||':assistant',0));
 insert into public.owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content,created_at,source_message_id)
 values(new.workspace_id,b.owner_id,k,'whatsapp',r,left(new.body,4000),new.created_at,case when new.direction='inbound' then new.provider_message_id else null end)
 on conflict do nothing;
 delete from public.owner_assistant_turns where workspace_id=new.workspace_id and owner_id=b.owner_id and id in
  (select id from public.owner_assistant_turns where workspace_id=new.workspace_id and owner_id=b.owner_id order by id desc offset 20);
 return new;
end $$;
revoke all on function app.sync_owner_assistant_whatsapp_turn() from public,anon,authenticated,service_role;
create trigger whatsapp_owner_shared_conversation after insert or update of status,body on public.whatsapp_messages
 for each row execute function app.sync_owner_assistant_whatsapp_turn();

-- A later free-form edit/approval cannot inherit an older template approval.
create function app.guard_owner_assistant_delivery_review() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.metadata->>'approved_reminder_text' is distinct from old.metadata->>'approved_reminder_text'
  and new.metadata->'approved_reminder_delivery' is not distinct from old.metadata->'approved_reminder_delivery'
  and new.metadata->'approved_reminder_delivery_reviewed_at' is not distinct from old.metadata->'approved_reminder_delivery_reviewed_at' then
  new.metadata:=new.metadata-'approved_reminder_delivery'-'approved_reminder_delivery_reviewed_at';
 end if;
 return new;
end $$;
revoke all on function app.guard_owner_assistant_delivery_review() from public,anon,authenticated,service_role;
create trigger zzz_owner_assistant_delivery_review before update of metadata on public.invoices
 for each row execute function app.guard_owner_assistant_delivery_review();

-- The old scheduler could replace approved free-form words during prepare.
-- Deny that change at the last atomic gate too, including immediate/retry paths.
do $delivery_gate$
declare definition text;marker text:=$marker$  token:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');$marker$;
begin
 if to_regprocedure('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)') is not null then
  definition:=replace(pg_get_functiondef('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)'::regprocedure),chr(13),'');
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then raise exception 'Reminder delivery gate patch point changed; no changes applied';end if;
  definition:=replace(definition,marker,$guard$
  if i.metadata->'approved_reminder_delivery' is distinct from jsonb_build_object(
    'type','template','name',t.name,'language',t.language,'revision',t.revision,'parameters',facts,'body',body,'buttonVariant',t.button_variant)
    or p_snapshot->'delivery' is distinct from i.metadata->'approved_reminder_delivery'
    or i.metadata->>'approved_reminder_text' is distinct from app.normalize_reminder_punctuation(body)||E'\n\n'||app.normalize_reminder_punctuation(s.business_name) then
    update public.invoices set followup_state='paused',next_follow_up_at=null,
      metadata=metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'reminder_review_reason','delivery_form_review') where id=i.id and workspace_id=p_workspace_id;
    return '{"authorized":false,"reason":"needs_re_review"}';
  end if;
$guard$||marker);
  execute definition;
 end if;
 -- If this gate is absent, no first-party dispatch is possible. The JS provider
 -- independently requires the exact approved form, with no legacy fallback.
end $delivery_gate$;
commit;
