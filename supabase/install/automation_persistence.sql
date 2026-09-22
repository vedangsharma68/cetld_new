begin;

-- A monotonically increasing invoice version makes payment and pause writes invalidate
-- claims already held by workers. The trigger also covers the existing UI and payment RPC.
alter table public.cetld_invoices
  add column if not exists automation_version bigint not null default 0,
  add column if not exists reminder_count integer not null default 0,
  add column if not exists last_follow_up_at timestamptz,
  add column if not exists customer_phone text,
  add column if not exists follow_up_settings jsonb not null default '{}'::jsonb;

create or replace function public.cetld_bump_automation_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if (to_jsonb(old)->'currency') is distinct from (to_jsonb(new)->'currency')
     or (to_jsonb(old)->'bookkeeping_record_id') is distinct from (to_jsonb(new)->'bookkeeping_record_id')
     or (to_jsonb(old)->'bookkeeping_provider') is distinct from (to_jsonb(new)->'bookkeeping_provider')
     or (to_jsonb(old)->'debtor_timezone') is distinct from (to_jsonb(new)->'debtor_timezone')
     or old.amount_minor is distinct from new.amount_minor
     or old.customer_phone is distinct from new.customer_phone
     or old.follow_up_settings is distinct from new.follow_up_settings
     or old.reminder_count is distinct from new.reminder_count
     or old.paid_minor is distinct from new.paid_minor
     or old.followup_state is distinct from new.followup_state
     or old.next_follow_up_at is distinct from new.next_follow_up_at
     or old.owner_id is distinct from new.owner_id
     or old.workspace_id is distinct from new.workspace_id then
    new.automation_version := coalesce(old.automation_version, 0) + 1;
  end if;
  return new;
end;
$function$;

drop trigger if exists cetld_invoices_bump_automation_version on public.cetld_invoices;
create trigger cetld_invoices_bump_automation_version
before update on public.cetld_invoices
for each row execute function public.cetld_bump_automation_version();

create table if not exists public.cetld_automation_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.cetld_workspaces(id) on delete cascade,
  invoice_id uuid references public.cetld_invoices(id) on delete set null,
  direction text not null check (direction in ('inbound','outbound','delivery')),
  kind text not null default 'message',
  status text not null default 'received',
  idempotency_key text not null,
  provider_message_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, provider_message_id)
);

create index if not exists cetld_automation_messages_scope_created_idx
  on public.cetld_automation_messages(owner_id, workspace_id, created_at desc);
create index if not exists cetld_automation_messages_invoice_idx
  on public.cetld_automation_messages(workspace_id, invoice_id, created_at desc);

create table if not exists public.cetld_automation_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.cetld_workspaces(id) on delete cascade,
  invoice_id uuid references public.cetld_invoices(id) on delete set null,
  type text not null,
  source text not null default 'automation',
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create index if not exists cetld_automation_events_scope_created_idx
  on public.cetld_automation_events(owner_id, workspace_id, created_at desc);
create index if not exists cetld_automation_events_invoice_idx
  on public.cetld_automation_events(workspace_id, invoice_id, created_at desc);

create table if not exists public.cetld_automation_replies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.cetld_workspaces(id) on delete cascade,
  message_id uuid references public.cetld_automation_messages(id) on delete set null,
  idempotency_key text not null,
  status text not null default 'pending',
  body text not null default '',
  provider_message_id text,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, provider_message_id)
);

create table if not exists public.cetld_automation_delivery_claims (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.cetld_workspaces(id) on delete cascade,
  invoice_id uuid not null references public.cetld_invoices(id) on delete cascade,
  claim_key text not null,
  scheduled_for timestamptz not null,
  invoice_version bigint not null,
  paid_minor bigint not null default 0,
  amount_minor bigint not null,
  status text not null default 'claimed' check (status in ('claimed','sending','sent','delivered','failed','expired','cancelled','quarantined')),
  attempts integer not null default 0,
  claimed_at timestamptz not null default now(),
  lease_until timestamptz,
  authorized_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  delivery_token uuid,
  last_error text,
  unique (workspace_id, invoice_id, scheduled_for),
  unique (workspace_id, claim_key)
);

create index if not exists cetld_automation_claims_due_idx
  on public.cetld_automation_delivery_claims(owner_id, workspace_id, status, scheduled_for);
