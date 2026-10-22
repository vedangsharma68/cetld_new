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

create or replace function public.whatsapp_owner_save_phone(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_customer_id uuid,p_invoice_id uuid,
 p_contact_phone text,p_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.customers%rowtype; i public.invoices%rowtype;
 previous_write text:=current_setting('app.owner_contact_write',true);
 previous_supplied text:=current_setting('app.owner_contact_supplied',true);
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
 -- Custom parameters cannot be installed in function proconfig by Supabase's
 -- non-superuser postgres role. Runtime settings retain the verified scope.
 perform set_config('app.owner_contact_write','on',true);
 perform set_config('app.owner_contact_supplied','on',true);
 update public.customers set phone=p_contact_phone where workspace_id=p_workspace_id and id=c.id returning * into c;
 if p_invoice_id is not null then
   update public.invoices set metadata=(metadata-'debtor_consent')||jsonb_build_object('debtor_phone',c.phone,'client_phone',c.phone)
     where workspace_id=p_workspace_id and id=i.id;
 end if;
 perform set_config('app.owner_contact_supplied',coalesce(previous_supplied,''),true);
 perform set_config('app.owner_contact_write',coalesce(previous_write,''),true);
 return jsonb_build_object('ok',true,'completed',true,'customerId',c.id,'customerName',c.name,'phone',c.phone);
exception when others then
 perform set_config('app.owner_contact_supplied',coalesce(previous_supplied,''),true);
 perform set_config('app.owner_contact_write',coalesce(previous_write,''),true);
 raise;
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

-- Retain the installed engines and their authorization/receipt/CAS behavior in
-- private copies. Public wrappers preserve their ACL, owner and function
-- properties, and restore contact context after every engine return or error.
-- This needs no role/parameter grants and no custom function proconfig.
do $$
declare
 item record; definition text; original_source text; engine_source text;
 helper_definition text; wrapper_source text; marker text; private_identity text;
 previous_acl aclitem[]; previous_owner oid; previous_config text[];
 previous_security boolean; previous_volatility "char"; previous_parallel "char";
begin
 for item in select * from (values
   ('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure,
    'whatsapp_workspace_data_decide','owner_contact_workspace_data_decide',
    'p_workspace_id,p_customer_id,p_phone,p_pending_id,p_pending_version,p_proposal_id,p_confirmation_message_id,p_cancel_message_id,p_user_message,p_confirm','proposal'),
   ('public.whatsapp_confirm_owner_create_settings(uuid,uuid,text,bigint,bigint,text)'::regprocedure,
    'whatsapp_confirm_owner_create_settings','owner_contact_create_settings',
    'p_workspace_id,p_owner_id,p_phone,p_action_id,p_version,p_confirmation_message_id','create'),
   ('public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb)'::regprocedure,
    'whatsapp_apply_owner_batch','owner_contact_batch',
    'p_workspace_id,p_owner_id,p_phone,p_provider_message_id,p_authorization_quote,p_operations','batch')
 ) as targets(target,public_name,private_name,arguments,contact_source) loop
   select prosrc,proacl,proowner,proconfig,prosecdef,provolatile,proparallel
     into original_source,previous_acl,previous_owner,previous_config,previous_security,previous_volatility,previous_parallel
     from pg_catalog.pg_proc where oid=item.target;
   definition:=pg_get_functiondef(item.target);
   if position(format('CREATE OR REPLACE FUNCTION public.%I(',item.public_name) in definition)<>1
     or length(original_source)=0
     or (length(definition)-length(replace(definition,original_source,'')))/length(original_source)<>1 then
     raise exception 'owner contact engine definition changed: %',item.public_name;
   end if;
   engine_source:=original_source;
   -- An unrelated edit must not attest to an untouched imported phone.
   if item.contact_source='proposal' then
     marker:='update public.customers c set';
     if (length(engine_source)-length(replace(engine_source,marker,'')))/length(marker)<>1 then
       raise exception 'workspace data confirmation shape changed';
     end if;
     engine_source:=replace(engine_source,marker,
       'perform set_config(''app.owner_contact_supplied'',case when v_proposal.values ? ''phone'' then ''on'' else ''off'' end,true); '||marker);
   elsif item.contact_source='batch' then
     marker:='v_result:=app.whatsapp_apply_owner_batch_operation(';
     if (length(engine_source)-length(replace(engine_source,marker,'')))/length(marker)<>1 then
       raise exception 'owner batch child invocation changed';
     end if;
     engine_source:=replace(engine_source,marker,
       'perform set_config(''app.owner_contact_supplied'',case when (v_item->''payload'') ? ''phone'' or (v_item->''payload'') ? ''customer_phone'' then ''on'' else ''off'' end,true); '||marker);
   end if;
   helper_definition:=replace(definition,original_source,engine_source);
   helper_definition:=replace(helper_definition,
     format('CREATE OR REPLACE FUNCTION public.%I(',item.public_name),
     format('CREATE OR REPLACE FUNCTION app.%I(',item.private_name));
   execute helper_definition;
   private_identity:=format('app.%I%s',item.private_name,substr(item.target::text,strpos(item.target::text,'(')));
   execute format('alter function %s owner to %I',private_identity,pg_get_userbyid(previous_owner));
   execute format('revoke all on function %s from public,anon,authenticated,service_role',private_identity);
   wrapper_source:=format($wrapper$
declare
 previous_write text:=current_setting('app.owner_contact_write',true);
 previous_supplied text:=current_setting('app.owner_contact_supplied',true);
 result jsonb;
begin
 perform set_config('app.owner_contact_write','on',true);
 perform set_config('app.owner_contact_supplied','off',true);
 result:=app.%I(%s);
 perform set_config('app.owner_contact_supplied',coalesce(previous_supplied,''),true);
 perform set_config('app.owner_contact_write',coalesce(previous_write,''),true);
 return result;
exception when others then
 perform set_config('app.owner_contact_supplied',coalesce(previous_supplied,''),true);
 perform set_config('app.owner_contact_write',coalesce(previous_write,''),true);
 raise;
end;
$wrapper$,item.private_name,item.arguments);
   execute replace(definition,original_source,wrapper_source);
   if exists(select 1 from pg_catalog.pg_proc p where p.oid=item.target
     and (p.proacl is distinct from previous_acl or p.proowner<>previous_owner
       or p.proconfig is distinct from previous_config or p.prosecdef<>previous_security
       or p.provolatile<>previous_volatility or p.proparallel<>previous_parallel)) then
     raise exception 'owner contact wrapper properties changed: %',item.public_name;
   end if;
 end loop;
end $$;

-- Keep the direct-write routine body byte-for-byte intact: payment capabilities
-- attest its source hash. This wrapper carries only contact-write context.
create function public.whatsapp_apply_owner_contact_write(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_provider_message_id text,p_interaction_id text,
 p_idempotency_key text,p_operation text,p_target_id uuid,p_expected_updated_at timestamptz,
 p_authorization_kind text,p_authorization_quote text,p_button_decision text,p_pending_id bigint,p_pending_version bigint,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 previous_write text:=current_setting('app.owner_contact_write',true);
 previous_supplied text:=current_setting('app.owner_contact_supplied',true);
 result jsonb;
begin
 perform set_config('app.owner_contact_write','on',true);
 perform set_config('app.owner_contact_supplied',case when p_payload ? 'phone' or p_payload ? 'customer_phone' then 'on' else 'off' end,true);
 result:=public.whatsapp_apply_direct_owner_write(p_workspace_id,p_owner_id,p_phone,p_provider_message_id,p_interaction_id,
   p_idempotency_key,p_operation,p_target_id,p_expected_updated_at,p_authorization_kind,p_authorization_quote,p_button_decision,p_pending_id,p_pending_version,p_payload);
 perform set_config('app.owner_contact_supplied',coalesce(previous_supplied,''),true);
 perform set_config('app.owner_contact_write',coalesce(previous_write,''),true);
 return result;
exception when others then
 perform set_config('app.owner_contact_supplied',coalesce(previous_supplied,''),true);
 perform set_config('app.owner_contact_write',coalesce(previous_write,''),true);
 raise;
end $$;
revoke all on function public.whatsapp_apply_owner_contact_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.whatsapp_apply_owner_contact_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb) to service_role;
