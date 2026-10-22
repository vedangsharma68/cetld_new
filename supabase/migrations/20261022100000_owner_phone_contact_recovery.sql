-- Apply only inside the existing verified-owner write RPCs. Accounting imports,
-- dashboard writes and the reminder send/eligibility gates are unchanged.
create or replace function app.owner_contact_phone_normalize()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_setting('app.owner_contact_write',true) is distinct from 'on'
    or coalesce(new.metadata->>'whatsapp_owner','false')='true' or new.phone is null then return new; end if;
  if tg_op='UPDATE' and new.phone is not distinct from old.phone
    and current_setting('app.owner_contact_supplied',true) is distinct from 'on' then return new; end if;
  if new.phone !~ '^\+?[0-9[:space:]-]+$' then
    raise exception 'Send it with the country code, like +919818685252.' using errcode='22023';
  end if;
  new.phone:=regexp_replace(btrim(new.phone),'[[:space:]-]','','g');
  if new.phone ~ '^[6-9][0-9]{9}$' then new.phone:='+91'||new.phone; end if;
  if new.phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Send it with the country code, like +919818685252.' using errcode='22023';
  end if;
  return new;
end $$;

create or replace function app.owner_contact_phone_consent()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if current_setting('app.owner_contact_write',true) is distinct from 'on'
    or coalesce(new.metadata->>'whatsapp_owner','false')='true' or new.phone is null then return new; end if;
  if tg_op='UPDATE' and new.phone is not distinct from old.phone
    and current_setting('app.owner_contact_supplied',true) is distinct from 'on' then return new; end if;
  -- Owner-supplied numbers carry assumed consent. Never revive revoked consent,
  -- overwrite another customer's binding, or remove STOP suppression records.
  insert into public.whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,consented_by,categories)
    select new.workspace_id,new.id,new.phone,'verbal','owner_supplied_assumed_v1',w.owner_id,array['invoice_updates']
    from public.workspaces w where w.id=new.workspace_id
  on conflict(workspace_id,phone) do nothing;
  return new;
end $$;
revoke all on function app.owner_contact_phone_normalize(),app.owner_contact_phone_consent() from public,anon,authenticated;
create trigger owner_contact_phone_normalize before insert or update of phone on public.customers
for each row execute function app.owner_contact_phone_normalize();
create trigger owner_contact_phone_consent after insert or update of phone on public.customers
for each row execute function app.owner_contact_phone_consent();

-- Function-local settings restore automatically, including exceptions/rollbacks.
-- Every existing authorization, receipt, CAS and batch rollback remains in force.
alter function public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb) set app.owner_contact_write='on';
alter function public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean) set app.owner_contact_write='on';
alter function public.whatsapp_confirm_owner_create_settings(uuid,uuid,text,bigint,bigint,text) set app.owner_contact_write='on';

