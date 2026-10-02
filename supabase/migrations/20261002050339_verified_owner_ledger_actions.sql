-- Record the previously ad-hoc owner-verification objects in migration history.
-- Preserve existing verified numbers; never grant access from customer metadata alone.
create table if not exists public.whatsapp_owner_verifications (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 phone text not null check(phone ~ '^\+[1-9][0-9]{7,14}$'),
 requested_by uuid not null references auth.users(id) on delete cascade,
 code_hash text not null,
 attempts integer not null default 0,
 expires_at timestamptz not null,
 verified_at timestamptz,
 created_at timestamptz not null default now()
);
alter table public.whatsapp_owner_verifications enable row level security;
revoke all on public.whatsapp_owner_verifications from public,anon,authenticated;
grant select,insert,update,delete on public.whatsapp_owner_verifications to service_role;
create index if not exists owner_verification_phone_idx on public.whatsapp_owner_verifications(phone,created_at desc);
alter table public.whatsapp_conversation_turns add column if not exists audience text not null default 'customer'
 check (audience in ('owner','customer'));
-- Saving contact details is independent of permission to send messages.
drop trigger if exists customers_whatsapp_phone_attestation_guard on public.customers;
CREATE OR REPLACE FUNCTION public.owner_start_whatsapp_verification(p_workspace_id uuid, p_phone text)
 RETURNS TABLE(code text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare v_id uuid := gen_random_uuid(); v_code text; v_exp timestamptz := now() + interval '10 minutes';
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text,2));
  if auth.uid() is null or not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'Only the workspace owner can link a WhatsApp number' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter the number with country code, like +919876543210' using errcode = '23514';
  end if;
  if not exists (select 1 from public.workspace_settings s where s.workspace_id = p_workspace_id and nullif(btrim(s.business_name), '') is not null) then
    raise exception 'Set your business name in Settings first. It is shown in every reminder.' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_global_suppressions g where g.phone = p_phone)
     or exists (select 1 from public.whatsapp_suppressions s where s.workspace_id = p_workspace_id and s.phone = p_phone) then
    raise exception 'This number sent STOP and cannot be linked' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_consents c where c.phone = p_phone and c.workspace_id <> p_workspace_id and c.revoked_at is null) then
    raise exception 'This number is already linked to another cetld account. Unlink it there first.' using errcode = '23505';
  end if;
  if (select count(*) from public.whatsapp_owner_verifications v where v.workspace_id = p_workspace_id and v.created_at > now() - interval '1 hour') >= 8 then
    raise exception 'Too many attempts. Try again in an hour.' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text, 2));
  -- one active code per workspace
  update public.whatsapp_owner_verifications v set expires_at = now()
   where v.workspace_id = p_workspace_id and v.verified_at is null and v.expires_at > now();
  v_code := lpad((('x' || substr(gen_random_uuid()::text, 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into public.whatsapp_owner_verifications (id, workspace_id, phone, requested_by, code_hash, expires_at)
  values (v_id, p_workspace_id, p_phone, auth.uid(), encode(sha256(convert_to(v_id::text || ':' || v_code, 'UTF8')), 'hex'), v_exp);
  return query select v_code, v_exp;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.owner_bind_whatsapp_core(p_workspace_id uuid, p_phone text, p_uid uuid)
 RETURNS TABLE(customer_id uuid, phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_uid uuid := p_uid;
  v_customer uuid;
  v_old text;
begin
  if v_uid is null or not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = v_uid) then
    raise exception 'Only the workspace owner can link a WhatsApp number' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter the number with country code, like +919876543210' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text,2));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));
  if not exists (select 1 from public.workspace_settings s where s.workspace_id = p_workspace_id and nullif(btrim(s.business_name), '') is not null) then
    raise exception 'Set your business name in Settings first. It is shown in every reminder.' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_global_suppressions g where g.phone = p_phone)
     or exists (select 1 from public.whatsapp_suppressions s where s.workspace_id = p_workspace_id and s.phone = p_phone) then
    raise exception 'This number sent STOP and cannot be linked' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_consents c where c.phone = p_phone and c.workspace_id <> p_workspace_id and c.revoked_at is null) then
    raise exception 'This number is already linked to another cetld account. Unlink it there first.' using errcode = '23505';
  end if;

  select c.id, c.phone into v_customer, v_old from public.customers c
   where c.workspace_id = p_workspace_id and c.metadata->>'whatsapp_owner' = 'true' limit 1;
  if v_customer is null then
    select c.id, c.phone into v_customer, v_old from public.customers c
     where c.workspace_id = p_workspace_id and c.phone = p_phone limit 1;
  end if;
  if v_customer is null then
    insert into public.customers (workspace_id, name, phone, metadata)
    values (p_workspace_id, 'Owner (WhatsApp)', p_phone, '{"whatsapp_owner": true}'::jsonb)
    returning id into v_customer;
  else
    if v_old is distinct from p_phone and v_old is not null then
      update public.whatsapp_owner_verifications set verified_at=null,expires_at=now()
       where workspace_id=p_workspace_id and phone=v_old;
      update public.whatsapp_consents wc set revoked_at = now(), revoked_via = 'manual'
       where wc.workspace_id = p_workspace_id and wc.phone = v_old and wc.revoked_at is null;
    end if;
    update public.customers c set phone = p_phone, metadata = c.metadata || '{"whatsapp_owner": true}'::jsonb
     where c.id = v_customer and c.workspace_id = p_workspace_id;
  end if;

  insert into public.whatsapp_consents (workspace_id, phone, customer_id, categories, consent_text_version, source, consented_by)
  values (p_workspace_id, p_phone, v_customer, array['invoice_updates'], 'owner_binding_v1', 'verbal', v_uid)
  on conflict (workspace_id, phone) do update
    set customer_id = excluded.customer_id, consent_text_version = excluded.consent_text_version,
        consented_at = now(), consented_by = v_uid, source = 'verbal', revoked_at = null, revoked_via = null
    where public.whatsapp_consents.revoked_at is null or public.whatsapp_consents.revoked_via = 'manual';
  if not exists (select 1 from public.whatsapp_consents wc where wc.workspace_id = p_workspace_id and wc.phone = p_phone and wc.revoked_at is null) then
    raise exception 'This number opted out and cannot be linked' using errcode = '23514';
  end if;
  return query select v_customer, p_phone;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.whatsapp_verify_owner_code(p_phone text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v public.whatsapp_owner_verifications;
begin
  -- Reprocessing a committed LINK confirms the existing link instead of claiming failure.
  select * into v from public.whatsapp_owner_verifications x where x.phone=p_phone and x.verified_at is not null
   and x.code_hash=encode(sha256(convert_to(x.id::text||':'||coalesce(p_code,''),'UTF8')),'hex')
   and exists(select 1 from public.whatsapp_resolve_verified_owner(p_phone) r where r.workspace_id=x.workspace_id and r.owner_id=x.requested_by)
   order by x.created_at desc limit 1;
  if v.id is not null then return jsonb_build_object('ok',true,'workspace_id',v.workspace_id,'replayed',true);end if;
  select * into v from public.whatsapp_owner_verifications x
   where x.phone = p_phone and x.verified_at is null and x.expires_at > now()
   order by x.created_at desc limit 1;
  if v.id is null then return jsonb_build_object('ok',false,'reason','no_active_code');end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v.workspace_id::text,2));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
  select * into v from public.whatsapp_owner_verifications x where x.id=v.id and x.verified_at is null and x.expires_at>now() for update;
  if v.id is null then return jsonb_build_object('ok', false, 'reason', 'no_active_code'); end if;
  if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  if v.code_hash is distinct from encode(sha256(convert_to(v.id::text || ':' || coalesce(p_code, ''), 'UTF8')), 'hex') then
    update public.whatsapp_owner_verifications x set attempts = x.attempts + 1 where x.id = v.id;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code');
  end if;
  begin
    perform public.owner_bind_whatsapp_core(v.workspace_id, v.phone, v.requested_by);
  exception when others then
    update public.whatsapp_owner_verifications x set expires_at = now() where x.id = v.id;
    return jsonb_build_object('ok', false, 'reason', 'bind_refused', 'detail', sqlerrm);
  end;
  update public.whatsapp_owner_verifications x set verified_at = now(), expires_at = now() where x.id = v.id;
  update public.workspace_settings set whatsapp_owner_phone=v.phone where workspace_id=v.workspace_id;
  return jsonb_build_object('ok', true, 'workspace_id', v.workspace_id);
end;
$function$
;

create or replace function public.whatsapp_resolve_verified_owner(p_phone text)
returns table(workspace_id uuid,owner_id uuid,customer_id uuid,business_name text)
language sql stable security definer set search_path='' as $$
 select w.id,w.owner_id,c.customer_id,s.business_name
 from public.workspaces w
 join public.workspace_settings s on s.workspace_id=w.id and s.whatsapp_owner_phone=p_phone
 join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id and m.role='owner'
 join public.whatsapp_consents c on c.workspace_id=w.id and c.phone=p_phone and c.consented_by=w.owner_id and c.revoked_at is null
 join public.customers customer on customer.workspace_id=w.id and customer.id=c.customer_id
   and customer.phone=p_phone and customer.metadata->>'whatsapp_owner'='true'
 where exists(select 1 from public.whatsapp_owner_verifications v where v.workspace_id=w.id
   and v.phone=p_phone and v.requested_by=w.owner_id and v.verified_at is not null)
 and nullif(pg_catalog.btrim(s.business_name),'') is not null
 and not exists(select 1 from public.whatsapp_global_suppressions g where g.phone=p_phone)
 and not exists(select 1 from public.whatsapp_suppressions x where x.workspace_id=w.id and x.phone=p_phone)
$$;
revoke all on function public.whatsapp_resolve_verified_owner(text) from public,anon,authenticated;
grant execute on function public.whatsapp_resolve_verified_owner(text) to service_role;

-- Only verification may install a number. Existing proof must belong to the actual owner.
create or replace function app.guard_verified_owner_phone()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.whatsapp_owner_phone is not null and (
   tg_op='INSERT' or new.whatsapp_owner_phone is distinct from old.whatsapp_owner_phone) then
  if not exists(select 1 from public.whatsapp_owner_verifications v join public.workspaces w on w.id=v.workspace_id
    where v.workspace_id=new.workspace_id and v.phone=new.whatsapp_owner_phone
    and v.requested_by=w.owner_id and v.verified_at is not null) then
    raise exception 'Connect this number through WhatsApp first' using errcode='42501';
  end if;
 end if;
 return new;
end; $$;
create trigger workspace_settings_verified_owner_guard before insert or update of whatsapp_owner_phone
 on public.workspace_settings for each row execute function app.guard_verified_owner_phone();

-- This backfill preserves verified active links, including the current testing account.
update public.workspace_settings s set whatsapp_owner_phone=linked.phone
from (
 select distinct on (v.workspace_id) v.workspace_id,v.phone
 from public.whatsapp_owner_verifications v
 join public.workspaces w on w.id=v.workspace_id and w.owner_id=v.requested_by
 join public.whatsapp_consents c on c.workspace_id=v.workspace_id and c.phone=v.phone
   and c.consented_by=w.owner_id and c.revoked_at is null
 join public.customers customer on customer.workspace_id=w.id and customer.id=c.customer_id
   and customer.phone=v.phone and customer.metadata->>'whatsapp_owner'='true'
 where v.verified_at is not null
 and not exists(select 1 from public.whatsapp_global_suppressions g where g.phone=v.phone)
 and not exists(select 1 from public.whatsapp_suppressions x where x.workspace_id=v.workspace_id and x.phone=v.phone)
 order by v.workspace_id,v.created_at desc
) linked where s.workspace_id=linked.workspace_id and s.whatsapp_owner_phone is null;

create or replace function public.owner_unbind_whatsapp(p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_phone text;v_customer uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text,2));
 if auth.uid() is null or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=auth.uid()) then
  raise exception 'Only the workspace owner can disconnect their number' using errcode='42501';end if;
 select whatsapp_owner_phone into v_phone from public.workspace_settings where workspace_id=p_workspace_id;
 if v_phone is not null then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_phone,0));
  perform 1 from public.workspace_settings where workspace_id=p_workspace_id and whatsapp_owner_phone=v_phone for update;
  if not found then raise exception 'Number changed. Refresh Settings and try again.';end if;
  update public.whatsapp_consents set revoked_at=now(),revoked_via='manual' where workspace_id=p_workspace_id and phone=v_phone and revoked_at is null;
 end if;
 update public.whatsapp_owner_verifications set verified_at=null,expires_at=now() where workspace_id=p_workspace_id;
 update public.whatsapp_pending_actions set consumed_at=now()
  where workspace_id=p_workspace_id and phone=v_phone and consumed_at is null;
 update public.workspace_settings set whatsapp_owner_phone=null where workspace_id=p_workspace_id;
 return true;