create index if not exists cetld_automation_claims_invoice_idx
  on public.cetld_automation_delivery_claims(workspace_id, invoice_id, status);

-- Keep these tables safe if they are exposed through the Data API. Workers normally
-- use the RPCs below with a service key, while authenticated clients are scoped.
DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['cetld_automation_messages','cetld_automation_events','cetld_automation_replies','cetld_automation_delivery_claims'] LOOP
    EXECUTE format('alter table public.%I enable row level security', table_name);
    EXECUTE format('drop policy if exists %I_select on public.%I', table_name, table_name);
    EXECUTE format($policy$
      create policy %I_select on public.%I for select to authenticated
      using ((select auth.uid()) = owner_id and exists (
        select 1 from public.cetld_workspaces w
        where w.id = workspace_id and w.owner_id = (select auth.uid())
      ))
    $policy$, table_name, table_name);
  END LOOP;
END;
$security$;

revoke all on public.cetld_automation_messages, public.cetld_automation_events, public.cetld_automation_replies, public.cetld_automation_delivery_claims from anon, authenticated;
grant select on public.cetld_automation_messages, public.cetld_automation_events, public.cetld_automation_replies to authenticated;
grant all on public.cetld_automation_messages, public.cetld_automation_events, public.cetld_automation_replies, public.cetld_automation_delivery_claims to service_role;

create or replace function public.cetld_claim_due_followups(
  p_owner_id uuid,
  p_workspace_id uuid,
  p_now timestamptz default now(),
  p_limit integer default 25,
  p_invoice_id uuid default null,
  p_lease_seconds integer default 120
)
returns table (claim_id uuid, invoice_id uuid, owner_id uuid, workspace_id uuid, scheduled_for timestamptz, invoice_version bigint, paid_minor bigint, amount_minor bigint, attempts integer, lease_until timestamptz)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare r record; c public.cetld_automation_delivery_claims%rowtype;
begin
  if p_owner_id is null or p_workspace_id is null then raise exception using errcode = '22023', message = 'Automation scope is required'; end if;
  if auth.uid() is not null and auth.uid() is distinct from p_owner_id then raise exception using errcode = '42501', message = 'Owner is not accessible'; end if;
  update public.cetld_automation_delivery_claims set status='quarantined', last_error='worker_lost_after_authorization' where owner_id=p_owner_id and workspace_id=p_workspace_id and status='sending' and lease_until < p_now;
  for r in
    select i.id, i.owner_id, i.workspace_id, i.next_follow_up_at, i.automation_version,
           coalesce(i.paid_minor, 0) as paid_minor, i.amount_minor
      from public.cetld_invoices i
     where i.owner_id = p_owner_id and i.workspace_id = p_workspace_id
       and (p_invoice_id is null or i.id = p_invoice_id)
       and i.next_follow_up_at is not null and i.next_follow_up_at <= p_now
       and coalesce(i.paid_minor, 0) < i.amount_minor
       and i.followup_state in ('approved','active','scheduled')
     order by i.next_follow_up_at, i.id
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  loop
    insert into public.cetld_automation_delivery_claims
      (owner_id, workspace_id, invoice_id, claim_key, scheduled_for, invoice_version, paid_minor, amount_minor, status, attempts, claimed_at, lease_until)
    values
      (r.owner_id, r.workspace_id, r.id, r.id::text || ':' || r.next_follow_up_at::text, r.next_follow_up_at, r.automation_version, r.paid_minor, r.amount_minor, 'claimed', 1, p_now, p_now + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds,120), 3600))))
    on conflict (workspace_id, invoice_id, scheduled_for) do update
      set status = 'claimed', invoice_version = excluded.invoice_version, paid_minor = excluded.paid_minor,
          amount_minor = excluded.amount_minor, attempts = public.cetld_automation_delivery_claims.attempts + 1,
          claimed_at = excluded.claimed_at, lease_until = excluded.lease_until, last_error = null,
          delivery_token = null
      where public.cetld_automation_delivery_claims.attempts < 3 and (public.cetld_automation_delivery_claims.status in ('failed','expired','cancelled')
         or (public.cetld_automation_delivery_claims.status = 'claimed' and public.cetld_automation_delivery_claims.lease_until < p_now))
    returning * into c;
    if found then
      claim_id := c.id; invoice_id := c.invoice_id; owner_id := c.owner_id; workspace_id := c.workspace_id;
      scheduled_for := c.scheduled_for; invoice_version := c.invoice_version; paid_minor := c.paid_minor;
      amount_minor := c.amount_minor; attempts := c.attempts; lease_until := c.lease_until;
      return next;
    end if;
  end loop;
