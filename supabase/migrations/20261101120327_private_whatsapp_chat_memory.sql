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

-- SQL and JS use the same NFKC + Unicode Cf stripping + whitespace fold.
-- Cf ranges are the Unicode category table (Unicode 17), not private-value aliases.
-- Parity tests exercise every Cf code point against the JS property escape.
create function app.private_invoice_normalize(p_term text) returns text
language sql immutable set search_path='' as $$
  select lower(btrim(regexp_replace(regexp_replace(normalize(p_term,NFKC),
    U&'[\00ad\0600-\0605\061c\06dd\070f\0890-\0891\08e2\180e\200b-\200f\202a-\202e\2060-\2064\2066-\206f\feff\fff9-\fffb\+0110bd\+0110cd\+013430-\+01343f\+01bca0-\+01bca3\+01d173-\+01d17a\+0e0001\+0e0020-\+0e007f]','','g'),'[[:space:]]+',' ','g')));
$$;
revoke all on function app.private_invoice_normalize(text) from public,anon,authenticated,service_role;

-- One complete numeric candidate, never its constituent groups. Keep both
-- decimal/grouped interpretations when valid; matching decides containment.
-- Mirrored by numeric()/groupedInteger() in ai/private-value-matcher.mjs.
-- Typed aliases cannot acquire a different grouping interpretation on reload.
create function app.private_invoice_number_aliases(p_term text) returns setof text
language plpgsql immutable set search_path='' as $$
declare
  term text := app.private_invoice_normalize(p_term);
  whole text; fraction text; groups text[]; valid boolean; i integer;
  unit_pattern text := '(inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs|rupees?|dollars?|euros?|pounds?)';
begin
  term:=regexp_replace(term,'^'||unit_pattern||'(?=[0-9])','','g');
  term:=regexp_replace(term,'(?<=[0-9])'||unit_pattern||'$','','g');
  term:=regexp_replace(term,U&'[\0022\0027\00ab\00bb\2018-\201f\2039-\203a\2e42\300c-\300f\301d-\301f\fe41-\fe44\ff02\ff07\ff62-\ff63\02bc]',chr(39),'g');
  term:=regexp_replace(term,' *([.,'']) *','\1','g');
  if term !~ '^[0-9]+([.,'' ][0-9]+)*$' then return; end if;
  -- Pass 1: grouped integer. Pass 2: rightmost dot/comma is decimal, with
  -- arbitrary precision retained (including three-digit ambiguous fractions).
  for i in 1..2 loop
    fraction:='';whole:=term;
    if i=2 then
      if term !~ '[.,][0-9]+$' then continue; end if;
      fraction:=substring(term from '[.,]([0-9]+)$');
      whole:=regexp_replace(term,'[.,][0-9]+$','');
    end if;
    groups:=regexp_split_to_array(whole,'[.,'' ]');
    valid:=cardinality(groups)=1;
    if not valid and length(groups[1]) between 1 and 3 then
      valid:=not exists(select 1 from unnest(groups[2:cardinality(groups)]) g where length(g)<>3);
    end if;
    if not valid and length(groups[1]) between 1 and 2 and length(groups[cardinality(groups)])=3 then
      valid:=not exists(select 1 from unnest(groups[2:cardinality(groups)-1]) g where length(g)<>2);
    end if;
    if valid then
      return next 'number:'||trim_scale((array_to_string(groups,'')||case when fraction<>'' then '.'||fraction else '' end)::numeric)::text;
    end if;
  end loop;
end $$;
revoke all on function app.private_invoice_number_aliases(text) from public,anon,authenticated,service_role;

-- Raw values remain retained; aliases add canonical numeric/calendar forms.
-- Internal invoker helper only: no public/service direct execution surface.
create function app.private_invoice_term_aliases(p_term text) returns setof text
language plpgsql immutable set search_path='' as $$
declare
  term text := app.private_invoice_normalize(p_term);
  parts text[]; y integer; m integer; day integer; d date; candidate integer[];
  ordinals text[] := string_to_array('first,second,third,fourth,fifth,sixth,seventh,eighth,ninth,tenth,eleventh,twelfth,thirteenth,fourteenth,fifteenth,sixteenth,seventeenth,eighteenth,nineteenth,twentieth,twenty first,twenty second,twenty third,twenty fourth,twenty fifth,twenty sixth,twenty seventh,twenty eighth,twenty ninth,thirtieth,thirty first',',');
  month_pattern text := '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  day_pattern text; day_text text; month_text text;
  candidates integer[][] := array[]::integer[][];
begin
  if length(term) not between 1 and 4000 then return; end if;
  return next term;
  return query select * from app.private_invoice_number_aliases(term);
  parts := regexp_match(term,'^([0-9]{4}) *[./-] *([0-9]{1,2}) *[./-] *([0-9]{1,2})$');
  if parts is not null then candidates:=array[array[parts[1]::integer,parts[2]::integer,parts[3]::integer]];
  else
    parts:=regexp_match(term,'^([0-9]{1,2}) *[./-] *([0-9]{1,2}) *[./-] *([0-9]{4})$');
    if parts is not null then
      candidates:=array[array[parts[3]::integer,parts[2]::integer,parts[1]::integer],array[parts[3]::integer,parts[1]::integer,parts[2]::integer]];
    else
      day_pattern:='(?:[0-9]{1,2}(?:st|nd|rd|th)?|'||replace(array_to_string(ordinals,'|'),' ','[ -]+')||')';
      parts:=regexp_match(term,'^(?:the[ -]+)?('||day_pattern||')[ -]+(?:of[ -]+)?('||month_pattern||')\.?([ ,]+([0-9]{4}))?$');
      if parts is not null then day_text:=parts[1];month_text:=parts[2];y:=parts[4]::integer;
      else
        parts:=regexp_match(term,'^('||month_pattern||')\.?[ -]+(?:the[ -]+)?('||day_pattern||')([ ,]+([0-9]{4}))?$');
        if parts is null then return; end if;
        month_text:=parts[1];day_text:=parts[2];y:=parts[4]::integer;
      end if;
      m:=array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],left(month_text,3));
      if day_text ~ '^[0-9]' then day:=regexp_replace(day_text,'(st|nd|rd|th)$','')::integer;
      else day:=array_position(ordinals,regexp_replace(day_text,'[ -]+',' ','g')); end if;
      candidates:=array[array[y,m,day]];
    end if;
  end if;
  foreach candidate slice 1 in array candidates loop
    y:=candidate[1];m:=candidate[2];day:=candidate[3];
    begin d:=make_date(coalesce(y,2000),m,day);
    exception when datetime_field_overflow or invalid_datetime_format then continue; end;
    if y is not null then return next to_char(d,'YYYY-MM-DD'); end if;
    return next lower(to_char(d,'DD Mon'));
  end loop;
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