end; $$;

create or replace function public.owner_whatsapp_verification_status(p_workspace_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v public.whatsapp_owner_verifications;linked text;
begin
 if auth.uid() is null or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=auth.uid()) then
  raise exception 'Only the workspace owner can connect their number' using errcode='42501';end if;
 select * into v from public.whatsapp_owner_verifications where workspace_id=p_workspace_id order by created_at desc limit 1;
 if v.id is null then return 'none';end if;
 if v.verified_at is not null and exists(select 1 from public.whatsapp_resolve_verified_owner(v.phone) r where r.workspace_id=p_workspace_id) then return 'linked';end if;
 if v.expires_at<=now() then return 'expired';end if;
 return 'pending';
end; $$;

-- A reply claim must recheck verified owner access inside the phone-wide STOP lock.
create or replace function public.whatsapp_claim_owner_reply(p_provider_message_id text,p_sender_phone text,p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sender_phone,0));
 if (select count(*) from public.whatsapp_resolve_verified_owner(p_sender_phone))<>1
 or not exists(select 1 from public.whatsapp_resolve_verified_owner(p_sender_phone) where workspace_id=p_workspace_id) then return false;end if;
 return public.whatsapp_claim_inbound_reply(p_provider_message_id,p_sender_phone,'normal',p_workspace_id);
