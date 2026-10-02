-- Apply verified-owner invoice creation and workspace settings proposals in the
-- same transaction that consumes the exact pending action and records a receipt.
begin;

create or replace function public.whatsapp_confirm_owner_create_settings(
  p_workspace_id uuid,
  p_owner_id uuid,
  p_phone text,
  p_action_id bigint,
  p_version bigint,
  p_confirmation_message_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_owner record;
  v_pending public.whatsapp_pending_actions%rowtype;
  v_event public.whatsapp_inbound_events%rowtype;
  v_receipt public.whatsapp_owner_action_receipts%rowtype;
  v_settings public.workspace_settings%rowtype;
  v_customer public.customers%rowtype;
  v_invoice public.invoices%rowtype;
  v_action_type text;
  v_expires_at timestamptz;
  v_expected_updated_at timestamptz;
  v_request jsonb;
  v_patch jsonb;
  v_invoice_input jsonb;
  v_business_name text;
  v_client_name text;
  v_client_email text;
  v_client_phone text;
  v_client_phone_raw text;
  v_invoice_number text;
  v_currency text;
  v_notes text;
  v_idempotency_key text;
  v_issue_date date;
  v_due_date date;
  v_total numeric;
  v_subtotal numeric;
  v_tax numeric;
  v_outstanding numeric;
  v_number numeric;
  v_customer_count integer;
  v_existing_count integer;
  v_changed jsonb := '[]'::jsonb;
  v_metadata jsonb;
  v_result jsonb;
  v_key text;
  v_preferences jsonb;
  v_confirmation text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_role := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.role', true),''),auth.role(),'');
  if v_role <> 'service_role' or p_workspace_id is null or p_owner_id is null
     or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$'
     or (p_action_id is null) is distinct from (p_version is null)
     or p_confirmation_message_id is null
     or pg_catalog.length(p_confirmation_message_id) not between 1 and 256 then
    return pg_catalog.jsonb_build_object('ok',false,'reason','unbound');
  end if;

  -- Match the existing owner action RPC lock order so confirmations serialize
  -- with cancellation, replacement, and other writes for the verified phone.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone)) <> 1 then
    return pg_catalog.jsonb_build_object('ok',false,'reason','unbound');
  end if;
  select r.* into v_owner from public.whatsapp_resolve_verified_owner(p_phone) r
    where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','unbound'); end if;

  -- A retry may arrive after the successful transaction consumed its pending
  -- action. With both action identifiers null, allow only a receipt lookup for
  -- this exact, still-stored inbound YES turn and this verified owner binding.
  -- It cannot claim or modify a pending action.
  if p_action_id is null then
    select * into v_event from public.whatsapp_inbound_events e
      where e.provider_message_id=p_confirmation_message_id and e.sender_phone=p_phone
        and e.status in ('processing','done') for update;
    if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','no_action'); end if;
    v_confirmation := pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(coalesce(v_event.message_text,''))), '[.!]$', '');
    if v_confirmation not in ('yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve') then
      return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
    end if;
    select * into v_receipt from public.whatsapp_owner_action_receipts r
      where r.provider_message_id=p_confirmation_message_id;
    if not found or v_receipt.workspace_id is distinct from p_workspace_id
       or v_receipt.owner_id is distinct from p_owner_id or v_receipt.phone is distinct from p_phone
       or v_receipt.result->>'ok' is distinct from 'true'
       or (v_receipt.result->>'actionType' is distinct from 'owner_invoice_create'
         and v_receipt.result->>'actionType' is distinct from 'owner_settings_update') then
      return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
    end if;
    return v_receipt.result || pg_catalog.jsonb_build_object('replayed',true);
  end if;

  select * into v_receipt from public.whatsapp_owner_action_receipts r
    where r.provider_message_id=p_confirmation_message_id for update;
  if found then
    if v_receipt.workspace_id<>p_workspace_id or v_receipt.owner_id<>p_owner_id
       or v_receipt.phone<>p_phone or v_receipt.action_id is distinct from p_action_id then
      return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
    end if;
    return v_receipt.result || pg_catalog.jsonb_build_object('replayed',true);
  end if;

  select * into v_event from public.whatsapp_inbound_events e
    where e.provider_message_id=p_confirmation_message_id and e.sender_phone=p_phone
      and e.status in ('processing','done') for update;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation'); end if;
  v_confirmation := pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(coalesce(v_event.message_text,''))), '[.!]$', '');
  if v_confirmation not in ('yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve') then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text||':'||v_owner.customer_id::text||':'||p_phone,0));
  select * into v_pending from public.whatsapp_pending_actions p
    where p.id=p_action_id and p.workspace_id=p_workspace_id
      and p.customer_id=v_owner.customer_id and p.phone=p_phone for update;
  if not found or v_pending.consumed_at is not null or v_pending.version is distinct from p_version then
    return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
  end if;
  v_action_type := v_pending.action->>'type';
  if v_action_type not in ('owner_invoice_create','owner_settings_update') then
    return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
  end if;
  if nullif(v_pending.action->>'sourceMessageId','') is null
     or v_pending.action->>'sourceMessageId'=p_confirmation_message_id
     or v_event.received_at<v_pending.created_at
     or coalesce(v_event.provider_timestamp,v_event.received_at)+interval '1 second'<v_pending.created_at then
    v_result := pg_catalog.jsonb_build_object('ok',false,'reason','stale_confirmation');
    insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
      values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,v_pending.id,v_result);
    return v_result;
  end if;
  begin
    v_expires_at := (v_pending.action->>'expiresAt')::timestamptz;
  exception when others then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
  end;
  if v_expires_at is null then return pg_catalog.jsonb_build_object('ok',false,'reason','invalid'); end if;
  if v_pending.created_at<v_now-interval '10 minutes' or v_expires_at<=v_now then
    update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
    v_result := pg_catalog.jsonb_build_object('ok',false,'reason','expired');
    insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
      values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,v_pending.id,v_result);
    return v_result;
  end if;

  if v_action_type='owner_settings_update' then
    v_request := v_pending.action->'request';
    if pg_catalog.jsonb_typeof(v_request) is distinct from 'object'
       or not (v_request ? 'businessName')
       or pg_catalog.jsonb_typeof(v_request->'businessName') not in ('null','string') then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    v_business_name := case when pg_catalog.jsonb_typeof(v_request->'businessName')='null'
      then null else pg_catalog.btrim(v_request->>'businessName') end;
    if v_business_name is not null and pg_catalog.length(v_business_name) not between 1 and 200 then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    v_patch := coalesce(v_request->'patch','{}'::jsonb);
    if pg_catalog.jsonb_typeof(v_patch) is distinct from 'object'
       or (v_business_name is null and v_patch='{}'::jsonb)
       or exists(select 1 from pg_catalog.jsonb_object_keys(v_patch) as keys(key)
         where keys.key not in ('tone','maxReminders','cadenceDays','firstReminderDays','contactStart','contactEnd','pauseOnReply','dailySummary')) then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    if v_patch ? 'tone' and (pg_catalog.jsonb_typeof(v_patch->'tone')<>'string'
       or v_patch->>'tone' not in ('gentle','professional','firm')) then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    foreach v_key in array array['maxReminders','cadenceDays','firstReminderDays'] loop
      if v_patch ? v_key then
        if pg_catalog.jsonb_typeof(v_patch->v_key)<>'number' then
          return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
        end if;
        v_number := (v_patch->>v_key)::numeric;
        if v_number<>pg_catalog.trunc(v_number)
           or (v_key='firstReminderDays' and v_number<0)
           or (v_key<>'firstReminderDays' and v_number<1)
           or (v_key='maxReminders' and v_number>20)
           or (v_key<>'maxReminders' and v_number>90) then
          return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
        end if;
      end if;
    end loop;
    foreach v_key in array array['contactStart','contactEnd'] loop
      if v_patch ? v_key and (pg_catalog.jsonb_typeof(v_patch->v_key)<>'string'
         or v_patch->>v_key !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end if;
    end loop;
    foreach v_key in array array['pauseOnReply','dailySummary'] loop
      if v_patch ? v_key and pg_catalog.jsonb_typeof(v_patch->v_key)<>'boolean' then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end if;
    end loop;
    begin
      v_expected_updated_at := (v_pending.action->>'expectedUpdatedAt')::timestamptz;
    exception when others then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end;
    select * into v_settings from public.workspace_settings s
      where s.workspace_id=p_workspace_id for update;
    if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','no_action'); end if;
    if v_settings.updated_at is distinct from v_expected_updated_at then
      update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
      v_result := pg_catalog.jsonb_build_object('ok',false,'reason','stale');
      insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
        values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,v_pending.id,v_result);
      return v_result;
    end if;
    v_preferences := v_settings.follow_up_preferences || v_patch;
    if v_business_name is not null and v_business_name is distinct from v_settings.business_name then
      v_changed := v_changed || pg_catalog.jsonb_build_array('businessName');
    end if;
    for v_key in select pg_catalog.jsonb_object_keys(v_patch) loop
      if v_settings.follow_up_preferences->v_key is distinct from v_patch->v_key then
        v_changed := v_changed || pg_catalog.jsonb_build_array(v_key);
      end if;
    end loop;
    update public.workspace_settings set
      business_name=case when v_business_name is null then business_name else v_business_name end,
      follow_up_preferences=v_preferences
      where workspace_id=p_workspace_id returning * into v_settings;
    update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
    v_result := pg_catalog.jsonb_build_object('ok',true,'actionType',v_action_type,
      'businessName',v_settings.business_name,'changed',v_changed);
  else
    v_invoice_input := v_pending.action->'invoice';
    v_idempotency_key := v_pending.action->>'idempotencyKey';
    if pg_catalog.jsonb_typeof(v_invoice_input) is distinct from 'object'
       or v_invoice_input->>'direction' is distinct from 'receivable'
       or v_invoice_input->'alreadyPaid' is distinct from 'false'::jsonb
       or v_idempotency_key is null or v_idempotency_key !~ '^[A-Za-z0-9_-]{12,100}$' then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    v_invoice_number := pg_catalog.btrim(coalesce(v_invoice_input->>'invoiceNumber',''));
    v_client_name := pg_catalog.btrim(coalesce(v_invoice_input->>'clientName',''));
    v_currency := v_invoice_input->>'currency';
    v_client_email := nullif(pg_catalog.btrim(v_invoice_input->>'clientEmail'),'');
    v_client_phone := nullif(pg_catalog.btrim(v_invoice_input->>'clientPhone'),'');
    v_client_phone_raw := nullif(pg_catalog.btrim(v_invoice_input->>'clientPhoneRaw'),'');
    v_notes := nullif(pg_catalog.btrim(v_invoice_input->>'notes'),'');
    if pg_catalog.length(v_invoice_number) not between 1 and 100
       or pg_catalog.length(v_client_name) not between 1 and 200
       or v_currency is null or v_currency not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')
       or v_client_email is not null and (pg_catalog.length(v_client_email)>320 or v_client_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
       or v_client_phone is not null and pg_catalog.length(v_client_phone)>40
       or v_client_phone_raw is not null and pg_catalog.length(v_client_phone_raw)>80
       or v_notes is not null and pg_catalog.length(v_notes)>2000
       or pg_catalog.jsonb_typeof(v_invoice_input->'lineItems') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_invoice_input->'lineItems')>100 then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
     if v_invoice_input->>'invoiceDate' is null or v_invoice_input->>'invoiceDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or v_invoice_input->>'dueDate' is null or v_invoice_input->>'dueDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or pg_catalog.jsonb_typeof(v_invoice_input->'total') is distinct from 'number'
        or pg_catalog.jsonb_typeof(v_invoice_input->'outstanding') is distinct from 'number'
        or not (v_invoice_input ? 'subtotal')
        or pg_catalog.jsonb_typeof(v_invoice_input->'subtotal') not in ('null','number')
        or not (v_invoice_input ? 'tax')
        or pg_catalog.jsonb_typeof(v_invoice_input->'tax') not in ('null','number')
        or pg_catalog.jsonb_typeof(v_invoice_input->'lineItems') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_invoice_input->'lineItems')<>0 then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    begin
      v_issue_date := (v_invoice_input->>'invoiceDate')::date;
      v_due_date := (v_invoice_input->>'dueDate')::date;
      v_total := (v_invoice_input->>'total')::numeric;
      v_outstanding := (v_invoice_input->>'outstanding')::numeric;
      v_subtotal := (v_invoice_input->>'subtotal')::numeric;
      v_tax := (v_invoice_input->>'tax')::numeric;
    exception when others then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end;
    if v_due_date<v_issue_date or v_total<=0 or v_total>999999999999.99 or pg_catalog.scale(v_total)>2
       or v_outstanding is distinct from v_total or pg_catalog.scale(v_outstanding)>2
       or v_subtotal<0 or v_subtotal>v_total or pg_catalog.scale(v_subtotal)>2
       or v_tax<0 or v_tax>v_total or pg_catalog.scale(v_tax)>2
       or v_subtotal is not null and v_tax is not null and pg_catalog.abs(v_total-v_subtotal-v_tax)>0.01 then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;

    -- The same idempotency key may have been saved by the former client-side
    -- confirmation path whose pending-action cleanup failed. Recover that exact
    -- active invoice before considering the requested invoice number. Never
    -- create a second row after the original was renamed or tombstoned.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_workspace_id::text||':owner-create:'||v_idempotency_key,4));
    select count(*)::integer into v_existing_count from public.invoices i
      where i.workspace_id=p_workspace_id and i.metadata->>'assistant_idempotency_key'=v_idempotency_key;
    if v_existing_count>1 then return pg_catalog.jsonb_build_object('ok',false,'reason','stale'); end if;
    select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id
      and i.metadata->>'assistant_idempotency_key'=v_idempotency_key for update;
    if found then
      select c.name into v_client_name from public.customers c
        where c.workspace_id=p_workspace_id and c.id=v_invoice.customer_id;
      if v_invoice.deleted_at is not null or v_client_name is distinct from pg_catalog.btrim(v_invoice_input->>'clientName')
         or v_invoice.issue_date is distinct from v_issue_date or v_invoice.due_date is distinct from v_due_date
         or v_invoice.currency is distinct from v_currency or v_invoice.total_amount is distinct from v_total
         or v_invoice.amount_paid<>0 or v_invoice.notes is distinct from v_notes
         or v_invoice.metadata->>'invoice_direction' is distinct from 'receivable'
         or (v_invoice_number='AUTO' and (v_invoice.metadata->>'printed_invoice_number' is not null
              or v_invoice.metadata->>'source_invoice_number' is not null))
         or (v_invoice_number<>'AUTO' and (
              coalesce(v_invoice.metadata->>'printed_invoice_number',v_invoice.invoice_number)
                is distinct from pg_catalog.btrim(v_invoice_input->>'invoiceNumber')
              or coalesce(v_invoice.metadata->>'source_invoice_number',pg_catalog.btrim(v_invoice_input->>'invoiceNumber'))
                is distinct from pg_catalog.btrim(v_invoice_input->>'invoiceNumber')))
         or v_invoice.metadata->>'client_email' is distinct from v_client_email
         or v_invoice.metadata->>'client_phone' is distinct from v_client_phone
         or v_invoice.metadata->>'client_phone_raw' is distinct from v_client_phone_raw
         or v_invoice.metadata->>'outstanding_amount' is distinct from v_invoice_input->>'outstanding'
         or v_invoice.metadata->'subtotal' is distinct from v_invoice_input->'subtotal'
         or v_invoice.metadata->'tax' is distinct from v_invoice_input->'tax'
         or v_invoice.metadata->'line_items' is distinct from v_invoice_input->'lineItems' then
        return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
      end if;
      v_client_name := (select c.name from public.customers c
        where c.workspace_id=p_workspace_id and c.id=v_invoice.customer_id);
    else
      -- Customer creation and invoice insertion form one subtransaction. If
      -- the invoice number collides, roll back a just-created customer too.
      begin
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||v_client_name,3));
        select count(*)::integer into v_customer_count from public.customers c
          where c.workspace_id=p_workspace_id and c.name=v_client_name
            and (v_client_email is null or c.email=v_client_email);
        if v_customer_count>1 then
          return pg_catalog.jsonb_build_object('ok',false,'reason','ambiguous_customer');
        end if;
        if v_customer_count=1 then
          select * into v_customer from public.customers c where c.workspace_id=p_workspace_id
            and c.name=v_client_name and (v_client_email is null or c.email=v_client_email) limit 1;
        else
          insert into public.customers(workspace_id,name,email,phone)
            values(p_workspace_id,v_client_name,v_client_email,v_client_phone) returning * into v_customer;
        end if;
    v_metadata := pg_catalog.jsonb_build_object(
      'assistant_idempotency_key',v_idempotency_key,'invoice_direction','receivable',
      'bookkeeping_sync_status','not_configured','bookkeeping_sync_error',null,
      'followup_state','draft','next_follow_up_at',null,'subtotal',v_subtotal,'tax',v_tax,
      'outstanding_amount',v_total,'client_name',v_client_name,
      'printed_invoice_number',case when v_invoice_number='AUTO' then null else v_invoice_number end,
      'debtor_phone',v_client_phone,'client_phone',v_client_phone,'client_phone_raw',v_client_phone_raw,
      'client_email',v_client_email,'line_items',v_invoice_input->'lineItems');
        insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,
          total_amount,notes,metadata)
          values(p_workspace_id,v_customer.id,v_invoice_number,v_issue_date,v_due_date,v_currency,v_total,v_notes,v_metadata)
          on conflict (workspace_id,invoice_number) do nothing
          returning * into v_invoice;
        if not found then
          raise exception using errcode='Z0001',message='owner invoice number collision';
        end if;
      exception when sqlstate 'Z0001' then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invoice_exists');
      end;
    end if;
    update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
    v_result := pg_catalog.jsonb_build_object('ok',true,'actionType',v_action_type,
      'invoiceNumber',v_invoice.invoice_number,'customerName',v_client_name,
      'total',v_invoice.total_amount,'currency',v_invoice.currency,'dueDate',v_invoice.due_date);
  end if;

  insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
    values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,v_pending.id,v_result);
  return v_result;
end;
$$;

revoke all on function public.whatsapp_confirm_owner_create_settings(uuid,uuid,text,bigint,bigint,text)
  from public,anon,authenticated;
grant execute on function public.whatsapp_confirm_owner_create_settings(uuid,uuid,text,bigint,bigint,text)
  to service_role;

commit;