end;
$function$;

create or replace function public.cetld_authorize_follow_up_delivery(
  p_claim_id uuid, p_owner_id uuid, p_workspace_id uuid
)
returns table (authorized boolean, reason text, token uuid, claim_id uuid, invoice_id uuid, invoice jsonb)
language plpgsql
security invoker
set search_path = ''
as $function$
declare c public.cetld_automation_delivery_claims%rowtype; i public.cetld_invoices%rowtype;
begin
  if auth.uid() is not null and auth.uid() is distinct from p_owner_id then raise exception using errcode = '42501', message = 'Owner is not accessible'; end if;
  select * into i from public.cetld_invoices x where x.id = (select y.invoice_id from public.cetld_automation_delivery_claims y where y.id = p_claim_id) and x.owner_id = p_owner_id and x.workspace_id = p_workspace_id for update;
  select * into c from public.cetld_automation_delivery_claims x where x.id = p_claim_id and x.owner_id = p_owner_id and x.workspace_id = p_workspace_id for update;
  claim_id := p_claim_id; invoice_id := c.invoice_id;
  if not found or c.id is null or i.id is null then authorized := false; reason := 'not_found'; return next; return; end if;
  if c.status <> 'claimed' then authorized := false; reason := 'not_claimed'; return next; return; end if;
  if c.invoice_version is distinct from i.automation_version then authorized := false; reason := 'stale_claim'; update public.cetld_automation_delivery_claims set status='cancelled', last_error='stale_claim' where id=c.id; return next; return; end if;
  if coalesce(i.paid_minor,0) >= i.amount_minor then authorized := false; reason := 'paid'; update public.cetld_automation_delivery_claims set status='cancelled', last_error='paid' where id=c.id; return next; return; end if;
  if i.followup_state not in ('approved','active','scheduled') then authorized := false; reason := 'paused'; update public.cetld_automation_delivery_claims set status='cancelled', last_error='paused' where id=c.id; return next; return; end if;
  if c.lease_until <= now() then authorized:=false; reason:='expired'; return next; return; end if;
  token := gen_random_uuid(); authorized := true; reason := null;
  update public.cetld_automation_delivery_claims set status='sending', authorized_at=now(), delivery_token=token where id=c.id;
  invoice := to_jsonb(i);
  return next;
end;
$function$;

create or replace function public.cetld_mark_follow_up_sent(
  p_claim_id uuid, p_owner_id uuid, p_workspace_id uuid, p_token uuid, p_provider_message_id text default null
)
returns table (ok boolean, reason text, claim_id uuid)
language plpgsql security invoker set search_path = ''
as $function$
begin
  if auth.uid() is not null and auth.uid() is distinct from p_owner_id then raise exception using errcode='42501', message='Owner is not accessible'; end if;
  update public.cetld_automation_delivery_claims set status='sent', sent_at=now(), provider_message_id=left(p_provider_message_id,250)
   where id=p_claim_id and owner_id=p_owner_id and workspace_id=p_workspace_id and status='sending' and delivery_token=p_token;
  claim_id := p_claim_id; ok := found; reason := case when found then null else 'not_authorized' end;
  if ok then update public.cetld_automation_messages set status='sent',provider_message_id=p_provider_message_id where owner_id=p_owner_id and workspace_id=p_workspace_id and payload->>'claimId'=p_claim_id::text; end if;
  return next;
end;
$function$;