create or replace function public.whatsapp_owner_save_phone(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_customer_id uuid,p_invoice_id uuid,
 p_contact_phone text,p_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path='' set app.owner_contact_write='on' set app.owner_contact_supplied='on' as $$
declare c public.customers%rowtype; i public.invoices%rowtype;
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.role(),'')<>'service_role'
 or (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) b where b.workspace_id=p_workspace_id and b.owner_id=p_owner_id)<>1
 or not exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_message_id and e.sender_phone=p_phone and e.message_text=p_user_message)
 then return jsonb_build_object('ok',false,'code','DENIED'); end if;
 select * into c from public.customers where workspace_id=p_workspace_id and id=p_customer_id for update;
 if not found or coalesce(c.metadata->>'whatsapp_owner','false')='true' then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
 -- A typed contact must occur in the current message. An attachment review
 -- instead attests its persisted phone only while that scoped review saves.
 if regexp_replace(p_user_message,'[^0-9]','','g') not in
    (regexp_replace(p_contact_phone,'[^0-9]','','g'),regexp_replace(p_contact_phone,'^\+91',''))
    and not exists(select 1 from public.whatsapp_pending_actions a
      join public.whatsapp_resolve_verified_owner(p_phone) b on b.workspace_id=a.workspace_id and b.customer_id=a.customer_id
      where a.workspace_id=p_workspace_id and a.phone=p_phone and a.consumed_at is null
      and a.action->>'type'='invoice_debtor_phone' and a.action->>'stage'='awaiting_phone'
      and a.action->>'invoiceId'=p_invoice_id::text and p_user_message ~ '^\+[0-9]{1,3}[.!]?$'
      and p_contact_phone='+'||regexp_replace(p_user_message,'[^0-9]','','g')||regexp_replace(a.action->>'clientPhoneRaw','[^0-9]','','g'))
    and not exists(select 1 from public.whatsapp_pending_actions a
      join public.whatsapp_resolve_verified_owner(p_phone) b on b.workspace_id=a.workspace_id and b.customer_id=a.customer_id
      where a.workspace_id=p_workspace_id and a.phone=p_phone and a.consumed_at is null and a.expires_at>now()
      and a.action->>'type'='invoice_review_draft' and a.action->>'stage'='saving'
      and a.action#>>'{invoice,clientName}'=c.name
      and (nullif(a.action#>>'{invoice,clientEmail}','') is null or a.action#>>'{invoice,clientEmail}'=c.email)
      and regexp_replace(a.action#>>'{invoice,clientPhone}','[[:space:]-]','','g')
        in (p_contact_phone,regexp_replace(p_contact_phone,'^\+91','')) for share of a) then
   return jsonb_build_object('ok',false,'code','INVALID'); end if;
 if p_invoice_id is not null then
   select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id and customer_id=c.id and deleted_at is null for update;
   if not found then return jsonb_build_object('ok',false,'code','STALE'); end if;
 end if;
 update public.customers set phone=p_contact_phone where workspace_id=p_workspace_id and id=c.id returning * into c;
 if p_invoice_id is not null then
   update public.invoices set metadata=(metadata-'debtor_consent')||jsonb_build_object('debtor_phone',c.phone,'client_phone',c.phone)
     where workspace_id=p_workspace_id and id=i.id;
 end if;
 return jsonb_build_object('ok',true,'completed',true,'customerId',c.id,'customerName',c.name,'phone',c.phone);
end $$;
revoke all on function public.whatsapp_owner_save_phone(uuid,uuid,text,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_owner_save_phone(uuid,uuid,text,uuid,uuid,text,text,text) to service_role;

-- A business profile field is not ownership proof. Keep every phone, consent,
-- membership and verification check; let the existing reminder gate request it.
do $$
declare definition text;
begin
 select pg_get_functiondef('public.whatsapp_resolve_verified_owner(text)'::regprocedure) into definition;
 if position('and nullif(pg_catalog.btrim(s.business_name),'''') is not null' in definition)=0 then
   raise exception 'owner binding shape changed';
 end if;
 definition:=replace(definition,'and nullif(pg_catalog.btrim(s.business_name),'''') is not null','');
 definition:=replace(definition,'w.id,w.owner_id,c.customer_id,s.business_name','w.id,w.owner_id,c.customer_id,coalesce(s.business_name,'''')');
 execute definition;
end $$;

-- A failed contact lookup is conversational context, never a pending approval.
-- Store the resolved target so model phrasing cannot lose or retarget recovery.
create table public.whatsapp_owner_contact_recovery (
 workspace_id uuid not null,
 owner_id uuid not null,
 phone text not null,
 invoice_id uuid not null,
 customer_id uuid not null,
 request_message text not null,
 send_now boolean not null,
 reason text not null check(reason='missing_contact'),
 expires_at timestamptz not null,
 primary key(workspace_id,owner_id,phone),
 foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id) on delete cascade,
 foreign key(workspace_id,customer_id) references public.customers(workspace_id,id) on delete cascade,
 foreign key(workspace_id,invoice_id) references public.invoices(workspace_id,id) on delete cascade
);
alter table public.whatsapp_owner_contact_recovery enable row level security;
alter table public.whatsapp_owner_contact_recovery force row level security;
revoke all on public.whatsapp_owner_contact_recovery from public,anon,authenticated;
grant select,insert,update,delete on public.whatsapp_owner_contact_recovery to service_role;

-- Invoice creation/review can also supply a debtor phone for an existing
-- customer. Route that write through the same customer validator+saver.
create or replace function app.owner_invoice_contact_phone()
returns trigger language plpgsql set search_path='' as $$
declare supplied text; normalized text; previous_supplied text;
begin
 if current_setting('app.owner_contact_write',true) is distinct from 'on' then return new; end if;
 if tg_op='INSERT' then
   supplied:=coalesce(new.metadata->>'client_phone',new.metadata->>'debtor_phone');
 elsif new.metadata->>'client_phone' is distinct from old.metadata->>'client_phone' then
   supplied:=new.metadata->>'client_phone';
 elsif new.metadata->>'debtor_phone' is distinct from old.metadata->>'debtor_phone' then
   supplied:=new.metadata->>'debtor_phone';
 end if;
 if supplied is null then return new; end if;
 previous_supplied:=current_setting('app.owner_contact_supplied',true);
 perform set_config('app.owner_contact_supplied','on',true);
 update public.customers set phone=supplied
   where workspace_id=new.workspace_id and id=new.customer_id and coalesce(metadata->>'whatsapp_owner','false')<>'true'
   returning phone into normalized;
 perform set_config('app.owner_contact_supplied',coalesce(previous_supplied,'off'),true);
 if normalized is not null then
   new.metadata:=new.metadata||jsonb_build_object('client_phone',normalized,'debtor_phone',normalized);
 end if;
 return new;
end $$;
revoke all on function app.owner_invoice_contact_phone() from public,anon,authenticated;
create trigger owner_invoice_contact_phone before insert or update of metadata on public.invoices
for each row execute function app.owner_invoice_contact_phone();

-- An unrelated customer edit must not attest to a previously imported phone.
-- Distinguish an explicit re-supply of the same phone from an untouched value.
alter function public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean) set app.owner_contact_supplied='off';
do $$
declare definition text; patched text;
begin
 select pg_get_functiondef('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure) into definition;
 patched:=replace(definition,'update public.customers c set',
   'perform set_config(''app.owner_contact_supplied'',case when v_proposal.values ? ''phone'' then ''on'' else ''off'' end,true); update public.customers c set');
 if patched=definition then raise exception 'workspace data confirmation shape changed'; end if;
 execute patched;
end $$;

-- Keep the direct-write routine body byte-for-byte intact: payment capabilities
-- attest its source hash. This wrapper carries only contact-write context.
create function public.whatsapp_apply_owner_contact_write(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_provider_message_id text,p_interaction_id text,
 p_idempotency_key text,p_operation text,p_target_id uuid,p_expected_updated_at timestamptz,
 p_authorization_kind text,p_authorization_quote text,p_button_decision text,p_pending_id bigint,p_pending_version bigint,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path='' set app.owner_contact_supplied='off' as $$
begin
 perform set_config('app.owner_contact_supplied',case when p_payload ? 'phone' or p_payload ? 'customer_phone' then 'on' else 'off' end,true);
 return public.whatsapp_apply_direct_owner_write(p_workspace_id,p_owner_id,p_phone,p_provider_message_id,p_interaction_id,
   p_idempotency_key,p_operation,p_target_id,p_expected_updated_at,p_authorization_kind,p_authorization_quote,p_button_decision,p_pending_id,p_pending_version,p_payload);
end $$;
revoke all on function public.whatsapp_apply_owner_contact_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.whatsapp_apply_owner_contact_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb) to service_role;

-- A batch carries the explicit-phone flag independently for each child. Its
-- existing atomic rollback, receipts, authorization and ordering are retained.
alter function public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb) set app.owner_contact_write='on';
alter function public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb) set app.owner_contact_supplied='off';
do $$
declare definition text;patched text;
begin
 select pg_get_functiondef('public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb)'::regprocedure) into definition;
 patched:=replace(definition,'v_result:=app.whatsapp_apply_owner_batch_operation(',
   'perform set_config(''app.owner_contact_supplied'',case when (v_item->''payload'') ? ''phone'' or (v_item->''payload'') ? ''customer_phone'' then ''on'' else ''off'' end,true); v_result:=app.whatsapp_apply_owner_batch_operation(');
 if patched=definition then raise exception 'owner batch child invocation changed';end if;
 execute patched;
end $$;
