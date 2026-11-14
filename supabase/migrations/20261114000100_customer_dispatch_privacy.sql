begin;
create function public.whatsapp_dispatch_privacy_snapshot(p_workspace_id uuid,p_phone text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare recipient uuid;allowed text[];terms text[];identities text[];owner_scope boolean:=false;
begin
 -- EXECUTE is restricted to service_role below; authenticated/anon cannot enter.
 if not coalesce((select count(*)=4 and bool_and(complete) from public.whatsapp_private_invoice_backfill),false) then
   raise exception 'Recipient privacy snapshot is not ready' using errcode='55000';
 end if;
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
 ), leaves as (select v#>>'{}' value from documents,jsonb_path_query(doc,'strict $.** ? (@.type() == "string" || @.type() == "number")')v), approval_words as (
 select app.private_invoice_normalize(x.value) value from public.invoices i
 cross join lateral (values(i.metadata->>'approved_reminder_text'),(i.metadata#>>'{approved_reminder_delivery,body}')) x(value)
 where i.workspace_id=p_workspace_id and i.customer_id=recipient and x.value is not null
 ), review_parties as (
 select distinct k from approval_words cross join lateral app.private_invoice_origin_aliases(value) k where k like 'party:%'
 ), independent_parties as (
 -- Preserve independent name witnesses, including retained declarations and
 -- explicit party fields. A reviewed sentence cannot certify its own inferred
 -- person labels, nor can it erase a separately stored person's identity.
 select k from public.customers c cross join lateral app.private_invoice_party_aliases(app.private_invoice_normalize(c.name)) k
 union select k from public.whatsapp_private_invoice_terms t
 cross join lateral (select case when t.term like 'origin:%' then substring(t.term from 8) else t.term end value) source
 cross join lateral app.private_invoice_party_aliases(source.value) k
 where t.term !~ '^[a-z-]+:' and not exists(select 1 from approval_words a where a.value=source.value)
 union select k from public.whatsapp_private_invoice_terms t
 cross join lateral app.private_invoice_origin_aliases(case when t.term like 'origin:%' then substring(t.term from 8) else t.term end) k
 where k like 'party:%' and (t.term like 'origin:%' or t.term !~ '^[a-z-]+:')
 and not exists(select 1 from approval_words a where a.value=case when t.term like 'origin:%' then substring(t.term from 8) else t.term end)
 ), keys as (
 select k from leaves cross join lateral app.private_invoice_term_aliases(app.private_invoice_normalize(value)) k
 union select k from public.customers c cross join lateral app.private_invoice_party_aliases(app.private_invoice_normalize(c.name)) k where c.workspace_id=p_workspace_id and c.id=recipient
 union select k from public.invoices i cross join lateral app.private_invoice_party_aliases(app.private_invoice_normalize(i.metadata->>'client_name')) k where i.workspace_id=p_workspace_id and i.customer_id=recipient
 union select k from public.workspace_settings s cross join lateral app.private_invoice_party_aliases(app.private_invoice_normalize(s.business_name)) k where s.workspace_id=p_workspace_id
 -- An owned review's complete prose is not itself a foreign field. This
 -- certifies only whole-field equality, never its numbers, dates or parties:
 -- foreign values embedded in reviewed words remain in the forbidden index.
 union select value from approval_words
 union select k from approval_words cross join lateral app.private_invoice_term_aliases(value) k where k like 'identifier:%'
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
 with projected as (
   select distinct p.term
   from public.whatsapp_private_invoice_terms stored
   cross join lateral (
     select array_agg(k) keys from app.private_invoice_origin_aliases(
       case when stored.term like 'origin:%' then substring(stored.term from 8) else stored.term end
     ) k where k ~ '^(number|number-run|date|date-range|party|party-native|party-latin|party-ref|identifier):'
   ) origin_keys
   cross join lateral unnest(case
     when cardinality(origin_keys.keys)>0 and (stored.term like 'origin:%' or stored.term !~ '^[a-z-]+:' and app.private_invoice_has_origin(stored.term)) then origin_keys.keys
     else array[stored.term] end) p(term)
 )
 select array_agg(term) into terms from projected
 where not(term=any(coalesce(allowed,array[]::text[])))
 and not (
   term !~ '^[a-z-]+:'
   and exists(select 1 from app.private_invoice_term_aliases(term) k where k<>term and k=any(coalesce(allowed,array[]::text[])))
   and not exists(select 1 from app.private_invoice_term_aliases(term) k where k<>term and not(k=any(coalesce(allowed,array[]::text[]))))
 );
 -- Only schema-declared opaque identities can consume numeric subcomponents.
 -- Free text (addresses, names, notes, approvals) is never an identity certificate.
 with source_ids as (
 select c.id::text value from public.customers c where c.workspace_id=p_workspace_id and (c.id=recipient or owner_scope)
 union select x.value from public.invoices i cross join lateral (values(i.id::text),(i.invoice_number),(i.metadata->>'printed_invoice_number'),(i.metadata->>'source_invoice_number')) x(value) where i.workspace_id=p_workspace_id and (i.customer_id=recipient or owner_scope)
 union select x.value from public.invoice_files f join public.invoices i on i.workspace_id=f.workspace_id and i.id=f.invoice_id cross join lateral (values(f.id::text),(f.storage_path)) x(value) where i.workspace_id=p_workspace_id and (i.customer_id=recipient or owner_scope)
 ) select array_agg(distinct k) into identities from source_ids cross join lateral app.private_invoice_term_aliases(app.private_invoice_normalize(value)) k where k like 'identifier:%' and substring(k from 12) ~ '[0-9]' and substring(k from 12) ~ '[a-z]';
 return jsonb_build_object('files',coalesce((select jsonb_agg(to_jsonb(f)) from public.invoice_files f join public.invoices i on i.workspace_id=f.workspace_id and i.id=f.invoice_id where i.workspace_id=p_workspace_id and i.customer_id=recipient),'[]'::jsonb),'values',coalesce(allowed,array[]::text[]),'terms',coalesce(terms,array[]::text[]),'identifiers',coalesce(identities,array[]::text[]));
end $$;
revoke all on function public.whatsapp_dispatch_privacy_snapshot(uuid,text) from public,anon,authenticated;
grant execute on function public.whatsapp_dispatch_privacy_snapshot(uuid,text) to service_role;
commit;
