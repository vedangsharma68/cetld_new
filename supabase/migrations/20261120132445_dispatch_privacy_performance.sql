begin;
set local lock_timeout='1s';
set local statement_timeout='5s';

-- Cache pure expansions, never authorization, readiness, ownership or membership.
-- A changed input has a different key; active retained terms are read on EVERY
-- send. Workspace deletion removes its private cached data as well.
create table app.private_dispatch_alias_cache (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 revision bytea not null,
 input_kind text not null check(input_kind in ('generic','party','origin')),
 input_hash bytea not null,
 input_value text not null,
 aliases text[] not null,
 primary key(workspace_id,revision,input_kind,input_hash)
);
alter table app.private_dispatch_alias_cache enable row level security;
revoke all on app.private_dispatch_alias_cache from public,anon,authenticated,service_role;

create function app.private_dispatch_aliases(p_workspace_id uuid,p_value text,p_kind text,p_revision bytea,p_write boolean) returns text[]
language plpgsql security definer set search_path='' set enable_seqscan=off as $memo$
declare digest bytea;remembered text;keys text[];
begin
 if p_value is null then return array[]::text[];end if;
 if p_value ~ '^[0-9]+$' then
  if p_kind in ('party','origin') then return array[]::text[];end if;
  if p_kind='generic' then return array(select * from app.private_invoice_term_aliases(p_value));end if;
 end if;
 if p_kind='generic' and p_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  return case when p_value ~ '[a-f]' then array[p_value,'identifier:'||replace(p_value,'-','')] else array[p_value] end;
 end if;
 digest:=sha256(convert_to(p_value,'UTF8'));
 select input_value,aliases into remembered,keys from app.private_dispatch_alias_cache
 where workspace_id=p_workspace_id and revision=p_revision and input_kind=p_kind and input_hash=digest;
 if found then
  if remembered is distinct from p_value then raise exception 'PRIVATE_DISPATCH_CACHE_COLLISION';end if;
  return keys;
 end if;
 case p_kind
 when 'generic' then keys:=array(select * from app.private_invoice_term_aliases(p_value));
 when 'party' then keys:=array(select * from app.private_invoice_party_aliases(p_value));
 when 'origin' then keys:=array(select * from app.private_invoice_origin_aliases(p_value));
 else raise exception 'INVALID_PRIVATE_DISPATCH_CACHE_KIND';
 end case;
 if p_write and p_workspace_id is not null then
  insert into app.private_dispatch_alias_cache(workspace_id,revision,input_kind,input_hash,input_value,aliases)
  select p_workspace_id,p_revision,p_kind,digest,p_value,keys where exists(select 1 from public.workspaces where id=p_workspace_id)
  on conflict do nothing;
 end if;
 return keys;
end $memo$;
revoke all on function app.private_dispatch_aliases(uuid,text,text,bytea,boolean) from public,anon,authenticated,service_role;

-- Lexically unambiguous scalar/opaque forms cannot contain a shared calendar.
-- Avoid constructing the calendar/word grammar before these existing fast paths.
do $fast$
declare definition text;uuid_path text;start_at integer;end_at integer;
begin
 definition:=pg_get_functiondef('app.private_invoice_term_aliases(text)'::regprocedure);
 start_at:=strpos(definition,'  -- UUIDs have no scalar/date/word-number interpretation.');
 end_at:=strpos(substring(definition from start_at),'  term:=regexp_replace(term,')+start_at-1;
 if start_at=0 or end_at<start_at then raise exception 'PRIVATE_ALIAS_FAST_PATH_MISMATCH';end if;
 uuid_path:=substring(definition from start_at for end_at-start_at);
 definition:=replace(definition,uuid_path,'');
 definition:=replace(definition,'  return next term;', '  return next term;'||chr(10)||uuid_path||
 $integer$  if term ~ '^[0-9]+$' then return query select * from app.private_invoice_numeric_candidates(term,false);return;end if;
$integer$);
 execute definition;
end $fast$;

