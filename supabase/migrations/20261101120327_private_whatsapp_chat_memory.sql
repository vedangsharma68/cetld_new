begin;

-- Positive, server-owned provenance. Legacy audit history is deliberately not
-- relabelled: it can contain invoice fields without a reliable turn marker.
create table public.whatsapp_provider_memory (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade,
  customer_id uuid,
  phone text not null,
  audience text not null check (audience in ('owner','customer')),
  source_message_id text not null,
  role text not null check (role in ('user','assistant')),
  content text not null check (length(content) between 1 and 4000),
  provenance text not null check (provenance='ordinary_chat_v1'),
  created_at timestamptz not null default now(),
  foreign key(workspace_id,customer_id) references public.customers(workspace_id,id) on delete cascade,
  check ((audience='owner' and owner_id is not null and customer_id is null)
    or (audience='customer' and customer_id is not null and owner_id is null)),
  unique(workspace_id,phone,audience,source_message_id,role)
);
create index whatsapp_provider_memory_scope on public.whatsapp_provider_memory(workspace_id,phone,audience,id desc);
alter table public.whatsapp_provider_memory enable row level security;
revoke all on public.whatsapp_provider_memory from public,anon,authenticated;
grant select,insert,delete on public.whatsapp_provider_memory to service_role;
grant usage,select on sequence public.whatsapp_provider_memory_id_seq to service_role;

-- Retain local terms even when a review is replaced/cancelled or history is
-- pruned. This prevents later quotations from laundering fields into chat.
create table public.whatsapp_private_invoice_terms (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  term_hash text not null,
  term text not null check(length(term) between 1 and 4000),
  primary key(workspace_id,term_hash)
);
alter table public.whatsapp_private_invoice_terms enable row level security;
revoke all on public.whatsapp_private_invoice_terms from public,anon,authenticated;
grant select,insert on public.whatsapp_private_invoice_terms to service_role;

-- Raw values remain retained; aliases add canonical numeric/calendar forms.
-- Internal invoker helper only: no public/service direct execution surface.
create function app.private_invoice_term_aliases(p_term text) returns setof text
language plpgsql immutable set search_path='' as $$
declare
  term text := lower(btrim(regexp_replace(p_term,'[[:space:]]+',' ','g')));
  parts text[]; y integer; m integer; day integer; d date;
begin
  if length(term) not between 1 and 4000 then return; end if;
  return next term;
  if term ~ '^([0-9]+|[0-9]{1,3}(,[0-9]{3})+|[0-9]{1,2}(,[0-9]{2})*,[0-9]{3})(\.[0-9]+)?$' then
    return next trim_scale(replace(term,',','')::numeric)::text;
    return;
  end if;
  parts := regexp_match(term,'^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$');
  if parts is not null then y:=parts[1]::integer; m:=parts[2]::integer; day:=parts[3]::integer;
  else
    parts:=regexp_match(term,'^([0-9]{1,2})[/-]([0-9]{1,2})[/-]([0-9]{4})$');
    if parts is not null then day:=parts[1]::integer; m:=parts[2]::integer; y:=parts[3]::integer;
    else
      parts:=regexp_match(term,'^([0-9]{1,2})(st|nd|rd|th)?[ -]+([a-z]+)\.?([ ,]+([0-9]{4}))?$');
      if parts is not null then
        if parts[3] !~ '^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$' then return; end if;
        day:=parts[1]::integer; m:=array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],left(parts[3],3)); y:=parts[5]::integer;
      else
        parts:=regexp_match(term,'^([a-z]+)\.?[ -]+([0-9]{1,2})(st|nd|rd|th)?([ ,]+([0-9]{4}))?$');
        if parts is null then return; end if;
        if parts[1] !~ '^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$' then return; end if;
        m:=array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],left(parts[1],3)); day:=parts[2]::integer; y:=parts[5]::integer;
      end if;
    end if;
  end if;
  if m is null then return; end if;
  begin d:=make_date(coalesce(y,2000),m,day);
  exception when datetime_field_overflow or invalid_datetime_format then return; end;
  if y is not null then return next to_char(d,'YYYY-MM-DD'); end if;
  return next lower(to_char(d,'DD Mon'));
end $$;
revoke all on function app.private_invoice_term_aliases(text) from public,anon,authenticated,service_role;

create function app.retain_private_invoice_terms(p_workspace_id uuid,p_document jsonb) returns void
language sql set search_path='' as $$
  insert into public.whatsapp_private_invoice_terms(workspace_id,term_hash,term)
  select distinct p_workspace_id,encode(sha256(convert_to(term,'UTF8')),'hex'),term from (
    select alias.term from jsonb_path_query(p_document,
      '$.** ? (@.type() == "string" || @.type() == "number")') value
    cross join lateral app.private_invoice_term_aliases(value #>> '{}') alias(term)
  ) terms where length(term) between 1 and 4000 on conflict do nothing;
$$;
revoke all on function app.retain_private_invoice_terms(uuid,jsonb) from public,anon,authenticated,service_role;

create function app.retain_private_review_terms() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.action->>'type'='invoice_review_draft' then
    perform app.retain_private_invoice_terms(new.workspace_id,jsonb_build_array(
      new.action->'invoice',new.action->'printedEvidence',new.action->'ownerProvidedFacts'));
  end if;
  return new;
end $$;
revoke all on function app.retain_private_review_terms() from public,anon,authenticated;
create trigger retain_private_review_terms after insert or update of action on public.whatsapp_pending_actions
  for each row execute function app.retain_private_review_terms();

create function app.retain_private_ledger_terms() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform app.retain_private_invoice_terms(new.workspace_id,to_jsonb(new));
  return new;
end $$;
revoke all on function app.retain_private_ledger_terms() from public,anon,authenticated;
create trigger retain_private_ledger_terms after insert or update on public.invoices
  for each row execute function app.retain_private_ledger_terms();

-- Customer labels can change independently of an invoice update.
create function app.retain_private_invoice_customer_terms() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.invoices i where i.workspace_id=new.workspace_id and i.customer_id=new.id) then
    perform app.retain_private_invoice_terms(new.workspace_id,jsonb_build_array(new.name,new.company_name,new.email,new.phone));
  end if;
  return new;
end $$;
revoke all on function app.retain_private_invoice_customer_terms() from public,anon,authenticated;
create trigger retain_private_invoice_customer_terms after update of name,company_name,email,phone on public.customers
  for each row execute function app.retain_private_invoice_customer_terms();

select app.retain_private_invoice_terms(workspace_id,jsonb_build_array(action->'invoice',action->'printedEvidence',action->'ownerProvidedFacts'))
  from public.whatsapp_pending_actions where action->>'type'='invoice_review_draft';
select app.retain_private_invoice_terms(i.workspace_id,to_jsonb(i)||jsonb_build_object('customer_name',c.name,'customer_email',c.email,'customer_phone',c.phone))
  from public.invoices i left join public.customers c on c.workspace_id=i.workspace_id and c.id=i.customer_id;

-- Reversible by removing these triggers/new tables after rolling the application
-- back. No pre-existing table rows, history, or monotonic marks are rewritten.
commit;