create or replace function public.cetld_mark_follow_up_failed(
  p_claim_id uuid, p_owner_id uuid, p_workspace_id uuid, p_error text default null, p_unknown boolean default false, p_token uuid default null
)
returns table (ok boolean, retryable boolean, reason text, claim_id uuid)
language plpgsql security invoker set search_path = ''
as $function$
begin
  if auth.uid() is not null and auth.uid() is distinct from p_owner_id then raise exception using errcode='42501', message='Owner is not accessible'; end if;
  update public.cetld_automation_delivery_claims set status=case when coalesce(p_unknown,false) then 'quarantined' else 'failed' end, last_error=left(coalesce(p_error,'delivery failed'),1000)
   where id=p_claim_id and owner_id=p_owner_id and workspace_id=p_workspace_id and (status='claimed' or (status='sending' and delivery_token=p_token));
  claim_id := p_claim_id; ok := found; retryable := found and not coalesce(p_unknown,false); reason := case when found then null else 'not_retryable' end;
  if ok then update public.cetld_automation_messages set status=case when p_unknown then 'quarantined' else 'failed' end where owner_id=p_owner_id and workspace_id=p_workspace_id and payload->>'claimId'=p_claim_id::text; end if;
  return next;
end;
$function$;

create or replace function public.cetld_record_follow_up_delivery(
  p_claim_id uuid,
  p_owner_id uuid,
  p_workspace_id uuid,
  p_provider_message_id text default null,
  p_status text default 'delivered',
  p_payload jsonb default '{}'::jsonb
)
returns table (quarantined boolean, retry boolean, claim_id uuid)
language plpgsql security invoker set search_path = ''
as $function$
declare c public.cetld_automation_delivery_claims%rowtype; k text;
begin
  if auth.uid() is not null and auth.uid() is distinct from p_owner_id then raise exception using errcode='42501', message='Owner is not accessible'; end if;
  select * into c from public.cetld_automation_delivery_claims x
   where x.id=p_claim_id and x.owner_id=p_owner_id and x.workspace_id=p_workspace_id for update;
  k := coalesce(nullif(left(p_provider_message_id,250),''), 'delivery:' || coalesce(p_claim_id::text, gen_random_uuid()::text));
  if not found then
    insert into public.cetld_automation_messages (owner_id,workspace_id,direction,kind,status,idempotency_key,provider_message_id,payload)
      values (p_owner_id,p_workspace_id,'delivery','delivery','quarantined',k,left(p_provider_message_id,250),coalesce(p_payload,'{}'::jsonb))
      on conflict (workspace_id,idempotency_key) do nothing;
    insert into public.cetld_automation_events (owner_id,workspace_id,type,source,idempotency_key,metadata)
      values (p_owner_id,p_workspace_id,'delivery_quarantined','automation','quarantine:' || k,jsonb_build_object('reason','unknown_claim','delivery',coalesce(p_payload,'{}'::jsonb)))
      on conflict (workspace_id,idempotency_key) do nothing;
    quarantined := true; retry := false; claim_id := null; return next; return;
  end if;
  update public.cetld_automation_delivery_claims
     set status=case when p_status='delivered' then 'delivered' else 'sent' end,
         provider_message_id=coalesce(nullif(left(p_provider_message_id,250),''),provider_message_id), sent_at=coalesce(sent_at,now())
   where id=c.id;
  insert into public.cetld_automation_messages (owner_id,workspace_id,invoice_id,direction,kind,status,idempotency_key,provider_message_id,payload)
    values (p_owner_id,p_workspace_id,c.invoice_id,'delivery','delivery',case when p_status='delivered' then 'delivered' else 'sent' end,k,left(p_provider_message_id,250),coalesce(p_payload,'{}'::jsonb))
    on conflict (workspace_id,idempotency_key) do nothing;
  quarantined := false; retry := false; claim_id := c.id; return next;
end;
$function$;

revoke execute on function public.cetld_claim_due_followups(uuid,uuid,timestamptz,integer,uuid,integer) from public, anon, authenticated;
revoke execute on function public.cetld_record_follow_up_delivery(uuid,uuid,uuid,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.cetld_authorize_follow_up_delivery(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.cetld_mark_follow_up_sent(uuid,uuid,uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.cetld_mark_follow_up_failed(uuid,uuid,uuid,text,boolean,uuid) from public, anon, authenticated;
grant execute on function public.cetld_claim_due_followups(uuid,uuid,timestamptz,integer,uuid,integer) to service_role;
grant execute on function public.cetld_record_follow_up_delivery(uuid,uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.cetld_authorize_follow_up_delivery(uuid,uuid,uuid) to service_role;
grant execute on function public.cetld_mark_follow_up_sent(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.cetld_mark_follow_up_failed(uuid,uuid,uuid,text,boolean,uuid) to service_role;

commit;