end; $$;

revoke all on function public.owner_start_whatsapp_verification(uuid,text),public.owner_unbind_whatsapp(uuid),
 public.owner_whatsapp_verification_status(uuid) from public,anon,authenticated;
grant execute on function public.owner_start_whatsapp_verification(uuid,text),public.owner_unbind_whatsapp(uuid),
 public.owner_whatsapp_verification_status(uuid) to authenticated;
revoke all on function public.owner_bind_whatsapp_core(uuid,text,uuid),public.whatsapp_verify_owner_code(text,text),
 public.whatsapp_claim_owner_reply(text,text,uuid) from public,anon,authenticated;
grant execute on function public.owner_bind_whatsapp_core(uuid,text,uuid),public.whatsapp_verify_owner_code(text,text),
 public.whatsapp_claim_owner_reply(text,text,uuid) to service_role;

-- Bind every confirmation to one inbound event, independent of which proposal is latest on retry.
create table public.whatsapp_owner_action_receipts(
 provider_message_id text primary key,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 phone text not null,
 action_id bigint,
 result jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.whatsapp_owner_action_receipts enable row level security;
revoke all on public.whatsapp_owner_action_receipts from public,anon,authenticated;
grant select,insert on public.whatsapp_owner_action_receipts to service_role;

-- Only a verified owner and an explicit, fresh confirmation can mutate the ledger.
-- The pending action, invoice, audit, and payment commit in one transaction.
create or replace function public.whatsapp_confirm_owner_invoice_action(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_action_id bigint,p_version bigint,
 p_confirmation_message_id text,p_confirm boolean default true
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 binding record; pending public.whatsapp_pending_actions; invoice public.invoices;
 receipt jsonb;event public.whatsapp_inbound_events;
 change jsonb;patch jsonb;meta jsonb; audit jsonb='{}';result jsonb;
 k text; v text;new_total numeric;recorded_tax numeric;new_date date;new_customer uuid;
 old_sub text:=current_setting('request.jwt.claim.sub',true);
 old_claims text:=current_setting('request.jwt.claims',true);
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
 if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone))<>1 then return jsonb_build_object('ok',false,'reason','unbound');end if;
 select * into binding from public.whatsapp_resolve_verified_owner(p_phone)
  where workspace_id=p_workspace_id and owner_id=p_owner_id;
 if not found then return jsonb_build_object('ok',false,'reason','unbound');end if;
 if p_confirmation_message_id is null or length(p_confirmation_message_id) not between 1 and 256 then raise exception 'Confirmation message is required';end if;
 select r.result into receipt from public.whatsapp_owner_action_receipts r where r.provider_message_id=p_confirmation_message_id
  and r.workspace_id=p_workspace_id and r.owner_id=p_owner_id and r.phone=p_phone;
 if found then return receipt||jsonb_build_object('replayed',true);end if;
 select * into event from public.whatsapp_inbound_events e where e.provider_message_id=p_confirmation_message_id
  and e.sender_phone=p_phone and e.status='processing' for update;
 if not found then return jsonb_build_object('ok',false,'reason','invalid_confirmation');end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  p_workspace_id::text||':'||binding.customer_id::text||':'||p_phone,0));
 select * into pending from public.whatsapp_pending_actions where id=p_action_id and workspace_id=p_workspace_id
  and customer_id=binding.customer_id and phone=p_phone for update;
 if not found or pending.version is distinct from p_version or pending.consumed_at is not null then
  return jsonb_build_object('ok',false,'reason','no_action');end if;
 if event.received_at<pending.created_at or event.provider_timestamp+interval '1 second'<pending.created_at then
  result:=jsonb_build_object('ok',false,'reason','stale_confirmation');
  insert into public.whatsapp_owner_action_receipts values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,pending.id,result,now());
  return result;
 end if;
 if not p_confirm then
  if pending.action->>'type'='invoice_review_draft' and pending.action->>'stage' in ('saving','saved') then
   return jsonb_build_object('ok',false,'reason',case pending.action->>'stage' when 'saving' then 'in_progress' else 'already_saved' end);end if;
  update public.whatsapp_pending_actions set consumed_at=now() where id=pending.id;
  result:=jsonb_build_object('ok',true,'actionType','canceled');
  insert into public.whatsapp_owner_action_receipts values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,pending.id,result,now());
  return result;
 end if;
 if pending.action->>'type'='invoice_review_draft' then
  result:=jsonb_build_object('ok',true,'actionType','owner_invoice_review','reviewActionId',pending.id,'reviewVersion',pending.version);
  insert into public.whatsapp_owner_action_receipts values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,pending.id,result,now());
  return result;
 end if;
 if pending.action->>'type' not in ('owner_invoice_update','owner_invoice_payment') then
  return jsonb_build_object('ok',false,'reason','no_action');end if;
 if pending.created_at<now()-interval '10 minutes' or (pending.action->>'expiresAt')::timestamptz<=now() then
  update public.whatsapp_pending_actions set consumed_at=now() where id=pending.id;
  result:=jsonb_build_object('ok',false,'reason','expired');
  insert into public.whatsapp_owner_action_receipts values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,pending.id,result,now());
  return result;end if;
 select * into invoice from public.invoices where workspace_id=p_workspace_id
  and id=(pending.action->>'invoiceId')::uuid for update;
 if not found then return jsonb_build_object('ok',false,'reason','not_found');end if;
 if invoice.updated_at is distinct from (pending.action->>'expectedUpdatedAt')::timestamptz then
  update public.whatsapp_pending_actions set consumed_at=now() where id=pending.id;
  result:=jsonb_build_object('ok',false,'reason','stale');
  insert into public.whatsapp_owner_action_receipts values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,pending.id,result,now());
  return result;end if;
 if invoice.status::text in ('paid','void','cancelled') or invoice.amount_paid>=invoice.total_amount then
  return jsonb_build_object('ok',false,'reason','settled');end if;
 change:=pending.action->'changes';
 if jsonb_typeof(change) is distinct from 'object' or change='{}' then raise exception 'Invalid changes';end if;
 -- Payment uses the existing idempotent accounting RPC, never a direct status edit.
 perform pg_catalog.set_config('request.jwt.claim.sub',p_owner_id::text,true);
 perform pg_catalog.set_config('request.jwt.claims',jsonb_build_object('sub',p_owner_id,'role','authenticated')::text,true);
 if pending.action->>'type'='owner_invoice_payment' then
  if change is distinct from '{"status":"paid"}'::jsonb then raise exception 'Invalid payment request';end if;
  perform public.record_invoice_payment(p_workspace_id,invoice.id,null,'wa_owner_payment_'||pending.id,
   'Confirmed by owner on WhatsApp',true);
  audit:=jsonb_build_object('status',jsonb_build_object('old',invoice.status,'new','paid'),
   'amountPaid',jsonb_build_object('old',invoice.amount_paid,'new',invoice.total_amount));
 else
  meta:=invoice.metadata;patch:='{}';
  for k,v in select key,value from jsonb_each_text(change) loop
   if k not in ('total','dueDate','invoiceDate','currency','notes','clientName','invoiceNumber') or v is null then raise exception 'Unsupported changes';end if;
   if k='total' then
    new_total:=v::numeric;
    if new_total<=0 or new_total>999999999999.99 or scale(new_total)>2 or new_total<invoice.amount_paid then raise exception 'Invalid amount';end if;
    patch:=patch||jsonb_build_object('total_amount',new_total);
    -- Dashboard imports store tax in minor units; assistant imports use major units.
    -- Preserve the recorded tax even when extraction left subtotal empty.
    if coalesce(meta->>'tax_minor','') ~ '^[0-9]+$' then
     recorded_tax:=(meta->>'tax_minor')::numeric/100;
    elsif coalesce(meta->>'tax','') ~ '^[0-9]+(\.[0-9]{1,2})?$' then
     recorded_tax:=(meta->>'tax')::numeric;
    else recorded_tax:=0;
    end if;
    if new_total<recorded_tax then raise exception 'Total cannot be less than the recorded tax';end if;
    meta:=meta||jsonb_build_object('outstanding_amount',new_total-invoice.amount_paid,
      'subtotal',new_total-recorded_tax,'tax',recorded_tax);
    audit:=audit||jsonb_build_object(k,jsonb_build_object('old',invoice.total_amount,'new',new_total));
   elsif k in ('dueDate','invoiceDate') then
    if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid date';end if;
    new_date:=v::date;
    patch:=patch||jsonb_build_object(case k when 'dueDate' then 'due_date' else 'issue_date' end,new_date);
    audit:=audit||jsonb_build_object(k,jsonb_build_object('old',case k when 'dueDate' then invoice.due_date else invoice.issue_date end,'new',new_date));
   elsif k='currency' then
    if v not in ('INR','USD','EUR','GBP','AED','CAD','AUD','SGD','CHF') or invoice.amount_paid>0 and v<>invoice.currency then raise exception 'Invalid currency';end if;
    patch:=patch||jsonb_build_object('currency',v);
    audit:=audit||jsonb_build_object(k,jsonb_build_object('old',invoice.currency,'new',v));
   elsif k='notes' then
    if length(v)>4000 then raise exception 'Notes too long';end if;
    patch:=patch||jsonb_build_object('notes',v);
    audit:=audit||jsonb_build_object(k,jsonb_build_object('old',invoice.notes,'new',v));
   elsif k='invoiceNumber' then
    if v !~ '^[A-Za-z0-9][A-Za-z0-9 _./-]{0,99}$' then raise exception 'Invalid invoice number';end if;
    patch:=patch||jsonb_build_object('invoice_number',v);
    meta:=meta||jsonb_build_object('printed_invoice_number',v,'source_invoice_number',v);
    audit:=audit||jsonb_build_object(k,jsonb_build_object('old',invoice.invoice_number,'new',v));
   elsif k='clientName' then
    v:=btrim(v);
    if length(v) not between 1 and 200 then raise exception 'Invalid customer name';end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||v,3));
    if (select count(*) from public.customers where workspace_id=p_workspace_id and name=v)>1 then raise exception 'Ambiguous customer';end if;
    select id into new_customer from public.customers where workspace_id=p_workspace_id and name=v limit 1;
    if new_customer is null then
     insert into public.customers(workspace_id,name) values(p_workspace_id,v) returning id into new_customer;
    end if;
    patch:=patch||jsonb_build_object('customer_id',new_customer);
    meta:=meta||jsonb_build_object('client_name',v);
    audit:=audit||jsonb_build_object(k,jsonb_build_object('old',(select name from public.customers where id=invoice.customer_id and workspace_id=p_workspace_id),'new',v));
   end if;
  end loop;
  meta:=meta||jsonb_build_object('followup_state','paused','next_follow_up_at',null,
   'approved_reminder_text',null,'approved_preferences_updated_at',null,'bookkeeping_sync_status','pending');
  update public.invoices set
   total_amount=coalesce((patch->>'total_amount')::numeric,total_amount),
   due_date=coalesce((patch->>'due_date')::date,due_date),
   issue_date=coalesce((patch->>'issue_date')::date,issue_date),
   currency=coalesce(patch->>'currency',currency),notes=coalesce(patch->>'notes',notes),
   invoice_number=coalesce(patch->>'invoice_number',invoice_number),
   customer_id=coalesce((patch->>'customer_id')::uuid,customer_id),metadata=meta
   where workspace_id=p_workspace_id and id=invoice.id;
 end if;
 update public.invoices set metadata=metadata||jsonb_build_object('whatsapp_corrections',
  coalesce(metadata->'whatsapp_corrections','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
   'idempotency_key','wa_owner_action_'||pending.id,'changed_at',now(),'actor_id',p_owner_id,'source','whatsapp_owner','changes',audit)))
  where workspace_id=p_workspace_id and id=invoice.id;
 update public.whatsapp_pending_actions set consumed_at=now() where id=pending.id;
 select jsonb_build_object('ok',true,'invoiceNumber',coalesce(metadata->>'printed_invoice_number',metadata->>'source_invoice_number',invoice_number),'invoiceId',id,'actionType',pending.action->>'type')
  into result from public.invoices where workspace_id=p_workspace_id and id=invoice.id;
 insert into public.whatsapp_owner_action_receipts values(p_confirmation_message_id,p_workspace_id,p_owner_id,p_phone,pending.id,result,now());
 perform pg_catalog.set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
 perform pg_catalog.set_config('request.jwt.claims',coalesce(old_claims,''),true);
 return result;