-- Reuse already-computed exact aliases during retention, including backfill.
-- The memo writer lock is TRY-only: concurrent readers/writers always retain
-- the identical uncached calculation, never wait on another memo transaction.
do $capture$
declare definition text;original text;
begin
 definition:=pg_get_functiondef('app.private_invoice_capture_field(uuid,text,text,bytea)'::regprocedure);original:=definition;
 definition:=replace(definition,'declare revision bytea:=p_revision;',
  'declare memo_revision bytea:=sha256(convert_to(app.private_invoice_canonical_revision(),''UTF8''));memo_write boolean:=pg_try_advisory_xact_lock(1128617036,1146310723);revision bytea:=p_revision;');
 definition:=replace(definition,'array(select * from app.private_invoice_term_aliases(p_value))',
  'app.private_dispatch_aliases(p_workspace_id,p_value,''generic'',memo_revision,memo_write)');
 definition:=replace(definition,'array(select * from app.private_invoice_party_aliases(p_value))',
  'app.private_dispatch_aliases(p_workspace_id,p_value,''party'',memo_revision,memo_write)');
 if definition=original or strpos(definition,'declare memo_revision')=0 then raise exception 'PRIVATE_CAPTURE_CACHE_PATCH_MISMATCH';end if;
 execute definition;
 definition:=pg_get_functiondef('app.retain_private_origin_terms(uuid,text)'::regprocedure);original:=definition;
 definition:=replace(definition,'declare document jsonb;',
  'declare memo_revision bytea:=sha256(convert_to(app.private_invoice_canonical_revision(),''UTF8''));memo_write boolean:=pg_try_advisory_xact_lock(1128617036,1146310723);document jsonb;');
 definition:=replace(definition,$old$from app.private_invoice_origin_aliases(document #>> '{}') term$old$,
  $new$from unnest(app.private_dispatch_aliases(p_workspace_id,document #>> '{}','origin',memo_revision,memo_write)) term$new$);
 if definition=original or strpos(definition,'declare memo_revision')=0 then raise exception 'PRIVATE_ORIGIN_CACHE_PATCH_MISMATCH';end if;
 execute definition;
end $capture$;

create or replace function public.whatsapp_dispatch_privacy_snapshot(p_workspace_id uuid,p_phone text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare recipient uuid;allowed text[];terms text[];identities text[];owner_scope boolean:=false;revision bytea;memo_write boolean;
begin
 -- EXECUTE is restricted to service_role below; authenticated/anon cannot enter.
 if not coalesce((select count(*)=4 and bool_and(complete) from public.whatsapp_private_invoice_backfill),false) then
   raise exception 'Recipient privacy snapshot is not ready' using errcode='55000';
 end if;
 revision:=sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8'));
 memo_write:=pg_try_advisory_xact_lock(1128617036,1146310723);
 if p_workspace_id is not null then
   -- Same consent-independent owner proof used by resolveOwnerIdentity:
   -- current owner membership, current configured phone, actual code verification.
   select exists(select 1 from public.workspaces w
     join public.workspace_settings s on s.workspace_id=w.id and s.whatsapp_owner_phone=p_phone
     join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id and m.role='owner'
     join public.whatsapp_owner_verifications v on v.workspace_id=w.id and v.requested_by=w.owner_id and v.phone=p_phone and v.verified_at is not null
     where w.id=p_workspace_id) into owner_scope;
   if not owner_scope then
     -- A removed binding owns no customer fields. Fixed consent confirmations
     -- still pass through the boundary and their existing inbound authority;
     -- multiple bindings remain an error rather than an ownership grant.
     recipient := (select id from public.customers where workspace_id=p_workspace_id and phone=p_phone);
   end if;
 end if;
 with documents as (
 select to_jsonb(c) doc from public.customers c where c.workspace_id=p_workspace_id and c.id=recipient
 union all select jsonb_build_object('business_name',s.business_name) from public.workspace_settings s where s.workspace_id=p_workspace_id
 union all select jsonb_build_object('remaining',greatest(0,i.total_amount-coalesce(i.amount_paid,0))) from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=recipient
 union all select to_jsonb(f) from public.invoice_files f join public.invoices i on i.id=f.invoice_id and i.workspace_id=f.workspace_id where i.workspace_id=p_workspace_id and i.customer_id=recipient
 union all select (to_jsonb(i)-'metadata'-'notes')||jsonb_build_object('invoice_direction',i.metadata->'invoice_direction','printed_invoice_number',i.metadata->'printed_invoice_number','source_invoice_number',i.metadata->'source_invoice_number') from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=recipient
 ), leaves as materialized (select distinct v#>>'{}' value from documents,jsonb_path_query(doc,'strict $.** ? (@.type() == "string" || @.type() == "number")')v), approval_words as (
 select app.private_invoice_normalize(x.value) value from public.invoices i
 cross join lateral (values(i.metadata->>'approved_reminder_text'),(i.metadata#>>'{approved_reminder_delivery,body}')) x(value)
 where i.workspace_id=p_workspace_id and i.customer_id=recipient and x.value is not null
 ), review_parties as (
 select distinct k from approval_words cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,value,'origin',revision,memo_write)) k where k like 'party:%'
 ), independent_sources as (
 -- Preserve independent name witnesses, including retained declarations and
 -- explicit party fields. A reviewed sentence cannot certify its own inferred
 -- person labels, nor can it erase a separately stored person's identity.
 select k from public.customers c cross join lateral unnest(app.private_dispatch_aliases(c.workspace_id,app.private_invoice_normalize(c.name),'party',revision,memo_write)) k
 union select k from public.whatsapp_private_invoice_terms t
 cross join lateral (select case when t.term like 'origin:%' then substring(t.term from 8) else t.term end value) source
 cross join lateral unnest(app.private_dispatch_aliases(t.workspace_id,source.value,'party',revision,memo_write)) k
 where t.term !~ '^[a-z-]+:' and not exists(select 1 from approval_words a where a.value=source.value)
 union select k from public.whatsapp_private_invoice_terms t
 cross join lateral unnest(app.private_dispatch_aliases(t.workspace_id,case when t.term like 'origin:%' then substring(t.term from 8) else t.term end,'origin',revision,memo_write)) k
 where k like 'party:%' and (t.term like 'origin:%' or t.term !~ '^[a-z-]+:')
 and not exists(select 1 from approval_words a where a.value=case when t.term like 'origin:%' then substring(t.term from 8) else t.term end)
 ), independent_parties as (
 select k from independent_sources where exists(select 1 from review_parties)
 ), keys as (
 select k from leaves cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,app.private_invoice_normalize(value),'generic',revision,memo_write)) k
 union select k from public.customers c cross join lateral unnest(app.private_dispatch_aliases(c.workspace_id,app.private_invoice_normalize(c.name),'party',revision,memo_write)) k where c.workspace_id=p_workspace_id and c.id=recipient
 union select k from public.invoices i cross join lateral unnest(app.private_dispatch_aliases(i.workspace_id,app.private_invoice_normalize(i.metadata->>'client_name'),'party',revision,memo_write)) k where i.workspace_id=p_workspace_id and i.customer_id=recipient
 union select k from public.workspace_settings s cross join lateral unnest(app.private_dispatch_aliases(s.workspace_id,app.private_invoice_normalize(s.business_name),'party',revision,memo_write)) k where s.workspace_id=p_workspace_id
 -- An owned review's complete prose is not itself a foreign field. This
 -- certifies only whole-field equality, never its numbers, dates or parties:
 -- foreign values embedded in reviewed words remain in the forbidden index.
 union select value from approval_words
 union select k from approval_words cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,value,'generic',revision,memo_write)) k where k like 'identifier:%'
 union select k from review_parties where not exists(select 1 from independent_parties p where p.k=review_parties.k)
 -- Existing verified-owner authority is workspace-wide (invoice-store.mjs).
 -- These remain ordinary allowed keys, not a dispatch or scanner exemption.
 union select t.term from public.whatsapp_private_invoice_terms t
 where t.workspace_id=p_workspace_id and owner_scope
 ) select array_agg(distinct k) into allowed from keys;
 -- Include foreign workspaces too: even owners may disclose only their scope.
 -- Whole-field aliases may have different renderings (125.00 versus 125).
 -- A raw field is owned only when it has an owned canonical key and EVERY
 -- canonical key agrees. Unknown keys or a foreign member keep it protected.
 -- Only actual origins need origin projection. Typed canonical terms used to
 -- execute the entire parser before their result was discarded by CASE.
 with owned as materialized (select distinct unnest(coalesce(allowed,array[]::text[])) k),
 stored as materialized (
  select distinct on(term_hash,term) workspace_id,term from public.whatsapp_private_invoice_terms order by term_hash,term,workspace_id
 ), origin_sources as materialized (
  select * from stored where term like 'origin:%' or term !~ '^[a-z-]+:' and app.private_invoice_has_origin(term)
 ), origins as materialized (
  select s.term,array_agg(k) filter(where k ~ '^(number|number-run|date|date-range|party|party-native|party-latin|party-ref|identifier):') keys
  from origin_sources s cross join lateral unnest(app.private_dispatch_aliases(s.workspace_id,case when s.term like 'origin:%' then substring(s.term from 8) else s.term end,'origin',revision,memo_write)) k
  group by s.term
 ), projected as materialized (
  select p.term,min(s.workspace_id::text)::uuid workspace_id from stored s left join origins o using(term)
  cross join lateral unnest(case when cardinality(o.keys)>0 then o.keys else array[s.term] end) p(term) group by p.term
 ), raw_aliases as materialized (
  select p.term,k from projected p cross join lateral unnest(app.private_dispatch_aliases(p.workspace_id,p.term,'generic',revision,memo_write)) k
  where p.term !~ '^[a-z-]+:' and not exists(select 1 from owned o where o.k=p.term)
 ), owned_raw as materialized (
  select a.term from raw_aliases a left join owned o on o.k=a.k where a.k<>a.term
  group by a.term having bool_or(o.k is not null) and bool_and(o.k is not null)
 )
 select array_agg(p.term) into terms from projected p
 where not exists(select 1 from owned o where o.k=p.term)
 and not exists(select 1 from owned_raw o where o.term=p.term);
 -- Only schema-declared opaque identities can consume numeric subcomponents.
 -- Free text (addresses, names, notes, approvals) is never an identity certificate.
 with source_ids as (
 select c.id::text value from public.customers c where c.workspace_id=p_workspace_id and (c.id=recipient or owner_scope)
 union select x.value from public.invoices i cross join lateral (values(i.id::text),(i.invoice_number),(i.metadata->>'printed_invoice_number'),(i.metadata->>'source_invoice_number')) x(value) where i.workspace_id=p_workspace_id and (i.customer_id=recipient or owner_scope)
 union select x.value from public.invoice_files f join public.invoices i on i.workspace_id=f.workspace_id and i.id=f.invoice_id cross join lateral (values(f.id::text),(f.storage_path)) x(value) where i.workspace_id=p_workspace_id and (i.customer_id=recipient or owner_scope)
 ) select array_agg(distinct k) into identities from source_ids cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,app.private_invoice_normalize(value),'generic',revision,memo_write)) k where k like 'identifier:%' and substring(k from 12) ~ '[0-9]' and substring(k from 12) ~ '[a-z]';
 return jsonb_build_object('files',coalesce((select jsonb_agg(to_jsonb(f)) from public.invoice_files f join public.invoices i on i.workspace_id=f.workspace_id and i.id=f.invoice_id where i.workspace_id=p_workspace_id and i.customer_id=recipient),'[]'::jsonb),'values',coalesce(allowed,array[]::text[]),'terms',coalesce(terms,array[]::text[]),'identifiers',coalesce(identities,array[]::text[]));
end $$;
revoke all on function public.whatsapp_dispatch_privacy_snapshot(uuid,text) from public,anon,authenticated;
grant execute on function public.whatsapp_dispatch_privacy_snapshot(uuid,text) to service_role;
commit;
