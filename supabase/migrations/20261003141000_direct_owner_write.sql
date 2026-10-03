-- Explicit verified-owner WhatsApp instructions commit atomically with a
-- provider-message-bound receipt. Button clicks use the current persisted
-- pending action and DB version, never model-supplied operation values.
begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.whatsapp_pending_actions') is null
     or pg_catalog.to_regclass('public.whatsapp_inbound_events') is null
     or pg_catalog.to_regclass('public.whatsapp_workspace_data_proposals') is null
     or pg_catalog.to_regclass('public.invoice_lifecycle_proposals') is null
     or pg_catalog.to_regprocedure('public.whatsapp_resolve_verified_owner(text)') is null
     or pg_catalog.to_regprocedure('public.whatsapp_confirm_owner_create_settings(uuid,uuid,text,bigint,bigint,text)') is null
     or pg_catalog.to_regprocedure('public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)') is null
     or pg_catalog.to_regprocedure('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)') is null then
    raise exception 'direct owner write prerequisites are missing';
  end if;
end;
$preflight$;

create table public.whatsapp_direct_write_receipts (
  provider_message_id text primary key check (length(provider_message_id) between 1 and 256),
  workspace_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{12,120}$'),
  request jsonb not null check (jsonb_typeof(request) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (workspace_id, owner_id) references public.workspaces(id, owner_id) on delete cascade,
  unique (workspace_id, owner_id, idempotency_key)
);
alter table public.whatsapp_direct_write_receipts enable row level security;
alter table public.whatsapp_direct_write_receipts force row level security;
revoke all on public.whatsapp_direct_write_receipts from public, anon, authenticated;
grant select, insert on public.whatsapp_direct_write_receipts to service_role;

create or replace function public.whatsapp_apply_direct_owner_write(
  p_workspace_id uuid,
  p_owner_id uuid,
  p_phone text,
  p_provider_message_id text,
  p_interaction_id text,
  p_idempotency_key text,
  p_operation text,
  p_target_id uuid,
  p_expected_updated_at timestamptz,
  p_authorization_kind text,
  p_authorization_quote text,
  p_button_decision text,
  p_pending_id bigint,
  p_pending_version bigint,
  p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_owner record;
  v_event public.whatsapp_inbound_events%rowtype;
  v_receipt public.whatsapp_direct_write_receipts%rowtype;
  v_pending public.whatsapp_pending_actions%rowtype;
  v_lifecycle public.invoice_lifecycle_proposals%rowtype;
  v_proposal public.whatsapp_workspace_data_proposals%rowtype;
  v_invoice public.invoices%rowtype;
  v_customer public.customers%rowtype;
  v_settings public.workspace_settings%rowtype;
  v_ai public.workspace_ai_settings%rowtype;
  v_operation text := p_operation;
  v_payload jsonb := coalesce(p_payload,'{}'::jsonb);
  v_request jsonb;
  v_outcome jsonb;
  v_record jsonb;
  v_result jsonb;
  v_entity_type text;
  v_entity_id text;
  v_action text;
  v_updated_at timestamptz;
  v_phone_customer_id uuid;
  v_match_count integer;
  v_customer_name text;
  v_customer_email text;
  v_customer_phone text;
  v_invoice_number text;
  v_currency text;
  v_notes text;
  v_issue_date date;
  v_due_date date;
  v_total numeric;
  v_subtotal numeric;
  v_tax numeric;
  v_invoice_input jsonb;
  v_request_values jsonb;
  v_patch jsonb;
  v_new_bot_preferences jsonb;
  v_new_followup_preferences jsonb;
  v_business_name text;
  v_timezone text;
  v_key text;
  v_template text;
  v_template_rest text;
  v_template_token text;
  v_pending_type text;
  v_proposal_id uuid;
  v_source_message_id text;
  v_had_payment boolean;
  v_had_sent_reminder boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_old_sub text := pg_catalog.current_setting('request.jwt.claim.sub',true);
  v_old_role text := pg_catalog.current_setting('request.jwt.claim.role',true);
  v_old_claims text := pg_catalog.current_setting('request.jwt.claims',true);
  v_payment_idempotency_key text;
begin
  v_role := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.role',true),''),auth.role(),'');
  if v_role <> 'service_role'
     or p_workspace_id is null or p_owner_id is null
     or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$'
     or p_provider_message_id is null or pg_catalog.length(p_provider_message_id) not between 1 and 256
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{12,120}$'
     or p_payload is null or v_payload is null or pg_catalog.jsonb_typeof(v_payload) is distinct from 'object'
     or v_payload='null'::jsonb then
    return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
  end if;
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r
      where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id) <> 1 then
    return pg_catalog.jsonb_build_object('ok',false,'code','DENIED');
  end if;
  select r.* into v_owner from public.whatsapp_resolve_verified_owner(p_phone) r
    where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id;
  if not found or v_owner.customer_id is null then
    return pg_catalog.jsonb_build_object('ok',false,'code','DENIED');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r
      where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id and r.customer_id=v_owner.customer_id) <> 1 then
    return pg_catalog.jsonb_build_object('ok',false,'code','DENIED');
  end if;

  if p_authorization_kind='instruction' then
    if p_operation not in ('invoice.create','invoice.update','invoice.delete','invoice.restore',
        'customer.create','customer.update','customer.delete','settings.update','ai_settings.update')
       or p_interaction_id is not null or p_button_decision is not null
       or p_pending_id is not null or p_pending_version is not null
       or p_authorization_quote is null or pg_catalog.length(p_authorization_quote) not between 1 and 4000 then
      return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
    end if;
    select * into v_event from public.whatsapp_inbound_events e
      where e.provider_message_id=p_provider_message_id and e.sender_phone=p_phone
        and e.status in ('processing','done') for update;
    if not found or v_event.message_text is distinct from p_authorization_quote then
      return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
    end if;
    if v_event.status<>'processing' then
      return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION');
    end if;
    if coalesce((select s.owner_bot_preferences->>'confirmationMode' from public.workspace_settings s
        where s.workspace_id=p_workspace_id),'direct') <> 'direct' then
      return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
    end if;
    v_request := pg_catalog.jsonb_build_object('operation',p_operation,'targetId',p_target_id,
      'expectedUpdatedAt',p_expected_updated_at,'authorizationKind',p_authorization_kind,
      'authorizationQuote',p_authorization_quote,'interactionId',null,'buttonDecision',null,
      'pendingId',null,'pendingVersion',null,'payload',v_payload);
  elsif p_authorization_kind='button' then
    if p_operation<>'pending.decide' or p_authorization_quote is not null
       or p_button_decision not in ('confirm','cancel')
       or p_pending_id is null or p_pending_version is null or p_pending_id<=0 or p_pending_version<=0
       or p_interaction_id is null or pg_catalog.length(p_interaction_id) not between 1 and 256
       or p_target_id is not null or p_expected_updated_at is not null or v_payload<>'{}'::jsonb then
      return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
    end if;
    select * into v_event from public.whatsapp_inbound_events e
      where e.provider_message_id=p_provider_message_id and e.sender_phone=p_phone
        and e.status in ('processing','done') for update;
    if not found or v_event.interaction_id is distinct from p_interaction_id then
      return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
    end if;
    if v_event.status<>'processing' then
      return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION');
    end if;
    if coalesce((select s.owner_bot_preferences->>'confirmationMode' from public.workspace_settings s
        where s.workspace_id=p_workspace_id),'direct') <> 'buttons' then
      return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
    end if;
    v_request := pg_catalog.jsonb_build_object('operation',p_operation,'targetId',null,
      'expectedUpdatedAt',null,'authorizationKind',p_authorization_kind,
      'authorizationQuote',null,'interactionId',p_interaction_id,'buttonDecision',p_button_decision,
      'pendingId',p_pending_id,'pendingVersion',p_pending_version,'payload',v_payload);
  else
    return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
  end if;

  select * into v_receipt from public.whatsapp_direct_write_receipts r
    where r.provider_message_id=p_provider_message_id for update;
  if found then
    if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.owner_id is distinct from p_owner_id
       or v_receipt.phone is distinct from p_phone or v_receipt.idempotency_key is distinct from p_idempotency_key
       or v_receipt.request is distinct from v_request then
      return pg_catalog.jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');
    end if;
    return v_receipt.result || pg_catalog.jsonb_build_object('replayed',true);
  end if;

  if p_authorization_kind='instruction' then
    if p_operation in ('invoice.update','invoice.delete','invoice.restore','customer.update','customer.delete') then
      if p_target_id is null or p_expected_updated_at is null then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
      end if;
    elsif p_operation='ai_settings.update' then
      if p_target_id is distinct from p_workspace_id then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
      end if;
    elsif p_operation='settings.update' then
      if p_target_id is distinct from p_workspace_id or p_expected_updated_at is null then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
      end if;
    elsif p_operation in ('invoice.create','customer.create') then
      if p_target_id is not null or p_expected_updated_at is not null then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
      end if;
    end if;

    if p_operation='invoice.create' then
      if exists(select 1 from pg_catalog.jsonb_object_keys(v_payload) k(key)
        where key not in ('invoice_number','customer_name','customer_email','customer_phone','issue_date','due_date',
          'total_amount','subtotal','tax','currency','notes'))
        or not (v_payload ? 'customer_name')
        or not (v_payload ? 'issue_date') or not (v_payload ? 'due_date') or not (v_payload ? 'total_amount')
        or (v_payload ? 'invoice_number' and pg_catalog.jsonb_typeof(v_payload->'invoice_number') is distinct from 'string')
        or pg_catalog.jsonb_typeof(v_payload->'customer_name') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_payload->'issue_date') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_payload->'due_date') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_payload->'total_amount') not in ('number','string')
        or (v_payload ? 'currency' and pg_catalog.jsonb_typeof(v_payload->'currency') is distinct from 'string')
        or (v_payload ? 'customer_email' and pg_catalog.jsonb_typeof(v_payload->'customer_email') not in ('null','string'))
        or (v_payload ? 'customer_phone' and pg_catalog.jsonb_typeof(v_payload->'customer_phone') not in ('null','string'))
        or (v_payload ? 'notes' and pg_catalog.jsonb_typeof(v_payload->'notes') not in ('null','string')) then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
      end if;
      v_invoice_number:=nullif(pg_catalog.btrim(v_payload->>'invoice_number'),'');
      if v_invoice_number='AUTO' then v_invoice_number:=null; end if;
      v_customer_name:=pg_catalog.btrim(coalesce(v_payload->>'customer_name',''));
      v_customer_email:=nullif(pg_catalog.btrim(v_payload->>'customer_email'),'');
      v_customer_phone:=nullif(pg_catalog.btrim(v_payload->>'customer_phone'),'');
      if v_payload ? 'currency' then v_currency:=v_payload->>'currency';
      else select s.default_currency into v_currency from public.workspace_settings s where s.workspace_id=p_workspace_id;
      end if;
      v_notes:=nullif(v_payload->>'notes','');
      if v_invoice_number is not null and (pg_catalog.length(v_invoice_number) not between 1 and 100
         or v_invoice_number !~ '^[A-Za-z0-9][A-Za-z0-9 _./-]{0,99}$')
         or pg_catalog.length(v_customer_name) not between 1 and 200
         or v_customer_email is not null and (pg_catalog.length(v_customer_email)>320 or v_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
         or v_customer_phone is not null and pg_catalog.length(v_customer_phone)>40
         or v_currency is null or v_currency not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')
         or v_notes is not null and pg_catalog.length(v_notes)>2000
         or (v_payload ? 'subtotal' and pg_catalog.jsonb_typeof(v_payload->'subtotal') not in ('null','number','string'))
         or (v_payload ? 'tax' and pg_catalog.jsonb_typeof(v_payload->'tax') not in ('null','number','string')) then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
      end if;
      begin
        v_issue_date:=(v_payload->>'issue_date')::date;
        v_due_date:=(v_payload->>'due_date')::date;
        v_total:=(v_payload->>'total_amount')::numeric;
        v_subtotal:=nullif(v_payload->>'subtotal','')::numeric;
        v_tax:=nullif(v_payload->>'tax','')::numeric;
      exception when others then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
      end;
      if v_issue_date is null or v_due_date<v_issue_date or v_total<=0 or v_total>999999999999.99
         or v_total::text in ('NaN','Infinity','-Infinity') or pg_catalog.scale(v_total)>2
         or (v_subtotal is not null and (v_subtotal::text in ('NaN','Infinity','-Infinity') or v_subtotal<0 or v_subtotal>v_total or pg_catalog.scale(v_subtotal)>2))
         or (v_tax is not null and (v_tax::text in ('NaN','Infinity','-Infinity') or v_tax<0 or v_tax>v_total or pg_catalog.scale(v_tax)>2))
         or (v_subtotal is not null and v_tax is not null and pg_catalog.abs(v_total-v_subtotal-v_tax)>0.01) then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
      end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':direct-create:'||p_idempotency_key,4));
      select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id
        and i.metadata->>'assistant_idempotency_key'=p_idempotency_key for update;
      if found then
        if v_invoice.deleted_at is not null or v_invoice.metadata->>'printed_invoice_number' is distinct from v_invoice_number
           or v_invoice.total_amount is distinct from v_total or v_invoice.issue_date is distinct from v_issue_date
           or v_invoice.due_date is distinct from v_due_date then
          return pg_catalog.jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');
        end if;
        v_action:='invoice.created';
      else
        if v_invoice_number is not null and exists(select 1 from public.invoices i
          where i.workspace_id=p_workspace_id and i.invoice_number=v_invoice_number) then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVOICE_EXISTS');
        end if;
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||v_customer_name,3));
        select count(*)::integer into v_match_count from public.customers c where c.workspace_id=p_workspace_id
          and pg_catalog.lower(c.name)=pg_catalog.lower(v_customer_name)
          and (v_customer_email is null or pg_catalog.lower(c.email)=pg_catalog.lower(v_customer_email));
        if v_match_count>1 then return pg_catalog.jsonb_build_object('ok',false,'code','AMBIGUOUS'); end if;
        begin
          if v_match_count=1 then
            select * into v_customer from public.customers c where c.workspace_id=p_workspace_id
              and pg_catalog.lower(c.name)=pg_catalog.lower(v_customer_name)
              and (v_customer_email is null or pg_catalog.lower(c.email)=pg_catalog.lower(v_customer_email)) limit 1;
          else
            if v_customer_email is not null and exists(select 1 from public.customers c
              where c.workspace_id=p_workspace_id and pg_catalog.lower(c.email)=pg_catalog.lower(v_customer_email)) then
              return pg_catalog.jsonb_build_object('ok',false,'code','AMBIGUOUS');
            end if;
            insert into public.customers(workspace_id,name,email,phone)
              values(p_workspace_id,v_customer_name,v_customer_email,v_customer_phone) returning * into v_customer;
          end if;
          v_record:=pg_catalog.jsonb_build_object('assistant_idempotency_key',p_idempotency_key,
            'invoice_direction','receivable','bookkeeping_sync_status','not_configured','bookkeeping_sync_error',null,
            'followup_state','draft','next_follow_up_at',null,'subtotal',v_subtotal,'tax',v_tax,
            'outstanding_amount',v_total,'client_name',v_customer_name,
            'debtor_phone',v_customer_phone,'client_phone',v_customer_phone,
            'client_phone_raw',null,'client_email',v_customer_email,'line_items','[]'::jsonb);
          if v_invoice_number is not null then
            v_record:=v_record||pg_catalog.jsonb_build_object('printed_invoice_number',v_invoice_number,
              'source_invoice_number',v_invoice_number);
          end if;
          insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,notes,metadata)
          values(p_workspace_id,v_customer.id,v_invoice_number,v_issue_date,v_due_date,v_currency,v_total,v_notes,v_record)
          returning * into v_invoice;
        exception when unique_violation then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVOICE_EXISTS');
        end;
        v_action:='invoice.created';
      end if;
      v_entity_type:='invoice';v_entity_id:=v_invoice.id::text;v_updated_at:=v_invoice.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_invoice.id,'workspace_id',v_invoice.workspace_id,
        'customer_id',v_invoice.customer_id,'invoice_number',v_invoice.invoice_number,'issue_date',v_invoice.issue_date,
        'due_date',v_invoice.due_date,'currency',v_invoice.currency,'total_amount',v_invoice.total_amount::text,
        'amount_paid',v_invoice.amount_paid::text,'status',v_invoice.status::text,'notes',v_invoice.notes,
        'metadata',v_invoice.metadata,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at,
        'deleted_at',v_invoice.deleted_at,'deleted_by',v_invoice.deleted_by);
    elsif p_operation='invoice.update' then
      if exists(select 1 from pg_catalog.jsonb_object_keys(v_payload) k(key)
        where key not in ('invoice_number','issue_date','due_date','total_amount','currency','notes','status'))
        or v_payload='{}'::jsonb
        or (v_payload ? 'invoice_number' and pg_catalog.jsonb_typeof(v_payload->'invoice_number') is distinct from 'string')
        or (v_payload ? 'issue_date' and pg_catalog.jsonb_typeof(v_payload->'issue_date') is distinct from 'string')
        or (v_payload ? 'due_date' and pg_catalog.jsonb_typeof(v_payload->'due_date') not in ('null','string'))
        or (v_payload ? 'total_amount' and pg_catalog.jsonb_typeof(v_payload->'total_amount') not in ('number','string'))
        or (v_payload ? 'currency' and pg_catalog.jsonb_typeof(v_payload->'currency') is distinct from 'string')
        or (v_payload ? 'notes' and pg_catalog.jsonb_typeof(v_payload->'notes') not in ('null','string'))
        or (v_payload ? 'status' and pg_catalog.jsonb_typeof(v_payload->'status') is distinct from 'string') then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id and i.id=p_target_id
        and i.deleted_at is null for update;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      if v_invoice.updated_at is distinct from p_expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      if v_payload ? 'status' then
        if v_payload->>'status'<>'paid' or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_payload))<>1 then
          return pg_catalog.jsonb_build_object('ok',false,'code','PAYMENT_GUARD'); end if;
        if v_invoice.status::text in ('paid','void','cancelled') or v_invoice.amount_paid>=v_invoice.total_amount then
          return pg_catalog.jsonb_build_object('ok',false,'code','PAYMENT_GUARD'); end if;
        v_payment_idempotency_key:='wa_owner_direct_payment_'||pg_catalog.md5(p_provider_message_id);
        perform pg_catalog.set_config('request.jwt.claim.sub',p_owner_id::text,true);
        perform pg_catalog.set_config('request.jwt.claim.role','authenticated',true);
        perform pg_catalog.set_config('request.jwt.claims',pg_catalog.jsonb_build_object('sub',p_owner_id,'role','authenticated')::text,true);
        begin
          perform public.record_invoice_payment(p_workspace_id,v_invoice.id,null,v_payment_idempotency_key,
            'Owner requested settlement on WhatsApp',true);
        exception when others then
          perform pg_catalog.set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
          perform pg_catalog.set_config('request.jwt.claim.role',coalesce(v_old_role,''),true);
          perform pg_catalog.set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
          return pg_catalog.jsonb_build_object('ok',false,'code','PAYMENT_GUARD');
        end;
        perform pg_catalog.set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
        perform pg_catalog.set_config('request.jwt.claim.role',coalesce(v_old_role,''),true);
        perform pg_catalog.set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
        select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id and i.id=p_target_id;
        if not found or v_invoice.status::text<>'paid' or v_invoice.amount_paid<v_invoice.total_amount then
          raise exception using errcode='Z0002',message='payment outcome could not be verified'; end if;
        v_action:='invoice.paid';
      else
        if v_invoice.status::text in ('paid','void','cancelled') or v_invoice.amount_paid>=v_invoice.total_amount then
          return pg_catalog.jsonb_build_object('ok',false,'code','PAYMENT_GUARD'); end if;
        if v_payload ? 'total_amount' then
          begin v_total:=(v_payload->>'total_amount')::numeric; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
          if v_total::text in ('NaN','Infinity','-Infinity') or v_total<v_invoice.amount_paid or v_total<=0
             or v_total>999999999999.99 or pg_catalog.scale(v_total)>2 then
            return pg_catalog.jsonb_build_object('ok',false,'code','PAYMENT_GUARD'); end if;
        else v_total:=v_invoice.total_amount; end if;
        if v_payload ? 'invoice_number' then
          v_invoice_number:=pg_catalog.btrim(v_payload->>'invoice_number');
          if v_invoice_number !~ '^[A-Za-z0-9][A-Za-z0-9 _./-]{0,99}$' then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        else v_invoice_number:=v_invoice.invoice_number; end if;
        if v_payload ? 'issue_date' then
          begin v_issue_date:=(v_payload->>'issue_date')::date; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
        else v_issue_date:=v_invoice.issue_date; end if;
        if v_payload ? 'due_date' then
          begin v_due_date:=nullif(v_payload->>'due_date','')::date; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
        else v_due_date:=v_invoice.due_date; end if;
        if v_due_date is not null and v_due_date<v_issue_date then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        if v_payload ? 'currency' then
          v_currency:=v_payload->>'currency';
          if v_currency is null or v_currency not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')
             or v_invoice.amount_paid>0 and v_currency<>v_invoice.currency then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        else v_currency:=v_invoice.currency; end if;
        if v_payload ? 'notes' then
          v_notes:=case when pg_catalog.jsonb_typeof(v_payload->'notes')='null' then null else v_payload->>'notes' end;
          if v_notes is not null and pg_catalog.length(v_notes)>4000 then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        else v_notes:=v_invoice.notes; end if;
        if v_total<v_invoice.amount_paid then return pg_catalog.jsonb_build_object('ok',false,'code','PAYMENT_GUARD'); end if;
        update public.invoices i set invoice_number=v_invoice_number,issue_date=v_issue_date,due_date=v_due_date,
          total_amount=v_total,currency=v_currency,notes=v_notes,
          metadata=i.metadata||pg_catalog.jsonb_build_object('printed_invoice_number',v_invoice_number,
            'source_invoice_number',v_invoice_number,'outstanding_amount',v_total-i.amount_paid,
            'followup_state','paused','next_follow_up_at',null,'approved_reminder_text',null,
            'approved_preferences_updated_at',null,'bookkeeping_sync_status','pending'),
          followup_state='paused',next_follow_up_at=null
        where i.workspace_id=p_workspace_id and i.id=p_target_id returning * into v_invoice;
        v_action:='invoice.updated';
      end if;
      update public.invoice_lifecycle_proposals set state='stale'
        where workspace_id=p_workspace_id and owner_id=p_owner_id and invoice_id=p_target_id and state='pending';
      update public.whatsapp_pending_actions set consumed_at=v_now
        where workspace_id=p_workspace_id and customer_id=v_owner.customer_id and phone=p_phone and consumed_at is null
          and action->>'invoiceId'=p_target_id::text;
      v_entity_type:='invoice';v_entity_id:=v_invoice.id::text;v_updated_at:=v_invoice.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_invoice.id,'workspace_id',v_invoice.workspace_id,
        'customer_id',v_invoice.customer_id,'invoice_number',v_invoice.invoice_number,'issue_date',v_invoice.issue_date,
        'due_date',v_invoice.due_date,'currency',v_invoice.currency,'total_amount',v_invoice.total_amount::text,
        'amount_paid',v_invoice.amount_paid::text,'status',v_invoice.status::text,'notes',v_invoice.notes,
        'metadata',v_invoice.metadata,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at,
        'deleted_at',v_invoice.deleted_at,'deleted_by',v_invoice.deleted_by);
    elsif p_operation='invoice.delete' then
      if v_payload<>'{}'::jsonb then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id and i.id=p_target_id for update;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      if v_invoice.deleted_at is not null then return pg_catalog.jsonb_build_object('ok',false,'code','ALREADY_DELETED'); end if;
      if v_invoice.updated_at is distinct from p_expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      perform 1 from public.cetld_core_automation_delivery_claims c
        where c.workspace_id=p_workspace_id and c.invoice_id=v_invoice.id and c.status='sending' for update;
      if found then return pg_catalog.jsonb_build_object('ok',false,'code','IN_USE'); end if;
      select c.name into v_customer_name from public.customers c where c.workspace_id=p_workspace_id and c.id=v_invoice.customer_id;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      v_had_payment:=v_invoice.status='paid' or v_invoice.amount_paid>0 or exists(
        select 1 from public.payments p where p.workspace_id=p_workspace_id and p.invoice_id=v_invoice.id);
      v_had_sent_reminder:=exists(select 1 from public.cetld_core_automation_delivery_claims c
        where c.workspace_id=p_workspace_id and c.invoice_id=v_invoice.id and c.status in ('sending','sent','quarantined'))
        or exists(select 1 from public.cetld_core_automation_messages m where m.workspace_id=p_workspace_id
          and m.invoice_id=v_invoice.id and m.kind='reminder' and m.status in ('accepted','sent','delivered','read','unknown'))
        or exists(select 1 from public.whatsapp_messages m where m.workspace_id=p_workspace_id and m.invoice_id=v_invoice.id
          and m.direction='outbound' and m.audience='customer' and m.kind='reminder'
          and m.status in ('accepted','sent','delivered','read','unknown'));
      update public.invoice_lifecycle_proposals set state='stale'
        where workspace_id=p_workspace_id and owner_id=p_owner_id and invoice_id=v_invoice.id and state='pending';
      insert into public.invoice_lifecycle_proposals(workspace_id,owner_id,invoice_id,actor_phone,idempotency_key,
        request_message_id,expected_updated_at,invoice_number,customer_name,total_amount,currency,invoice_status,
        requires_exact_confirmation,had_payment,had_sent_reminder,state,created_at,expires_at,deleted_at)
      values(p_workspace_id,p_owner_id,v_invoice.id,p_phone,'direct_delete_'||pg_catalog.md5(p_provider_message_id),
        p_provider_message_id,v_invoice.updated_at,v_invoice.invoice_number,v_customer_name,v_invoice.total_amount,
        v_invoice.currency,v_invoice.status,v_had_payment or v_had_sent_reminder,v_had_payment,v_had_sent_reminder,
        'deleted',v_now,v_now+interval '30 days',v_now)
      returning * into v_lifecycle;
      insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
        values(pg_catalog.pg_backend_pid(),pg_catalog.txid_current(),v_invoice.id);
      update public.invoices i set deleted_at=v_now,deleted_by=p_owner_id,followup_state='cancelled',next_follow_up_at=null,
        metadata=pg_catalog.jsonb_set(pg_catalog.jsonb_set(i.metadata,'{followup_state}','"cancelled"'::jsonb,true),
          '{next_follow_up_at}','null'::jsonb,true)
        where i.workspace_id=p_workspace_id and i.id=v_invoice.id returning * into v_invoice;
      delete from app.invoice_lifecycle_write_context where backend_pid=pg_catalog.pg_backend_pid()
        and transaction_id=pg_catalog.txid_current() and invoice_id=v_invoice.id;
      update public.cetld_core_automation_delivery_claims set status='cancelled',delivery_token=null
        where workspace_id=p_workspace_id and invoice_id=v_invoice.id and status in ('claimed','failed');
      update public.cetld_core_automation_messages set status='blocked'
        where workspace_id=p_workspace_id and invoice_id=v_invoice.id and kind='reminder' and status='pending';
      update public.whatsapp_messages set status='blocked',updated_at=v_now
        where workspace_id=p_workspace_id and invoice_id=v_invoice.id and direction='outbound'
          and audience='customer' and kind='reminder' and status='pending';
      update public.whatsapp_pending_actions set consumed_at=v_now
        where workspace_id=p_workspace_id and customer_id=v_owner.customer_id and phone=p_phone and consumed_at is null
          and action->>'invoiceId'=v_invoice.id::text;
      insert into public.cetld_core_automation_events(workspace_id,invoice_id,type,idempotency_key,metadata)
      values(p_workspace_id,v_invoice.id,'invoice_deleted','direct_invoice_delete:'||p_provider_message_id,
        pg_catalog.jsonb_build_object('owner_id',p_owner_id,'invoice_number',v_invoice.invoice_number,
          'provider_message_id',p_provider_message_id,'deleted_at',v_now)) on conflict(workspace_id,idempotency_key) do nothing;
      v_action:='invoice.deleted';v_entity_type:='invoice';v_entity_id:=v_invoice.id::text;v_updated_at:=v_invoice.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_invoice.id,'workspace_id',v_invoice.workspace_id,
        'customer_id',v_invoice.customer_id,'invoice_number',v_invoice.invoice_number,'issue_date',v_invoice.issue_date,
        'due_date',v_invoice.due_date,'currency',v_invoice.currency,'total_amount',v_invoice.total_amount::text,
        'amount_paid',v_invoice.amount_paid::text,'status',v_invoice.status::text,'notes',v_invoice.notes,
        'metadata',v_invoice.metadata,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at,
        'deleted_at',v_invoice.deleted_at,'deleted_by',v_invoice.deleted_by);
    elsif p_operation='invoice.restore' then
      if v_payload<>'{}'::jsonb then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id and i.id=p_target_id for update;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      if v_invoice.deleted_at is null or v_invoice.deleted_by is distinct from p_owner_id then
        return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      if v_invoice.updated_at is distinct from p_expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      if v_invoice.deleted_at<v_now-interval '30 days' then return pg_catalog.jsonb_build_object('ok',false,'code','UNDO_EXPIRED'); end if;
      select * into v_lifecycle from public.invoice_lifecycle_proposals p where p.workspace_id=p_workspace_id
        and p.owner_id=p_owner_id and p.invoice_id=v_invoice.id and p.state='deleted' and p.deleted_at=v_invoice.deleted_at
        order by p.created_at desc limit 1 for update;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
        values(pg_catalog.pg_backend_pid(),pg_catalog.txid_current(),v_invoice.id);
      update public.invoices i set deleted_at=null,deleted_by=null,
        followup_state=case when i.status::text in ('paid','void','cancelled') or i.amount_paid>=i.total_amount then 'cancelled' else 'paused' end,
        next_follow_up_at=null,
        metadata=pg_catalog.jsonb_set(pg_catalog.jsonb_set(i.metadata,'{followup_state}',
          case when i.status::text in ('paid','void','cancelled') or i.amount_paid>=i.total_amount then '"cancelled"'::jsonb else '"paused"'::jsonb end,true),
          '{next_follow_up_at}','null'::jsonb,true)
        where i.workspace_id=p_workspace_id and i.id=v_invoice.id returning * into v_invoice;
      delete from app.invoice_lifecycle_write_context where backend_pid=pg_catalog.pg_backend_pid()
        and transaction_id=pg_catalog.txid_current() and invoice_id=v_invoice.id;
      update public.invoice_lifecycle_proposals set state='restored',restored_at=v_now,
        undo_idempotency_key='direct_restore_'||pg_catalog.md5(p_provider_message_id),
        undo_request_message_id=p_provider_message_id,undo_actor_phone=p_phone,
        undo_result=pg_catalog.jsonb_build_object('ok',true,'action','restored','invoiceId',v_invoice.id,
          'invoiceNumber',v_invoice.invoice_number,'status',v_invoice.status::text)
        where id=v_lifecycle.id;
      v_action:='invoice.restored';v_entity_type:='invoice';v_entity_id:=v_invoice.id::text;v_updated_at:=v_invoice.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_invoice.id,'workspace_id',v_invoice.workspace_id,
        'customer_id',v_invoice.customer_id,'invoice_number',v_invoice.invoice_number,'issue_date',v_invoice.issue_date,
        'due_date',v_invoice.due_date,'currency',v_invoice.currency,'total_amount',v_invoice.total_amount::text,
        'amount_paid',v_invoice.amount_paid::text,'status',v_invoice.status::text,'notes',v_invoice.notes,
        'metadata',v_invoice.metadata,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at,
        'deleted_at',v_invoice.deleted_at,'deleted_by',v_invoice.deleted_by);
    elsif p_operation='customer.create' then
      if exists(select 1 from pg_catalog.jsonb_object_keys(v_payload) k(key)
        where key not in ('name','company_name','email','phone')) or not(v_payload ? 'name')
        or pg_catalog.jsonb_typeof(v_payload->'name') is distinct from 'string'
        or (v_payload ? 'company_name' and pg_catalog.jsonb_typeof(v_payload->'company_name') not in ('null','string'))
        or (v_payload ? 'email' and pg_catalog.jsonb_typeof(v_payload->'email') not in ('null','string'))
        or (v_payload ? 'phone' and pg_catalog.jsonb_typeof(v_payload->'phone') not in ('null','string')) then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      v_customer_name:=pg_catalog.btrim(v_payload->>'name');v_customer_email:=nullif(pg_catalog.btrim(v_payload->>'email'),'');
      v_customer_phone:=nullif(pg_catalog.btrim(v_payload->>'phone'),'');
      if pg_catalog.length(v_customer_name) not between 1 and 200
         or v_customer_email is not null and (pg_catalog.length(v_customer_email)>320 or v_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
         or v_customer_phone is not null and (pg_catalog.length(v_customer_phone)>40 or v_customer_phone=p_phone)
         or v_payload ? 'company_name' and pg_catalog.length(coalesce(v_payload->>'company_name',''))>200 then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      begin
        insert into public.customers(workspace_id,name,company_name,email,phone)
        values(p_workspace_id,v_customer_name,nullif(pg_catalog.btrim(v_payload->>'company_name'),''),v_customer_email,v_customer_phone)
        returning * into v_customer;
      exception when unique_violation then return pg_catalog.jsonb_build_object('ok',false,'code','AMBIGUOUS');
      end;
      v_action:='customer.created';v_entity_type:='customer';v_entity_id:=v_customer.id::text;v_updated_at:=v_customer.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_customer.id,'workspace_id',v_customer.workspace_id,'name',v_customer.name,
        'company_name',v_customer.company_name,'email',v_customer.email,'phone',v_customer.phone,
        'metadata',v_customer.metadata,'created_at',v_customer.created_at,'updated_at',v_customer.updated_at);
    elsif p_operation='customer.update' then
      if exists(select 1 from pg_catalog.jsonb_object_keys(v_payload) k(key)
        where key not in ('name','company_name','email','phone')) or v_payload='{}'::jsonb
        or (v_payload ? 'name' and pg_catalog.jsonb_typeof(v_payload->'name') is distinct from 'string')
        or (v_payload ? 'company_name' and pg_catalog.jsonb_typeof(v_payload->'company_name') not in ('null','string'))
        or (v_payload ? 'email' and pg_catalog.jsonb_typeof(v_payload->'email') not in ('null','string'))
        or (v_payload ? 'phone' and pg_catalog.jsonb_typeof(v_payload->'phone') not in ('null','string')) then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      select * into v_customer from public.customers c where c.workspace_id=p_workspace_id and c.id=p_target_id for update;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      if v_customer.id=v_owner.customer_id or coalesce(v_customer.metadata->>'whatsapp_owner','false')='true' then
        return pg_catalog.jsonb_build_object('ok',false,'code','DENIED'); end if;
      if v_customer.updated_at is distinct from p_expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      v_customer_name:=case when v_payload ? 'name' then pg_catalog.btrim(v_payload->>'name') else v_customer.name end;
      v_customer_email:=case when v_payload ? 'email' then nullif(pg_catalog.btrim(v_payload->>'email'),'') else v_customer.email end;
      v_customer_phone:=case when v_payload ? 'phone' then nullif(pg_catalog.btrim(v_payload->>'phone'),'') else v_customer.phone end;
      if pg_catalog.length(v_customer_name) not between 1 and 200
         or v_customer_email is not null and (pg_catalog.length(v_customer_email)>320 or v_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
         or v_customer_phone is not null and (pg_catalog.length(v_customer_phone)>40 or v_customer_phone=p_phone)
         or v_payload ? 'company_name' and pg_catalog.length(coalesce(v_payload->>'company_name',''))>200 then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      begin
        update public.customers c set name=v_customer_name,
          company_name=case when v_payload ? 'company_name' then nullif(pg_catalog.btrim(v_payload->>'company_name'),'') else c.company_name end,
          email=v_customer_email,phone=v_customer_phone
        where c.workspace_id=p_workspace_id and c.id=p_target_id returning * into v_customer;
      exception when unique_violation then return pg_catalog.jsonb_build_object('ok',false,'code','AMBIGUOUS');
      end;
      v_action:='customer.updated';v_entity_type:='customer';v_entity_id:=v_customer.id::text;v_updated_at:=v_customer.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_customer.id,'workspace_id',v_customer.workspace_id,'name',v_customer.name,
        'company_name',v_customer.company_name,'email',v_customer.email,'phone',v_customer.phone,
        'metadata',v_customer.metadata,'created_at',v_customer.created_at,'updated_at',v_customer.updated_at);
      update public.whatsapp_workspace_data_proposals p set state='stale',updated_at=v_now
        where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='customers'
          and p.target_id=v_customer.id and p.state='pending';
      update public.whatsapp_pending_actions a set consumed_at=v_now
        where a.workspace_id=p_workspace_id and a.customer_id=v_owner.customer_id and a.phone=p_phone and a.consumed_at is null
          and a.action->>'proposalId' in (select p.id::text from public.whatsapp_workspace_data_proposals p
            where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='customers'
              and p.target_id=v_customer.id and p.state='stale');
    elsif p_operation='customer.delete' then
      if v_payload<>'{}'::jsonb then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      select * into v_customer from public.customers c where c.workspace_id=p_workspace_id and c.id=p_target_id for update;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
      if v_customer.id=v_owner.customer_id or coalesce(v_customer.metadata->>'whatsapp_owner','false')='true' then
        return pg_catalog.jsonb_build_object('ok',false,'code','DENIED'); end if;
      if v_customer.updated_at is distinct from p_expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      if exists(select 1 from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=v_customer.id) then
        return pg_catalog.jsonb_build_object('ok',false,'code','IN_USE'); end if;
      v_record:=pg_catalog.jsonb_build_object('id',v_customer.id,'workspace_id',v_customer.workspace_id,'name',v_customer.name,
        'company_name',v_customer.company_name,'email',v_customer.email,'phone',v_customer.phone,
        'metadata',v_customer.metadata,'created_at',v_customer.created_at,'updated_at',v_customer.updated_at);
      delete from public.customers c where c.workspace_id=p_workspace_id and c.id=v_customer.id;
      v_action:='customer.deleted';v_entity_type:='customer';v_entity_id:=v_customer.id::text;v_updated_at:=v_customer.updated_at;
      update public.whatsapp_workspace_data_proposals p set state='stale',updated_at=v_now
        where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='customers'
          and p.target_id=v_customer.id and p.state='pending';
      update public.whatsapp_pending_actions a set consumed_at=v_now
        where a.workspace_id=p_workspace_id and a.customer_id=v_owner.customer_id and a.phone=p_phone and a.consumed_at is null
          and a.action->>'proposalId' in (select p.id::text from public.whatsapp_workspace_data_proposals p
            where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='customers'
              and p.target_id=v_customer.id and p.state='stale');
    elsif p_operation='settings.update' then
      if exists(select 1 from pg_catalog.jsonb_object_keys(v_payload) k(key)
        where key not in ('business_name','default_currency','default_timezone','follow_up_preferences','owner_bot_preferences'))
        or v_payload='{}'::jsonb then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      select * into v_settings from public.workspace_settings s where s.workspace_id=p_workspace_id for update;
      if not found or v_settings.updated_at is distinct from p_expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      if v_payload ? 'business_name' then
        if pg_catalog.jsonb_typeof(v_payload->'business_name') not in ('null','string') then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        v_business_name:=case when pg_catalog.jsonb_typeof(v_payload->'business_name')='null' then null else pg_catalog.btrim(v_payload->>'business_name') end;
        if v_business_name is not null and pg_catalog.length(v_business_name) not between 1 and 200 then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      else v_business_name:=v_settings.business_name; end if;
      if v_payload ? 'default_currency' then
        v_currency:=v_payload->>'default_currency';
        if pg_catalog.jsonb_typeof(v_payload->'default_currency') is distinct from 'string'
           or v_currency is null or v_currency !~ '^[A-Z]{3}$' then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      else v_currency:=v_settings.default_currency; end if;
      if v_payload ? 'default_timezone' then
        v_timezone:=v_payload->>'default_timezone';
        if pg_catalog.jsonb_typeof(v_payload->'default_timezone') is distinct from 'string'
           or v_timezone is null or pg_catalog.length(v_timezone)>80 or not exists(select 1 from pg_catalog.pg_timezone_names t where t.name=v_timezone) then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      else v_timezone:=v_settings.default_timezone; end if;
      v_new_followup_preferences:=v_settings.follow_up_preferences;
      if v_payload ? 'follow_up_preferences' then
        v_patch:=v_payload->'follow_up_preferences';
        if pg_catalog.jsonb_typeof(v_patch) is distinct from 'object'
          or exists(select 1 from pg_catalog.jsonb_object_keys(v_patch) k(key)
            where key not in ('tone','maxReminders','cadenceDays','firstReminderDays','contactStart','contactEnd',
              'allowedWeekdays','escalation','stopOnPayment','pauseOnReply','dailySummary','reminderTemplate')) then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        if v_patch ? 'tone' and (pg_catalog.jsonb_typeof(v_patch->'tone')<>'string' or v_patch->>'tone' not in ('gentle','professional','firm')) then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        foreach v_key in array array['maxReminders','cadenceDays','firstReminderDays'] loop
          if v_patch ? v_key and (pg_catalog.jsonb_typeof(v_patch->v_key)<>'number'
            or (v_patch->>v_key)::numeric<>pg_catalog.trunc((v_patch->>v_key)::numeric)
            or (v_key='firstReminderDays' and (v_patch->>v_key)::numeric<0)
            or (v_key<>'firstReminderDays' and (v_patch->>v_key)::numeric<1)
            or (v_key='maxReminders' and (v_patch->>v_key)::numeric>20)
            or (v_key<>'maxReminders' and (v_patch->>v_key)::numeric>90)) then
            return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        end loop;
        foreach v_key in array array['contactStart','contactEnd'] loop
          if v_patch ? v_key and (pg_catalog.jsonb_typeof(v_patch->v_key)<>'string' or v_patch->>v_key !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
            return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        end loop;
        foreach v_key in array array['pauseOnReply','dailySummary'] loop
          if v_patch ? v_key and pg_catalog.jsonb_typeof(v_patch->v_key)<>'boolean' then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        end loop;
        if v_patch ? 'allowedWeekdays' then
          if pg_catalog.jsonb_typeof(v_patch->'allowedWeekdays') is distinct from 'array' then
            return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
          if pg_catalog.jsonb_array_length(v_patch->'allowedWeekdays') not between 1 and 7
            or exists(select 1 from pg_catalog.jsonb_array_elements(v_patch->'allowedWeekdays') e(value)
              where pg_catalog.jsonb_typeof(e.value) is distinct from 'number') then
            return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
          if exists(select 1 from pg_catalog.jsonb_array_elements(v_patch->'allowedWeekdays') e(value)
              where (e.value::text)::numeric<>pg_catalog.trunc((e.value::text)::numeric)
                or (e.value::text)::numeric not between 0 and 6)
            or (select count(distinct (e.value::text)::numeric) from pg_catalog.jsonb_array_elements(v_patch->'allowedWeekdays') e(value))
              <>pg_catalog.jsonb_array_length(v_patch->'allowedWeekdays') then
            return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        end if;
        if v_patch ? 'escalation' and (pg_catalog.jsonb_typeof(v_patch->'escalation') is distinct from 'string'
          or v_patch->>'escalation' not in ('pause','manual_review')) then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        if v_patch ? 'stopOnPayment' and (pg_catalog.jsonb_typeof(v_patch->'stopOnPayment') is distinct from 'boolean'
          or v_patch->'stopOnPayment'<>'true'::jsonb) then
          return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        if v_patch ? 'reminderTemplate' then
          if pg_catalog.jsonb_typeof(v_patch->'reminderTemplate')<>'string'
             or pg_catalog.length(v_patch->>'reminderTemplate')>1000 then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
          v_template:=v_patch->>'reminderTemplate';
          v_template_rest:=v_template;
          foreach v_template_token in array array['{{business_name}}','{{customer_name}}','{{invoice_number}}','{{balance}}','{{due_date}}'] loop
            v_template_rest:=pg_catalog.replace(v_template_rest,v_template_token,'');
          end loop;
          if v_template_rest ~ '\{\{|\}\}' then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        end if;
        v_new_followup_preferences:=v_settings.follow_up_preferences||v_patch;
      end if;
      v_new_bot_preferences:=v_settings.owner_bot_preferences;
      if v_payload ? 'owner_bot_preferences' then
        v_patch:=v_payload->'owner_bot_preferences';
        if pg_catalog.jsonb_typeof(v_patch) is distinct from 'object' then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        v_new_bot_preferences:=v_settings.owner_bot_preferences||v_patch;
        if pg_catalog.octet_length(v_new_bot_preferences::text)>8192 then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      end if;
      update public.workspace_settings s set business_name=v_business_name,default_currency=v_currency,
        default_timezone=v_timezone,follow_up_preferences=v_new_followup_preferences,
        owner_bot_preferences=v_new_bot_preferences
      where s.workspace_id=p_workspace_id returning * into v_settings;
      v_action:='settings.updated';v_entity_type:='settings';v_entity_id:=p_workspace_id::text;v_updated_at:=v_settings.updated_at;
      v_record:=pg_catalog.jsonb_build_object('workspace_id',v_settings.workspace_id,'business_name',v_settings.business_name,
        'default_currency',v_settings.default_currency,'default_timezone',v_settings.default_timezone,
        'follow_up_preferences',v_settings.follow_up_preferences,'owner_bot_preferences',v_settings.owner_bot_preferences,
        'updated_at',v_settings.updated_at);
      update public.whatsapp_pending_actions a set consumed_at=v_now where a.workspace_id=p_workspace_id
        and a.customer_id=v_owner.customer_id and a.phone=p_phone and a.consumed_at is null
        and a.action->>'type'='owner_settings_update';
      update public.whatsapp_workspace_data_proposals p set state='stale',updated_at=v_now
        where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='workspace_settings' and p.state='pending';
      update public.whatsapp_pending_actions a set consumed_at=v_now where a.workspace_id=p_workspace_id
        and a.customer_id=v_owner.customer_id and a.phone=p_phone and a.consumed_at is null
        and a.action->>'proposalId' in (select p.id::text from public.whatsapp_workspace_data_proposals p
          where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='workspace_settings' and p.state='stale');
    elsif p_operation='ai_settings.update' then
      if exists(select 1 from pg_catalog.jsonb_object_keys(v_payload) k(key) where key not in ('primary_model','fallback_model'))
        or v_payload='{}'::jsonb
        or (v_payload ? 'primary_model' and pg_catalog.jsonb_typeof(v_payload->'primary_model') is distinct from 'string')
        or (v_payload ? 'fallback_model' and pg_catalog.jsonb_typeof(v_payload->'fallback_model') not in ('null','string')) then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      if (v_payload ? 'primary_model' and pg_catalog.length(v_payload->>'primary_model') not between 1 and 160)
         or (v_payload ? 'fallback_model' and pg_catalog.jsonb_typeof(v_payload->'fallback_model')='string'
           and pg_catalog.length(v_payload->>'fallback_model') not between 1 and 160) then
        return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
      select * into v_ai from public.workspace_ai_settings a where a.workspace_id=p_workspace_id for update;
      if p_expected_updated_at is null then
        if found then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
        if not (v_payload ? 'primary_model') then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end if;
        begin
          insert into public.workspace_ai_settings(workspace_id,primary_model,fallback_model)
          values(p_workspace_id,v_payload->>'primary_model',case when pg_catalog.jsonb_typeof(v_payload->'fallback_model')='null' then null else v_payload->>'fallback_model' end)
          returning * into v_ai;
        exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
      else
        if not found or v_ai.updated_at is distinct from p_expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
        update public.workspace_ai_settings a set
          primary_model=case when v_payload ? 'primary_model' then v_payload->>'primary_model' else a.primary_model end,
          fallback_model=case when v_payload ? 'fallback_model' then case when pg_catalog.jsonb_typeof(v_payload->'fallback_model')='null' then null else v_payload->>'fallback_model' end else a.fallback_model end
        where a.workspace_id=p_workspace_id returning * into v_ai;
      end if;
      v_action:='ai_settings.updated';v_entity_type:='ai_settings';v_entity_id:=p_workspace_id::text;v_updated_at:=v_ai.updated_at;
      v_record:=pg_catalog.jsonb_build_object('workspace_id',v_ai.workspace_id,'primary_model',v_ai.primary_model,
        'fallback_model',v_ai.fallback_model,'updated_at',v_ai.updated_at);
      update public.whatsapp_workspace_data_proposals p set state='stale',updated_at=v_now
        where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='workspace_ai_settings' and p.state='pending';
      update public.whatsapp_pending_actions a set consumed_at=v_now where a.workspace_id=p_workspace_id
        and a.customer_id=v_owner.customer_id and a.phone=p_phone and a.consumed_at is null
        and a.action->>'proposalId' in (select p.id::text from public.whatsapp_workspace_data_proposals p
          where p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.table_name='workspace_ai_settings' and p.state='stale');
    else
      return pg_catalog.jsonb_build_object('ok',false,'code','INVALID');
    end if;
  else
    -- Only the checked HMAC button adapter calls this branch. The DB binds the
    -- click to the real inbound interaction id and the exact stored action row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_workspace_id::text||':'||v_owner.customer_id::text||':'||p_phone,0));
    select * into v_pending from public.whatsapp_pending_actions p where p.id=p_pending_id
      and p.workspace_id=p_workspace_id and p.customer_id=v_owner.customer_id and p.phone=p_phone for update;
    if not found or v_pending.version is distinct from p_pending_version or v_pending.consumed_at is not null then
      return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION'); end if;
    v_pending_type:=v_pending.action->>'type';
    v_source_message_id:=coalesce(v_pending.action->>'sourceMessageId',v_pending.action->>'requestMessageId');
    if v_source_message_id is null or v_source_message_id=p_provider_message_id
       or v_event.received_at<v_pending.created_at
       or (v_event.provider_timestamp is not null and v_event.provider_timestamp+interval '1 second'<v_pending.created_at)
       or not exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=v_source_message_id
         and e.sender_phone=p_phone and e.status in ('processing','done')) then
      return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
    if coalesce((v_pending.action->>'expiresAt')::timestamptz,'-infinity'::timestamptz)<=v_now
       or v_pending.created_at<v_now-interval '10 minutes' then
      update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
      return pg_catalog.jsonb_build_object('ok',false,'code','EXPIRED'); end if;
    if p_button_decision='cancel' then
      if v_pending_type='owner_invoice_delete_proposal' then
        begin v_proposal_id:=(v_pending.action->>'proposalId')::uuid; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
        update public.invoice_lifecycle_proposals p set state='cancelled',cancel_message_id=p_provider_message_id
          where p.id=v_proposal_id and p.workspace_id=p_workspace_id and p.owner_id=p_owner_id
            and p.actor_phone=p_phone and p.state='pending';
        if not found then return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION'); end if;
      elsif v_pending_type='owner_workspace_data_change' then
        begin v_proposal_id:=(v_pending.action->>'proposalId')::uuid; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
        v_outcome:=public.whatsapp_workspace_data_decide(p_workspace_id,v_owner.customer_id,p_phone,v_pending.id,
          v_pending.version,v_proposal_id,null,p_provider_message_id,v_event.message_text,false);
        if v_outcome->>'ok' is distinct from 'true' then return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION'); end if;
      elsif v_pending_type in ('owner_invoice_create','owner_settings_update') then
        update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
      elsif v_pending_type in ('owner_invoice_update','owner_invoice_payment') then
        v_outcome:=public.whatsapp_confirm_owner_invoice_action(p_workspace_id,p_owner_id,p_phone,
          v_pending.id,v_pending.version,p_provider_message_id,false);
        if v_outcome->>'ok' is distinct from 'true' then return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION'); end if;
      else
        return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION');
      end if;
      update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
      v_action:='pending.cancelled';v_entity_type:='pending';v_entity_id:=v_pending.id::text;v_updated_at:=null;
      v_record:=pg_catalog.jsonb_build_object('id',v_pending.id,'workspace_id',p_workspace_id,
        'actionType',v_pending_type,'consumed_at',v_now);
    elsif v_pending_type='owner_invoice_delete_proposal' then
      begin v_proposal_id:=(v_pending.action->>'proposalId')::uuid; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
      select * into v_lifecycle from public.invoice_lifecycle_proposals p where p.id=v_proposal_id
        and p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.actor_phone=p_phone and p.state='pending' for update;
      if not found or v_lifecycle.request_message_id is distinct from v_source_message_id
         or v_pending.action->>'invoiceId' is distinct from v_lifecycle.invoice_id::text then
        return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION'); end if;
      select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id and i.id=v_lifecycle.invoice_id for update;
      if not found or v_invoice.deleted_at is not null then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      if v_invoice.updated_at is distinct from v_lifecycle.expected_updated_at then return pg_catalog.jsonb_build_object('ok',false,'code','STALE'); end if;
      perform 1 from public.cetld_core_automation_delivery_claims c where c.workspace_id=p_workspace_id
        and c.invoice_id=v_invoice.id and c.status='sending' for update;
      if found then return pg_catalog.jsonb_build_object('ok',false,'code','IN_USE'); end if;
      insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
        values(pg_catalog.pg_backend_pid(),pg_catalog.txid_current(),v_invoice.id);
      update public.invoices i set deleted_at=v_now,deleted_by=p_owner_id,followup_state='cancelled',next_follow_up_at=null,
        metadata=pg_catalog.jsonb_set(pg_catalog.jsonb_set(i.metadata,'{followup_state}','"cancelled"'::jsonb,true),
          '{next_follow_up_at}','null'::jsonb,true)
        where i.workspace_id=p_workspace_id and i.id=v_invoice.id returning * into v_invoice;
      delete from app.invoice_lifecycle_write_context where backend_pid=pg_catalog.pg_backend_pid()
        and transaction_id=pg_catalog.txid_current() and invoice_id=v_invoice.id;
      update public.cetld_core_automation_delivery_claims set status='cancelled',delivery_token=null
        where workspace_id=p_workspace_id and invoice_id=v_invoice.id and status in ('claimed','failed');
      update public.cetld_core_automation_messages set status='blocked'
        where workspace_id=p_workspace_id and invoice_id=v_invoice.id and kind='reminder' and status='pending';
      update public.whatsapp_messages set status='blocked',updated_at=v_now
        where workspace_id=p_workspace_id and invoice_id=v_invoice.id and direction='outbound'
          and audience='customer' and kind='reminder' and status='pending';
      update public.whatsapp_pending_actions set consumed_at=v_now where workspace_id=p_workspace_id
        and customer_id=v_owner.customer_id and phone=p_phone and consumed_at is null and action->>'invoiceId'=v_invoice.id::text;
      update public.invoice_lifecycle_proposals set state='deleted',deleted_at=v_now,confirmation_message_id=p_provider_message_id
        where id=v_lifecycle.id;
      insert into public.cetld_core_automation_events(workspace_id,invoice_id,type,idempotency_key,metadata)
        values(p_workspace_id,v_invoice.id,'invoice_deleted','button_invoice_delete:'||v_lifecycle.id::text,
          pg_catalog.jsonb_build_object('owner_id',p_owner_id,'provider_message_id',p_provider_message_id,
            'invoice_number',v_invoice.invoice_number,'deleted_at',v_now)) on conflict(workspace_id,idempotency_key) do nothing;
      v_action:='invoice.deleted';v_entity_type:='invoice';v_entity_id:=v_invoice.id::text;v_updated_at:=v_invoice.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_invoice.id,'workspace_id',v_invoice.workspace_id,
        'customer_id',v_invoice.customer_id,'invoice_number',v_invoice.invoice_number,'issue_date',v_invoice.issue_date,
        'due_date',v_invoice.due_date,'currency',v_invoice.currency,'total_amount',v_invoice.total_amount::text,
        'amount_paid',v_invoice.amount_paid::text,'status',v_invoice.status::text,'notes',v_invoice.notes,
        'metadata',v_invoice.metadata,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at,
        'deleted_at',v_invoice.deleted_at,'deleted_by',v_invoice.deleted_by);
    elsif v_pending_type='owner_workspace_data_change' then
      begin v_proposal_id:=(v_pending.action->>'proposalId')::uuid; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
      select * into v_proposal from public.whatsapp_workspace_data_proposals p where p.id=v_proposal_id
        and p.workspace_id=p_workspace_id and p.owner_id=p_owner_id and p.customer_id=v_owner.customer_id and p.phone=p_phone;
      if not found or v_proposal.request_message_id is distinct from v_source_message_id then return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION'); end if;
      if v_proposal.table_name='customers' and v_proposal.operation='delete' then
        select * into v_customer from public.customers c where c.workspace_id=p_workspace_id and c.id=v_proposal.target_id;
        if found then v_record:=pg_catalog.jsonb_build_object('id',v_customer.id,'workspace_id',v_customer.workspace_id,
          'name',v_customer.name,'company_name',v_customer.company_name,'email',v_customer.email,'phone',v_customer.phone,
          'metadata',v_customer.metadata,'created_at',v_customer.created_at,'updated_at',v_customer.updated_at); end if;
      end if;
      v_outcome:=public.whatsapp_workspace_data_decide(p_workspace_id,v_owner.customer_id,p_phone,v_pending.id,
        v_pending.version,v_proposal.id,case when p_button_decision='confirm' then p_provider_message_id else null end,
        case when p_button_decision='cancel' then p_provider_message_id else null end,v_event.message_text,true);
      if v_outcome->>'ok' is distinct from 'true' then
        return pg_catalog.jsonb_build_object('ok',false,'code',case v_outcome->>'reason'
          when 'stale' then 'STALE' when 'expired' then 'EXPIRED' when 'in_use' then 'IN_USE' else 'NO_PENDING_ACTION' end);
      end if;
      if v_proposal.table_name='customers' then
        v_entity_type:='customer';
        if v_proposal.operation='delete' then
          v_entity_id:=v_proposal.target_id::text;v_action:='customer.deleted';
          if v_record is null then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
        elsif v_proposal.operation='create' then
          select * into v_customer from public.customers c where c.workspace_id=p_workspace_id
            and c.name=v_proposal.values->>'name' and c.created_at>=v_pending.created_at
          order by c.created_at desc limit 1;
          if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
          v_entity_id:=v_customer.id::text;v_action:='customer.created';
          v_record:=pg_catalog.jsonb_build_object('id',v_customer.id,'workspace_id',v_customer.workspace_id,'name',v_customer.name,
            'company_name',v_customer.company_name,'email',v_customer.email,'phone',v_customer.phone,'metadata',v_customer.metadata,
            'created_at',v_customer.created_at,'updated_at',v_customer.updated_at);v_updated_at:=v_customer.updated_at;
        else
          select * into v_customer from public.customers c where c.workspace_id=p_workspace_id and c.id=v_proposal.target_id;
          if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
          v_entity_id:=v_customer.id::text;v_action:='customer.updated';v_updated_at:=v_customer.updated_at;
          v_record:=pg_catalog.jsonb_build_object('id',v_customer.id,'workspace_id',v_customer.workspace_id,'name',v_customer.name,
            'company_name',v_customer.company_name,'email',v_customer.email,'phone',v_customer.phone,'metadata',v_customer.metadata,
            'created_at',v_customer.created_at,'updated_at',v_customer.updated_at);
        end if;
      elsif v_proposal.table_name='workspace_settings' then
        select * into v_settings from public.workspace_settings s where s.workspace_id=p_workspace_id;
        if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
        v_entity_type:='settings';v_entity_id:=p_workspace_id::text;v_action:='settings.updated';v_updated_at:=v_settings.updated_at;
        v_record:=pg_catalog.jsonb_build_object('workspace_id',v_settings.workspace_id,'business_name',v_settings.business_name,
          'default_currency',v_settings.default_currency,'default_timezone',v_settings.default_timezone,
          'follow_up_preferences',v_settings.follow_up_preferences,'owner_bot_preferences',v_settings.owner_bot_preferences,
          'updated_at',v_settings.updated_at);
      else
        select * into v_ai from public.workspace_ai_settings a where a.workspace_id=p_workspace_id;
        if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
        v_entity_type:='ai_settings';v_entity_id:=p_workspace_id::text;v_action:='ai_settings.updated';v_updated_at:=v_ai.updated_at;
        v_record:=pg_catalog.jsonb_build_object('workspace_id',v_ai.workspace_id,'primary_model',v_ai.primary_model,
          'fallback_model',v_ai.fallback_model,'updated_at',v_ai.updated_at);
      end if;
    elsif v_pending_type in ('owner_invoice_update','owner_invoice_payment') then
      v_outcome:=public.whatsapp_confirm_owner_invoice_action(p_workspace_id,p_owner_id,p_phone,
        v_pending.id,v_pending.version,p_provider_message_id,true);
      if v_outcome->>'ok' is distinct from 'true' then
        return pg_catalog.jsonb_build_object('ok',false,'code',case v_outcome->>'reason'
          when 'stale' then 'STALE' when 'expired' then 'EXPIRED' when 'settled' then 'PAYMENT_GUARD' else 'NO_PENDING_ACTION' end);
      end if;
      begin v_invoice.id:=(v_pending.action->>'invoiceId')::uuid; exception when others then return pg_catalog.jsonb_build_object('ok',false,'code','INVALID'); end;
      select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id and i.id=v_invoice.id;
      if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
      if v_pending_type='owner_invoice_payment'
         and (v_invoice.status::text<>'paid' or v_invoice.amount_paid<v_invoice.total_amount) then
        raise exception using errcode='Z0002',message='payment outcome could not be verified'; end if;
      v_entity_type:='invoice';v_entity_id:=v_invoice.id::text;
      v_action:=case when v_pending_type='owner_invoice_payment' then 'invoice.paid' else 'invoice.updated' end;
      v_updated_at:=v_invoice.updated_at;
      v_record:=pg_catalog.jsonb_build_object('id',v_invoice.id,'workspace_id',v_invoice.workspace_id,
        'customer_id',v_invoice.customer_id,'invoice_number',v_invoice.invoice_number,'issue_date',v_invoice.issue_date,
        'due_date',v_invoice.due_date,'currency',v_invoice.currency,'total_amount',v_invoice.total_amount::text,
        'amount_paid',v_invoice.amount_paid::text,'status',v_invoice.status::text,'notes',v_invoice.notes,
        'metadata',v_invoice.metadata,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at,
        'deleted_at',v_invoice.deleted_at,'deleted_by',v_invoice.deleted_by);
    elsif v_pending_type in ('owner_invoice_create','owner_settings_update') then
      v_outcome:=public.whatsapp_confirm_owner_create_settings(p_workspace_id,p_owner_id,p_phone,
        v_pending.id,v_pending.version,p_provider_message_id);
      if v_outcome->>'ok' is distinct from 'true' then
        return pg_catalog.jsonb_build_object('ok',false,'code',case v_outcome->>'reason'
          when 'stale' then 'STALE' when 'expired' then 'EXPIRED' when 'invoice_exists' then 'INVOICE_EXISTS'
          when 'ambiguous_customer' then 'AMBIGUOUS' else 'NO_PENDING_ACTION' end);
      end if;
      if v_pending_type='owner_invoice_create' then
        select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id
          and i.metadata->>'assistant_idempotency_key'=v_pending.action->>'idempotencyKey' and i.deleted_at is null;
        if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
        v_entity_type:='invoice';v_entity_id:=v_invoice.id::text;v_action:='invoice.created';v_updated_at:=v_invoice.updated_at;
        v_record:=pg_catalog.jsonb_build_object('id',v_invoice.id,'workspace_id',v_invoice.workspace_id,
          'customer_id',v_invoice.customer_id,'invoice_number',v_invoice.invoice_number,'issue_date',v_invoice.issue_date,
          'due_date',v_invoice.due_date,'currency',v_invoice.currency,'total_amount',v_invoice.total_amount::text,
          'amount_paid',v_invoice.amount_paid::text,'status',v_invoice.status::text,'notes',v_invoice.notes,
          'metadata',v_invoice.metadata,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at,
          'deleted_at',v_invoice.deleted_at,'deleted_by',v_invoice.deleted_by);
      else
        select * into v_settings from public.workspace_settings s where s.workspace_id=p_workspace_id;
        if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
        v_entity_type:='settings';v_entity_id:=p_workspace_id::text;v_action:='settings.updated';v_updated_at:=v_settings.updated_at;
        v_record:=pg_catalog.jsonb_build_object('workspace_id',v_settings.workspace_id,'business_name',v_settings.business_name,
          'default_currency',v_settings.default_currency,'default_timezone',v_settings.default_timezone,
          'follow_up_preferences',v_settings.follow_up_preferences,'owner_bot_preferences',v_settings.owner_bot_preferences,
          'updated_at',v_settings.updated_at);
      end if;
    else
      return pg_catalog.jsonb_build_object('ok',false,'code','NO_PENDING_ACTION');
    end if;
  end if;

  v_result:=pg_catalog.jsonb_build_object('ok',true,'action',v_action,'entityType',v_entity_type,
    'entityId',v_entity_id,'updatedAt',v_updated_at,'record',v_record);
  insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,
    idempotency_key,request,result)
  values(p_provider_message_id,p_workspace_id,p_owner_id,p_phone,p_idempotency_key,v_request,v_result);
  return v_result;