exception when others then
 perform pg_catalog.set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
 perform pg_catalog.set_config('request.jwt.claims',coalesce(old_claims,''),true);
 raise;
end; $$;
revoke all on function public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean) to service_role;

-- A single client agreement is sufficient. No redundant workspace-wide attestation.
create or replace function public.whatsapp_record_verbal_consent(
  p_workspace_id uuid, p_customer_id uuid, p_phone text,
  p_consent_text_version text default 'invoice_updates_v1'
)
returns public.whatsapp_consents
language plpgsql security definer set search_path = '' as $$
declare v_result public.whatsapp_consents;
begin
  if not app.is_workspace_member(p_workspace_id, auth.uid()) then
    raise exception 'Not a workspace member' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));

  if not exists (select 1 from public.customers c
                 where c.workspace_id = p_workspace_id and c.id = p_customer_id and c.phone = p_phone) then
    raise exception 'Customer phone does not match' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_suppressions s
             where s.workspace_id = p_workspace_id and s.phone = p_phone) then
    raise exception 'Phone is suppressed' using errcode = '23514';
  end if;
  if exists (select 1 from public.whatsapp_global_suppressions s where s.phone = p_phone) then
    raise exception 'Phone is globally suppressed' using errcode = '23514';
  end if;
  insert into public.whatsapp_consents
    (workspace_id, phone, customer_id, categories, consent_text_version, source, consented_by)
  values (p_workspace_id, p_phone, p_customer_id, array['invoice_updates'], p_consent_text_version, 'verbal', auth.uid())
  on conflict (workspace_id, phone) do update
    set customer_id = excluded.customer_id,
        consent_text_version = excluded.consent_text_version,
        consented_at = now(), consented_by = auth.uid(), source = 'verbal'
    where public.whatsapp_consents.revoked_at is null
  returning * into v_result;
  if v_result.id is null then
    raise exception 'Revoked consent cannot be restored by owner attestation' using errcode = '23514';
  end if;
  return v_result;