exception
when sqlstate 'Z0002' then
  perform pg_catalog.set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
  perform pg_catalog.set_config('request.jwt.claim.role',coalesce(v_old_role,''),true);
  perform pg_catalog.set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
  return pg_catalog.jsonb_build_object('ok',false,'code','WRITE_UNCONFIRMED');
when unique_violation then
  return pg_catalog.jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');
when others then
  perform pg_catalog.set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
  perform pg_catalog.set_config('request.jwt.claim.role',coalesce(v_old_role,''),true);
  perform pg_catalog.set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
  return pg_catalog.jsonb_build_object('ok',false,'code','UNAVAILABLE');
end;
$$;

revoke all on function public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)
  to service_role;

-- Extend the existing owner proposal path with partial workspace settings
-- patches. Validation happens before a proposal is stored, then the decision
-- applies the patch to the locked current row so unrelated preferences survive.
create or replace function app.owner_workspace_settings_patch_valid(p_values jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_patch jsonb;
  v_key text;
  v_template text;
  v_remaining text;
begin
  if pg_catalog.jsonb_typeof(p_values) is distinct from 'object' or p_values='{}'::jsonb then
    return false;
  end if;
  if exists(select 1 from pg_catalog.jsonb_each(p_values) e
    where e.key not in ('business_name','default_currency','default_timezone','follow_up_preferences','owner_bot_preferences')) then
    return false;
  end if;
  if p_values ? 'business_name' and (
    pg_catalog.jsonb_typeof(p_values->'business_name') is distinct from 'string'
    or pg_catalog.length(pg_catalog.btrim(p_values->>'business_name')) not between 1 and 200
    or p_values->>'business_name' ~ '[[:cntrl:]]') then
    return false;
  end if;
  if p_values ? 'default_currency' and (
    pg_catalog.jsonb_typeof(p_values->'default_currency') is distinct from 'string'
    or p_values->>'default_currency' not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')) then
    return false;
  end if;
  if p_values ? 'default_timezone' and (
    pg_catalog.jsonb_typeof(p_values->'default_timezone') is distinct from 'string'
    or pg_catalog.length(p_values->>'default_timezone') not between 1 and 80
    or p_values->>'default_timezone' ~ '[[:cntrl:]]'
    or not exists(select 1 from pg_catalog.pg_timezone_names t where t.name=p_values->>'default_timezone')) then
    return false;
  end if;
  if p_values ? 'follow_up_preferences' then
    v_patch:=p_values->'follow_up_preferences';
    if pg_catalog.jsonb_typeof(v_patch) is distinct from 'object' or v_patch='{}'::jsonb
      or exists(select 1 from pg_catalog.jsonb_each(v_patch) e where e.key not in
        ('tone','maxReminders','cadenceDays','firstReminderDays','contactStart','contactEnd',
         'allowedWeekdays','escalation','stopOnPayment','pauseOnReply','dailySummary','reminderTemplate')) then
      return false;
    end if;
    if v_patch ? 'tone' and (pg_catalog.jsonb_typeof(v_patch->'tone') is distinct from 'string'
      or v_patch->>'tone' not in ('gentle','professional','firm')) then return false; end if;
    foreach v_key in array array['maxReminders','cadenceDays','firstReminderDays'] loop
      if v_patch ? v_key and (pg_catalog.jsonb_typeof(v_patch->v_key) is distinct from 'number'
        or (v_patch->>v_key)::numeric<>pg_catalog.trunc((v_patch->>v_key)::numeric)
        or (v_key='firstReminderDays' and (v_patch->>v_key)::numeric<0)
        or (v_key<>'firstReminderDays' and (v_patch->>v_key)::numeric<1)
        or (v_key='maxReminders' and (v_patch->>v_key)::numeric>20)
        or (v_key<>'maxReminders' and (v_patch->>v_key)::numeric>90)) then return false; end if;
    end loop;
    foreach v_key in array array['contactStart','contactEnd'] loop
      if v_patch ? v_key and (pg_catalog.jsonb_typeof(v_patch->v_key) is distinct from 'string'
        or v_patch->>v_key !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then return false; end if;
    end loop;
    foreach v_key in array array['pauseOnReply','dailySummary'] loop
      if v_patch ? v_key and pg_catalog.jsonb_typeof(v_patch->v_key) is distinct from 'boolean' then return false; end if;
    end loop;
    if v_patch ? 'allowedWeekdays' then
      if pg_catalog.jsonb_typeof(v_patch->'allowedWeekdays') is distinct from 'array' then return false; end if;
      if pg_catalog.jsonb_array_length(v_patch->'allowedWeekdays') not between 1 and 7
        or exists(select 1 from pg_catalog.jsonb_array_elements(v_patch->'allowedWeekdays') e(value)
          where pg_catalog.jsonb_typeof(e.value) is distinct from 'number') then return false; end if;
      if exists(select 1 from pg_catalog.jsonb_array_elements(v_patch->'allowedWeekdays') e(value)
          where (e.value::text)::numeric<>pg_catalog.trunc((e.value::text)::numeric)
            or (e.value::text)::numeric not between 0 and 6)
        or (select count(distinct (e.value::text)::numeric) from pg_catalog.jsonb_array_elements(v_patch->'allowedWeekdays') e(value))
          <>pg_catalog.jsonb_array_length(v_patch->'allowedWeekdays') then return false; end if;
    end if;
    if v_patch ? 'escalation' and (pg_catalog.jsonb_typeof(v_patch->'escalation') is distinct from 'string'
      or v_patch->>'escalation' not in ('pause','manual_review')) then return false; end if;
    if v_patch ? 'stopOnPayment' and (pg_catalog.jsonb_typeof(v_patch->'stopOnPayment') is distinct from 'boolean'
      or v_patch->'stopOnPayment'<>'true'::jsonb) then return false; end if;
    if v_patch ? 'reminderTemplate' then
      if pg_catalog.jsonb_typeof(v_patch->'reminderTemplate') is distinct from 'string'
        or pg_catalog.length(v_patch->>'reminderTemplate')>1000 then return false; end if;
      v_template:=v_patch->>'reminderTemplate';
      v_remaining:=v_template;
      foreach v_key in array array['{{business_name}}','{{customer_name}}','{{invoice_number}}','{{balance}}','{{due_date}}'] loop
        v_remaining:=pg_catalog.replace(v_remaining,v_key,'');
      end loop;
      if v_remaining ~ '[{}]' then return false; end if;
    end if;
  end if;
  if p_values ? 'owner_bot_preferences' then
    v_patch:=p_values->'owner_bot_preferences';
    if pg_catalog.jsonb_typeof(v_patch) is distinct from 'object' or v_patch='{}'::jsonb
      or exists(select 1 from pg_catalog.jsonb_each(v_patch) e where e.key not in
        ('assistantName','tone','language','replyLength','confirmationMode','serviceReplySignature','customInstruction')) then
      return false;
    end if;
    if v_patch ? 'assistantName' and (pg_catalog.jsonb_typeof(v_patch->'assistantName') is distinct from 'string'
      or pg_catalog.length(pg_catalog.btrim(v_patch->>'assistantName')) not between 1 and 50
      or v_patch->>'assistantName' ~ '[[:cntrl:]]') then return false; end if;
    if v_patch ? 'tone' and (pg_catalog.jsonb_typeof(v_patch->'tone') is distinct from 'string'
      or v_patch->>'tone' not in ('concise','friendly','formal')) then return false; end if;
    if v_patch ? 'language' and (pg_catalog.jsonb_typeof(v_patch->'language') is distinct from 'string'
      or v_patch->>'language' not in ('auto','English','Hindi','Hinglish','Bengali','Gujarati','Kannada','Malayalam','Marathi','Tamil','Telugu','Urdu')) then return false; end if;
    if v_patch ? 'replyLength' and (pg_catalog.jsonb_typeof(v_patch->'replyLength') is distinct from 'string'
      or v_patch->>'replyLength' not in ('short','balanced','detailed')) then return false; end if;
    if v_patch ? 'confirmationMode' and (pg_catalog.jsonb_typeof(v_patch->'confirmationMode') is distinct from 'string'
      or v_patch->>'confirmationMode' not in ('direct','buttons')) then return false; end if;
    if v_patch ? 'serviceReplySignature' and (pg_catalog.jsonb_typeof(v_patch->'serviceReplySignature') is distinct from 'string'
      or pg_catalog.length(v_patch->>'serviceReplySignature')>120
      or v_patch->>'serviceReplySignature' ~ '[[:cntrl:]]') then return false; end if;
    if v_patch ? 'customInstruction' and (pg_catalog.jsonb_typeof(v_patch->'customInstruction') is distinct from 'string'
      or pg_catalog.length(v_patch->>'customInstruction')>500
      or v_patch->>'customInstruction' ~ '[[:cntrl:]]') then return false; end if;
  end if;
  return true;
end;
$$;

create or replace function app.apply_owner_workspace_settings_patch(p_workspace_id uuid,p_values jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.workspace_settings%rowtype;
  v_rows integer;
begin
  if not app.owner_workspace_settings_patch_valid(p_values) then return false; end if;
  select * into v_settings from public.workspace_settings s where s.workspace_id=p_workspace_id for update;
  if not found then return false; end if;
  update public.workspace_settings s set
    business_name=case when p_values ? 'business_name' then p_values->>'business_name' else s.business_name end,
    default_currency=case when p_values ? 'default_currency' then p_values->>'default_currency' else s.default_currency end,
    default_timezone=case when p_values ? 'default_timezone' then p_values->>'default_timezone' else s.default_timezone end,
    follow_up_preferences=case when p_values ? 'follow_up_preferences'
      then coalesce(s.follow_up_preferences,'{}'::jsonb)||(p_values->'follow_up_preferences') else s.follow_up_preferences end,
    owner_bot_preferences=case when p_values ? 'owner_bot_preferences'
      then coalesce(s.owner_bot_preferences,'{}'::jsonb)||(p_values->'owner_bot_preferences') else s.owner_bot_preferences end
    where s.workspace_id=p_workspace_id;
  get diagnostics v_rows=row_count;
  return v_rows=1;
end;
$$;
revoke all on function app.owner_workspace_settings_patch_valid(jsonb) from public,anon,authenticated,service_role;
revoke all on function app.apply_owner_workspace_settings_patch(uuid,jsonb) from public,anon,authenticated,service_role;

-- Keep the existing generic proposal protocol and signature. Only broaden its
-- settings allowlist and add owner-contact protection to legacy customer edits.
do $extend_workspace_settings$
declare
  v_def text;
  v_before text;
  v_old text;
  v_new text;
begin
  v_def:=pg_catalog.replace(pg_catalog.pg_get_functiondef(
    'public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)'::regprocedure),
    pg_catalog.chr(13),'');
  v_old:=$old$if p_operation <> 'update' or p_target_id is distinct from p_workspace_id
       or p_expected_updated_at is null or p_values = '{}'::jsonb
       or exists(select 1 from pg_catalog.jsonb_each(p_values) e
         where e.key not in ('default_currency','default_timezone')
           or pg_catalog.jsonb_typeof(e.value) is distinct from 'string') then$old$;
  v_new:=$new$if p_operation <> 'update' or p_target_id is distinct from p_workspace_id
       or p_expected_updated_at is null or not app.owner_workspace_settings_patch_valid(p_values) then$new$;
  v_old:=pg_catalog.replace(v_old,pg_catalog.chr(13),'');v_new:=pg_catalog.replace(v_new,pg_catalog.chr(13),'');
  v_before:=v_def;v_def:=pg_catalog.replace(v_def,v_old,v_new);
  if v_def=v_before then raise exception 'workspace settings proposal allowlist patch point missing'; end if;
  v_old:=$old$if coalesce(v_customer_metadata->>'whatsapp_owner','false')='true'
         or v_row_updated_at is distinct from p_expected_updated_at then$old$;
  v_new:=$new$if p_target_id=v_owner.customer_id or coalesce(v_customer_metadata->>'whatsapp_owner','false')='true'
         or v_row_updated_at is distinct from p_expected_updated_at then$new$;
  v_old:=pg_catalog.replace(v_old,pg_catalog.chr(13),'');v_new:=pg_catalog.replace(v_new,pg_catalog.chr(13),'');
  v_before:=v_def;v_def:=pg_catalog.replace(v_def,v_old,v_new);
  if v_def=v_before then raise exception 'workspace customer update protection patch point missing'; end if;
  execute v_def;

  v_def:=pg_catalog.replace(pg_catalog.pg_get_functiondef(
    'public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure),
    pg_catalog.chr(13),'');
  v_old:=$old$or coalesce(v_metadata->>'whatsapp_owner','false')='true' then$old$;
  v_new:=$new$or v_proposal.target_id=v_owner.customer_id
       or coalesce(v_metadata->>'whatsapp_owner','false')='true' then$new$;
  v_old:=pg_catalog.replace(v_old,pg_catalog.chr(13),'');v_new:=pg_catalog.replace(v_new,pg_catalog.chr(13),'');
  v_before:=v_def;v_def:=pg_catalog.replace(v_def,v_old,v_new);
  if v_def=v_before then raise exception 'workspace customer decision protection patch point missing'; end if;
  v_old:=$old$update public.workspace_settings s set
      default_currency=case when v_proposal.values ? 'default_currency' then v_proposal.values->>'default_currency' else s.default_currency end,
      default_timezone=case when v_proposal.values ? 'default_timezone' then v_proposal.values->>'default_timezone' else s.default_timezone end
      where s.workspace_id=p_workspace_id;$old$;
  v_new:=$new$if not app.apply_owner_workspace_settings_patch(p_workspace_id,v_proposal.values) then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;$new$;
  v_old:=pg_catalog.replace(v_old,pg_catalog.chr(13),'');v_new:=pg_catalog.replace(v_new,pg_catalog.chr(13),'');
  v_before:=v_def;v_def:=pg_catalog.replace(v_def,v_old,v_new);
  if v_def=v_before then raise exception 'workspace settings decision patch point missing'; end if;
  execute v_def;
end;
$extend_workspace_settings$;

commit;