end;
$$;

grant select on public.workspaces,public.workspace_members,public.workspace_settings,public.workspace_ai_settings,public.customers,public.payments to service_role;
grant insert on public.customers,public.invoices to service_role;

-- Recheck actual customer opt-in without the redundant workspace attestation.
create or replace function public.whatsapp_claim_invoice_update(
  p_workspace_id uuid, p_invoice_id uuid, p_customer_id uuid, p_phone text,
  p_idempotency_key text, p_expected_updated_at timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_claimed integer := 0;
begin
  if p_idempotency_key !~ '^[A-Za-z0-9_-]{12,120}$' then
    raise exception 'Invalid WhatsApp idempotency key' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone, 0));
  insert into public.whatsapp_invoice_update_claims
    (workspace_id, invoice_id, customer_id, phone, idempotency_key, invoice_updated_at)
  select i.workspace_id, i.id, c.id, p_phone, p_idempotency_key, i.updated_at
  from public.invoices i
  join public.customers c on c.workspace_id = i.workspace_id and c.id = i.customer_id
  join public.workspace_settings s on s.workspace_id = i.workspace_id
  join public.whatsapp_consents wc on wc.workspace_id = i.workspace_id and wc.customer_id = c.id and wc.phone = p_phone
  where i.workspace_id = p_workspace_id and i.id = p_invoice_id
    and c.id = p_customer_id and c.phone = p_phone
    and i.updated_at = p_expected_updated_at and i.status::text in ('sent', 'paid')

    and wc.revoked_at is null and wc.source in ('verbal', 'inbound_message')
    and 'invoice_updates' = any(wc.categories)
    and not exists (select 1 from public.whatsapp_suppressions ws
                    where ws.workspace_id = i.workspace_id and ws.phone = p_phone)
    and not exists (select 1 from public.whatsapp_global_suppressions gs where gs.phone = p_phone)
  on conflict (workspace_id, invoice_id, idempotency_key) do nothing;
  get diagnostics v_claimed = row_count;
  return v_claimed > 0;
end;
$$;

create or replace function public.owner_cancel_whatsapp_verification(p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=auth.uid()) then
  raise exception 'Only the workspace owner can cancel setup' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text,2));
 update public.whatsapp_owner_verifications set expires_at=now() where workspace_id=p_workspace_id and verified_at is null;
 return true;
end; $$;
revoke all on function public.owner_cancel_whatsapp_verification(uuid) from public,anon,authenticated;
grant execute on function public.owner_cancel_whatsapp_verification(uuid) to authenticated;
