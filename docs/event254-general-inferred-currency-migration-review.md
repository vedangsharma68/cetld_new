# Event254 general inferred-currency superseding review packet

Status: superseding proposal, not applied to production. New exact-file production approval is required before execution. This candidate replaces the previously offered AUD-only PR110 candidate; approval or review of the earlier bytes does not authorize this SQL.

The frozen earlier migration and [earlier review packet](event254-inferred-currency-migration-review.md) have not been edited. Their SHA-256 values remain `dc120167ddd8b64edbc860834d483d714dfbd607b8d35bd7dc974300b97bca66` and `de0335bc72c8b8a1ea7870ecd3e1ea71b9f18bfbeddfad5b469ad7272dc61d93` respectively. The earlier AUD-only SQL was not installed in production. The new SQL runs directly on the known PR108 predecessor; accepting the frozen earlier forward source also permits the existing offline migration chain to load before this superseding migration. There is no requirement to apply the earlier candidate first. This packet authorizes no retries of event254, invoice saves, payment changes, messages, reminders, source/ACL inspection, or other production action.

The reviewable migration is [`20261009040005_invoice_review_general_inferred_currency_correction.sql`](../supabase/migrations/20261009040005_invoice_review_general_inferred_currency_correction.sql). Apply that file's exact bytes only after the parent has reviewed the packet and approved its production SQL scope. A change to the SQL requires a new hash and renewed review.

| Exact artifact | Value |
| --- | --- |
| File encoding and endings | UTF-8, LF, final LF; no BOM |
| File bytes | 27,699 |
| File SHA-256 | `45db4bbee20d0206c5ef06dfd085f957748e77ade24f829e58932fda2e8ec7d5` |
| Expected predecessor normalized `prosrc` MD5 | `2ad9a819d7d03135ced3cc977986c75d` (PR108) |
| Compatible frozen earlier candidate normalized `prosrc` MD5 | `b0efe01d27fc8a04489e9c62e182245b` (not installed in production) |
| Resulting normalized `prosrc` MD5 | `fd9dbe74cc189b9f64d39c59406bec79` |
| Changed routine | `public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)` |
| Local CLI | Supabase 2.79.0, migration generated with `migration new` |
| Parent base | `dbcdd3e948df26fc4b5870af54ce6b407145036f` (earlier PR110 candidate) |

## Scope and expected behavior

Reported production event253 retained review31 at version2, with a full 93.50 balance, `PAYMENT_STATUS_CONFLICT`, uncertain direction, inferred AUD evidence `Melbourne, VIC 3000`, and a conflicting printed `Paid` stamp. The exact event254 owner clarification specifies that the business issued the invoice, USD is correct, no payment was received, and USD 93.50 remains due. PR108 only permits a currency exception for its zero-balance correction shape, so it cannot record this full-balance currency correction.

This superseding migration removes the earlier candidate's AUD-only restriction. It retains the narrow incomplete-review shape: only `direction` missing, only `PAYMENT_STATUS_CONFLICT`, outstanding equal to the original positive total, uncertain direction, no owner-provided currency, and a photo or legacy null currency source. Eligibility requires supported original currency with consistent bounded inference evidence. A photo source alone never establishes inference.

The evidence may be a canonical inference source emitted by `inferInvoiceCurrency`, matched to its original currency:

| Original currency | Canonical inference evidence |
| --- | --- |
| INR | Indian details |
| USD | US address or phone details |
| GBP | UK details |
| AED | UAE details |
| SGD | Singapore details |
| AUD | Australian details |
| CAD | Canadian details |
| CHF | Swiss details |
| EUR | European details |

Alternatively, the full evidence string may match `inferred CODE based on [REGION] KIND [details/evidence]`, with the CODE equal to the original currency and KIND equal to `address`, `country`, `phone` or `tax`. REGION is optional. No-country evidence such as `inferred CAD based on phone evidence` is accepted. If a region is given, a closed currency-consistent vocabulary is required: India/Indian, US/American/United States, UK/British/United Kingdom, UAE/Emirati/United Arab Emirates, Singapore/Singaporean, Australia/Australian, Canada/Canadian, Switzerland/Swiss, or European/European Union and the euro-area country names/adjectives already represented by the inference rules. All matches consume the full normalized string; optional suffixes are exactly `details` or `evidence`, and normalization only folds case and ASCII whitespace.

The reported legacy address `Melbourne, VIC/Victoria 3000` remains accepted for AUD (optional comma). It is a compatibility path alongside the general provenance rules. Printed currency codes or symbols, ambiguous dollar symbols, workspace defaults/assumptions, mixed inference/printed evidence, incorrect code/country combinations, unknown labels, unknown free clauses and unsupported currencies remain blocked. No evidence schema or future extraction behavior is changed; an unrecognized future evidence format fails closed.

The current owner instruction must satisfy the same closed clause grammar as the existing retained zero-balance parser. It requires issuer, false PAID stamp, no-payment/unpaid, and a supported-currency full balance matching the retained total. Normal clause reordering, conjunctions, ASCII whitespace, contiguous currency amounts, and an optional unpaid-draft/quiet clause are accepted. Every clause must be recognized once; quotes, questions, speculative wording, contradictory amounts/currencies/payment claims, extra instructions, duplicate factual clauses, and unknown clauses fail closed. The raw exact message, rather than normalized wording, is retained in the audit and matched to persisted messages.

The new exception may change currency and resolve uncertain direction to receivable. It clears the one conflict and records an unpaid resolution, while the total and full outstanding balance remain identical. The resolution's `extractedFacts` must exactly copy the original invoice, payment evidence, original source message ID, currency source marker, and currency evidence (including presence versus absence). `ownerProvidedFacts.currency` must match the new currency and reference the same current owner instruction. Printed identity, dates, subtotal, tax, total, other extraction fields, source provenance, and original payment evidence remain immutable. If subtotal and tax are both supplied, their cents must add to the original total.

The transition produces a proposal only. It creates no invoice, file, payment, reversal, ledger history, customer message, reminder, or action receipt. Runtime confirmation remains a separate later owner message; the parent owns its native integration verification. Existing zero-balance behavior and ordinary no-currency-change resolutions are retained.

## SQL authority and failure behavior

Execution performs one transaction containing only `CREATE OR REPLACE FUNCTION` for the named routine. It does not grant privileges, alter roles, tables, policies, storage or other routines, or update existing data rows. The migration reads the target routine's source, owner, ACL, security-definer flag and configuration inside its atomic guard. Those production catalog reads are part of the exact SQL approval scope; no separate production source or ACL inspection has been performed for this task.

Only the exact PR108 predecessor, the frozen earlier PR110 candidate, or this exact superseding forward source is recognized. Pure LF and pure CRLF stored bodies are accepted after CR normalization; mixed endings and unknown source hashes abort before replacement. Reapplying the exact forward body returns without mutation. After replacement, source hash, owner, ACL, security mode and configuration must all match expectations or the complete transaction rolls back. An older guarded migration rejects the new body, preventing silent rollback through old SQL.

Existing restricted EXECUTE grants, pinned search path and security-definer mode remain unchanged. Verified owner resolution must uniquely match the supplied workspace/customer/phone. The pending review must match ID, version, workspace, customer, phone and prior stage; it must be unconsumed and unexpired. The correction message must differ from the original attachment source, belong to a processing inbound event for that owner phone, match the raw persisted event and owner transcript exactly, and occur after review creation. Owner transcripts with NULL customer IDs remain accepted within the exact workspace/phone scope. CAS increments only the same retained review's version once.

## Local supporting evidence

Focused test: [`owner-retained-general-currency-correction-sql.test.mjs`](../tests/owner-retained-general-currency-correction-sql.test.mjs), run with `node --test tests/owner-retained-general-currency-correction-sql.test.mjs` against an isolated PGlite PostgreSQL database. The fixture applies the actual migration chain and actual retained transition; it forwards no network requests.

Checks cover all nine canonical currency inference sources, currency-consistent anchored descriptions with and without a country, mismatched labels/codes/countries, printed/ambiguous/default/unknown evidence rejection, the exact reported review shape and owner wording, equivalent bounded parser/SQL cases, every protected invoice fact, original audit tampering, currency provenance, current event/transcript matching, post-review timestamps, owner scope, NULL customer transcripts, denied anon/authenticated EXECUTE, expiry/consumption, one-success CAS, LF/CRLF replacement/idempotence, unknown/mixed source drift, atomic posthash/security rollback, unchanged other routines and zero invoice/payment/customer-message side effects. The PR108 and earlier PR110 source hashes were derived from their frozen repository files and confirmed by the isolated database; the superseding candidate was tested directly on PR108 and after the frozen earlier candidate with LF and CRLF bodies. No production database or private catalog was read.

Supabase's current [database function security guidance](https://supabase.com/docs/guides/database/functions) was consulted; routine security and privileges are preserved. The [September PostgreSQL minor release notice](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes) concerns extension/operator maintenance and does not change this function-only migration.

## Exact SQL

The following UTF-8 LF content is the entire reviewed file. The trailing newline immediately before the closing fence is part of the SQL file's bytes.

```sql
-- Supersedes the proposed Event254 AUD-only candidate; new exact-file approval required.
-- Replaces only the retained invoice review transition; no data rows change.
begin;
do $retained_review_correction$
declare
  target regprocedure := 'public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure;
  installed_source text; old_acl aclitem[]; old_owner oid; old_definer boolean; old_config text[];
begin
  select prosrc,proacl,proowner,prosecdef,proconfig
    into strict installed_source,old_acl,old_owner,old_definer,old_config
    from pg_catalog.pg_proc where oid=target;
  if installed_source is distinct from replace(installed_source,chr(13),'')
    and installed_source is distinct from replace(replace(installed_source,chr(13),''),chr(10),chr(13)||chr(10)) then
    raise exception 'Unexpected retained invoice review line endings; no changes applied';
  end if;
  if md5(replace(installed_source,chr(13),'')) not in (
    '2ad9a819d7d03135ced3cc977986c75d', -- exact PR108 predecessor
    'b0efe01d27fc8a04489e9c62e182245b', -- frozen earlier PR110 candidate (offline chain compatibility)
    'fd9dbe74cc189b9f64d39c59406bec79' -- exact general inferred-currency correction
  ) then
    raise exception 'Unexpected retained invoice review source; no changes applied';
  end if;
  if md5(replace(installed_source,chr(13),''))='fd9dbe74cc189b9f64d39c59406bec79' then return;end if;
  execute $definition$
CREATE OR REPLACE FUNCTION public.whatsapp_transition_invoice_review(p_id bigint, p_version bigint, p_workspace_id uuid, p_customer_id uuid, p_phone text, p_from_stage text, p_action jsonb)
 RETURNS TABLE(id bigint, version bigint, generation bigint, action jsonb, created_at timestamp with time zone, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_to_stage text;
  v_current_action jsonb;
  v_created_at timestamptz;
  v_field text;
  v_invoice_key text;
  v_fact jsonb;
  v_resolved_fields text[] := array[]::text[];
  v_resolved_invoice_keys text[] := array[]::text[];
  v_missing_count integer;
  v_distinct_missing_count integer;
  v_message_exists boolean;
  v_unpaid_resolution boolean := false;
  v_zero_balance_correction boolean := false;
  v_inferred_currency_correction boolean := false;
  v_currency_evidence text;
  v_inference_source text;
  v_inference_regions text;
  v_resolution jsonb;
  v_owner_quote text;
  v_balance_match text[];
  v_wording_valid boolean := false;
  v_owner_text text;
  v_clauses text[];
  v_clause text;
  v_clause_kind text;
  v_seen_clauses text[] := array[]::text[];
  v_clause_match text[];
  v_parsed_currency text;
  v_declared_currency text;
  v_parsed_amount numeric;
begin
  if p_action is not null and pg_catalog.jsonb_typeof(p_action) = 'object' then
    v_to_stage := p_action->>'stage';
  end if;
  if p_id is null or p_version is null or p_workspace_id is null or p_customer_id is null
    or p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$'
    or p_action is null or pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
    or p_action->>'type' is distinct from 'invoice_review_draft'
    or p_from_stage is null or p_from_stage not in ('extracting','incomplete','proposal','saving','failed')
    or v_to_stage is null or v_to_stage not in ('incomplete','proposal','saving','saved','failed','canceled')
    or not ((p_from_stage = 'extracting' and v_to_stage in ('incomplete','proposal','canceled'))
      or (p_from_stage = 'incomplete' and v_to_stage in ('incomplete','proposal','canceled'))
      or (p_from_stage = 'proposal' and v_to_stage in ('saving','canceled'))
      or (p_from_stage = 'saving' and v_to_stage in ('saved','proposal','failed'))
      or (p_from_stage = 'failed' and v_to_stage = 'canceled')) then
    raise exception 'invalid invoice review transition';
  end if;

  select p.action, p.created_at into v_current_action, v_created_at
    from public.whatsapp_pending_actions p
    where p.id = p_id and p.version = p_version
      and p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
      and p.consumed_at is null
      and (p.expires_at > pg_catalog.clock_timestamp() or p_from_stage = 'saving')
      and p.action->>'type' = 'invoice_review_draft' and p.action->>'stage' = p_from_stage
    for update;
  if not found then return; end if;

  if p_from_stage = 'incomplete' and v_to_stage in ('incomplete','proposal') then
    if pg_catalog.jsonb_typeof(v_current_action->'missingFields') is distinct from 'array'
      or pg_catalog.jsonb_typeof(p_action->'missingFields') is distinct from 'array'
      or pg_catalog.jsonb_typeof(v_current_action->'invoice') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_action->'invoice') is distinct from 'object'
      or pg_catalog.jsonb_typeof(coalesce(v_current_action->'ownerProvidedFacts','{}'::jsonb)) is distinct from 'object'
      or pg_catalog.jsonb_typeof(coalesce(p_action->'ownerProvidedFacts','{}'::jsonb)) is distinct from 'object'
      or (p_action - array['stage','invoice','missingFields','ownerProvidedFacts','currencySource','validationIssues','paymentStatusResolution'])
        is distinct from (v_current_action - array['stage','invoice','missingFields','ownerProvidedFacts','currencySource','validationIssues','paymentStatusResolution']) then
      raise exception 'invalid invoice review fact update';
    end if;


    -- The zero-balance variant may correct only currency and outstanding.
    -- Original extraction values and printed payment evidence remain audited.
    v_zero_balance_correction :=
      v_current_action->'validationIssues' @> '["PAYMENT_RECORD_REQUIRES_REVIEW","PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD"]'::jsonb
      and jsonb_array_length(v_current_action->'validationIssues') = 2
      and v_current_action->'invoice'->'outstanding' = '0'::jsonb
      and v_current_action->'invoice'->>'direction' = 'uncertain'
      and v_current_action->'missingFields' = '["direction"]'::jsonb
      and v_current_action->'invoice'->>'currency' in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')
      and (v_current_action->>'currencySource' is null or v_current_action->>'currencySource' = 'photo')
      and not (coalesce(v_current_action->'ownerProvidedFacts','{}'::jsonb) ? 'currency')
      and v_current_action->'paymentEvidence'->>'status' = 'paid';
    v_zero_balance_correction := coalesce(v_zero_balance_correction,false);

    -- Canonical inference sources mirror inferInvoiceCurrency. Photo also
    -- represents printed currencies, so it never establishes inference alone.
    v_currency_evidence := trim(lower(regexp_replace(v_current_action->>'currencyEvidence',E'[ \\t\\r\\n]+',' ','g')));
    v_inference_source := case v_current_action->'invoice'->>'currency'
      when 'INR' then 'indian details'
      when 'USD' then 'us address or phone details'
      when 'GBP' then 'uk details'
      when 'AED' then 'uae details'
      when 'SGD' then 'singapore details'
      when 'AUD' then 'australian details'
      when 'CAD' then 'canadian details'
      when 'CHF' then 'swiss details'
      when 'EUR' then 'european details' end;
    v_inference_regions := case v_current_action->'invoice'->>'currency'
      when 'INR' then 'india|indian'
      when 'USD' then 'us|american|united states'
      when 'GBP' then 'uk|british|united kingdom'
      when 'AED' then 'uae|emirati|united arab emirates'
      when 'SGD' then 'singapore|singaporean'
      when 'AUD' then 'australia|australian'
      when 'CAD' then 'canada|canadian'
      when 'CHF' then 'switzerland|swiss'
      when 'EUR' then 'european|european union|germany|german|france|french|italy|italian|spain|spanish|ireland|irish|netherlands|dutch|belgium|belgian|austria|austrian|portugal|portuguese' end;
    v_inferred_currency_correction :=
      v_current_action->'validationIssues' = '["PAYMENT_STATUS_CONFLICT"]'::jsonb
      and v_current_action->'invoice'->'outstanding' = v_current_action->'invoice'->'total'
      and v_current_action->'invoice'->>'direction' = 'uncertain'
      and v_current_action->'missingFields' = '["direction"]'::jsonb
      and v_inference_source is not null
      and p_action->'invoice'->>'currency' is distinct from v_current_action->'invoice'->>'currency'
      and (v_current_action->>'currencySource' is null or v_current_action->>'currencySource' = 'photo')
      and not (coalesce(v_current_action->'ownerProvidedFacts','{}'::jsonb) ? 'currency')
      and jsonb_typeof(v_current_action->'currencyEvidence') = 'string'
      and jsonb_typeof(v_current_action->'sourceMessageId') = 'string'
      and nullif(v_current_action->>'sourceMessageId','') is not null
      and (v_currency_evidence = v_inference_source
        or v_currency_evidence ~ ('^inferred ' || lower(v_current_action->'invoice'->>'currency')
          || ' based on (?:(?:' || v_inference_regions || ') )?(?:address|country|phone|tax)(?: details| evidence)?$')
        or (v_current_action->'invoice'->>'currency' = 'AUD'
          and v_currency_evidence ~ '^melbourne,? (vic|victoria) 3000$'));
    v_inferred_currency_correction := coalesce(v_inferred_currency_correction,false);

    -- A false PAID stamp needs a current persisted owner instruction.
    if p_action->'validationIssues' is distinct from v_current_action->'validationIssues'
      or p_action->'paymentStatusResolution' is distinct from v_current_action->'paymentStatusResolution' then
      v_resolution := p_action->'paymentStatusResolution';
      v_owner_quote := v_resolution->>'ownerInstruction';
      if v_zero_balance_correction or v_inferred_currency_correction then
        -- Same closed clause grammar as retainedUnpaidEvidence in JS.
        -- All clauses must be recognized; factual clauses occur only once.
        v_owner_text := trim(lower(regexp_replace(v_owner_quote,E'[ \\t\\r\\n]+',' ','g')));
        v_wording_valid := v_owner_quote is not null and length(v_owner_quote) between 1 and 4000
          and v_owner_text ~ '^[ -~]+$' and v_owner_text !~ '[?"''`]';
        if v_wording_valid then
          v_clauses := regexp_split_to_array(v_owner_text,'[,:;]+|(?<![0-9])[.]|[.](?![0-9])|\mand\M');
          v_clauses := array(select trim(clause) from unnest(v_clauses) clause where trim(clause)<>'');
          v_wording_valid := cardinality(v_clauses) between 4 and 12;
          foreach v_clause in array v_clauses loop
            v_clause_kind := null;
            if v_clause ~ '^(my business|our business|we|i) (have )?issued (it|this( invoice)?|the invoice)$' then
              v_clause_kind := 'issuer';
            elsif v_clause ~ '^((the|that|this) )?paid (stamp|marking|watermark) is (incorrect|wrong|false)$' then
              v_clause_kind := 'stamp';
            elsif v_clause ~ '^(no payment has been received|nothing has been paid|(it|this( invoice)?|the invoice) is unpaid)$' then
              v_clause_kind := 'unpaid';
            else
              v_clause_match := regexp_match(v_clause,'^(?:the )?currency is ([a-z]{3})$');
              if v_clause_match is not null then
                v_clause_kind := 'currency';v_declared_currency := upper(v_clause_match[1]);
              else
                v_clause_match := regexp_match(v_clause,'^(?:the )?full ([a-z]{3}) ?([0-9]+(?:[.][0-9]{1,2})?) (?:is )?still due$');
                if v_clause_match is null then
                  v_clause_match := regexp_match(v_clause,'^(?:it|this(?: invoice)?|the invoice|(?:the )?(?:total|amount|full balance)) is ([a-z]{3}) ?([0-9]+(?:[.][0-9]{1,2})?)$');
                end if;
                if v_clause_match is not null then
                  v_clause_kind := 'balance';v_parsed_currency := upper(v_clause_match[1]);v_parsed_amount := v_clause_match[2]::numeric;
                else
                  v_clause_match := regexp_match(v_clause,'^(?:the )?full balance (?:of )?([0-9]+(?:[.][0-9]{1,2})?) (?:is )?still due$');
                  if v_clause_match is not null then
                    v_clause_kind := 'balance';v_parsed_amount := v_clause_match[1]::numeric;
                  elsif v_clause ~ '^(please )?save (it|this( invoice)?|the invoice) as an unpaid draft( with no customer messages or reminders)?$' then
                    v_clause_kind := 'save';
                  elsif v_clause ~ '^(please )?keep (customer messages or )?reminders off$|^no customer messages or reminders$' then
                    v_clause_kind := 'quiet';
                  end if;
                end if;
              end if;
            end if;
            if v_clause_kind is null or v_clause_kind=any(v_seen_clauses) then
              v_wording_valid := false;exit;
            end if;
            v_seen_clauses := array_append(v_seen_clauses,v_clause_kind);
          end loop;
          v_wording_valid := v_wording_valid
            and v_seen_clauses @> array['issuer','stamp','unpaid','balance']
            and v_parsed_amount=(v_current_action->'invoice'->>'total')::numeric
            and (v_parsed_currency is null or v_declared_currency is null or v_parsed_currency=v_declared_currency)
            and coalesce(v_parsed_currency,v_declared_currency)=v_resolution->>'currency'
            and coalesce(v_parsed_currency,v_declared_currency) in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF');
        end if;
      end if;
      if (v_current_action->'validationIssues' is distinct from '["PAYMENT_STATUS_CONFLICT"]'::jsonb and not v_zero_balance_correction)
        or p_action->'validationIssues' is distinct from '[]'::jsonb
        or v_current_action ? 'paymentStatusResolution'
        or jsonb_typeof(v_resolution) is distinct from 'object'
        or v_resolution - (array['status','outstanding','currency','sourceMessageId','ownerInstruction'] || case when v_zero_balance_correction or v_inferred_currency_correction then array['extractedFacts'] else array[]::text[] end) <> '{}'::jsonb
        or v_resolution->>'status' is distinct from 'unpaid'
        or v_resolution->'outstanding' is distinct from v_current_action->'invoice'->'total'
        or v_resolution->>'currency' is distinct from p_action->'invoice'->>'currency'
        or p_action->'invoice'->>'direction' is distinct from 'receivable'
        or v_current_action->'invoice'->'alreadyPaid' is distinct from 'false'::jsonb
        or jsonb_typeof(v_current_action->'invoice'->'total') is distinct from 'number'
        or (v_current_action->'invoice'->>'total')::numeric <= 0
        or (not v_zero_balance_correction and v_current_action->'invoice'->'outstanding' is distinct from v_current_action->'invoice'->'total')
        or coalesce(v_current_action->'paymentEvidence'->>'status','') not in ('paid','conflicting')
        or coalesce(v_current_action->'paymentEvidence'->>'text','') !~* '\mPAID\M'
        or v_owner_quote is null or length(v_owner_quote) not between 1 and 4000
        or nullif(v_resolution->>'sourceMessageId','') is null
        or v_resolution->>'sourceMessageId' = v_current_action->>'sourceMessageId'
        or ((v_zero_balance_correction or v_inferred_currency_correction) and v_wording_valid is not true)
        or (not (v_zero_balance_correction or v_inferred_currency_correction) and (v_owner_quote ~ '[?"“”`]' or replace(replace(v_owner_quote,'’',''''),'‘','''') ~ '(^|[[:space:]])'''
        or replace(replace(v_owner_quote,'’',''''),'‘','''') ~* '\m(not|never|isn''t|wasn''t|aren''t|don''t|didn''t|cannot|can''t|maybe|perhaps|might|could|would|if|whether|later|tomorrow|next|someone|says|said|quoted)\M'
        or v_owner_quote !~* '\m(my business|our business|we|i)[[:space:]]+(have[[:space:]]+)?issued\M'
        or not (v_owner_quote ~* '\m(it|this( invoice)?|the invoice)[[:space:]]+is[[:space:]]+unpaid\M'
          or (v_owner_quote ~* '\mno payment has been received\M'
            and v_owner_quote ~* '\msave (it|this( invoice)?|the invoice) as an unpaid draft\M'))
        or regexp_replace(v_owner_quote,'\mno payment has been received\M','','gi')
          ~* '\mpayment (has been|was|is) received\M|\mreceived (a |the )?payment\M'
        or v_owner_quote !~* '\m(the[[:space:]]+)?PAID[[:space:]]+(stamp|marking|watermark)[[:space:]]+is[[:space:]]+(incorrect|wrong|false)\M'
        or v_owner_quote ~* '\m(it|this( invoice)?|the invoice)[[:space:]]+is[[:space:]]+(already[[:space:]]+)?paid\M'
        or v_owner_quote ~* '\mPAID[[:space:]]+(stamp|marking|watermark)[[:space:]]+is[[:space:]]+(correct|right|true)\M')) then
        raise exception 'invoice review unpaid resolution lacks explicit evidence';
      end if;
      v_balance_match := regexp_match(v_owner_quote,
        '\m(the[[:space:]]+)?full[[:space:]]+([A-Za-z]{3})[[:space:]]+([0-9]+([.][0-9]{1,2})?)[[:space:]]+(is[[:space:]]+)?still[[:space:]]+due\M','i');
      if (not (v_zero_balance_correction or v_inferred_currency_correction) and (v_balance_match is null or upper(v_balance_match[2]) is distinct from v_resolution->>'currency'
        or v_balance_match[3]::numeric is distinct from (v_current_action->'invoice'->>'total')::numeric
        or (select count(*) from regexp_matches(v_owner_quote,'\mfull[[:space:]]+[A-Za-z]{3}[[:space:]]+[0-9]+([.][0-9]{1,2})?[[:space:]]+(is[[:space:]]+)?still[[:space:]]+due\M','gi')) <> 1))
        or (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r
          where r.workspace_id=p_workspace_id and r.customer_id=p_customer_id) <> 1
        or not exists (select 1 from public.whatsapp_inbound_events e
          where e.provider_message_id=v_resolution->>'sourceMessageId' and e.sender_phone=p_phone
            and e.status='processing' and e.message_text=v_owner_quote and e.received_at>=v_created_at)
        or not exists (select 1 from public.whatsapp_messages m
          where m.provider_message_id=v_resolution->>'sourceMessageId'
            and m.workspace_id=p_workspace_id and m.phone=p_phone
            and (m.customer_id is null or m.customer_id=p_customer_id)
            and m.audience='owner' and m.direction='inbound' and m.status in ('received','accepted')
            and m.body=v_owner_quote and m.created_at>=v_created_at) then
        raise exception 'invoice review unpaid resolution source is outside current owner scope';
      end if;
      if v_inferred_currency_correction then
        v_fact := p_action->'ownerProvidedFacts'->'currency';
        if v_to_stage is distinct from 'proposal'
          or v_resolution->'extractedFacts' is distinct from (
            select jsonb_object_agg(f.key,f.value) from jsonb_each(v_current_action) f
            where f.key = any(array['invoice','paymentEvidence','sourceMessageId','currencySource','currencyEvidence']))
          or p_action->'invoice'->'outstanding' is distinct from v_current_action->'invoice'->'outstanding'
          or v_resolution->>'currency' not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')
          or jsonb_typeof(v_fact) is distinct from 'object'
          or v_fact - array['value','sourceMessageId'] <> '{}'::jsonb
          or v_fact->'value' is distinct from p_action->'invoice'->'currency'
          or v_fact->>'sourceMessageId' is distinct from v_resolution->>'sourceMessageId'
          or (v_current_action->'invoice'->>'subtotal' is not null and v_current_action->'invoice'->>'tax' is not null
            and (jsonb_typeof(v_current_action->'invoice'->'subtotal') is distinct from 'number'
              or jsonb_typeof(v_current_action->'invoice'->'tax') is distinct from 'number'
              or round((v_current_action->'invoice'->>'subtotal')::numeric*100)
                + round((v_current_action->'invoice'->>'tax')::numeric*100)
                <> round((v_current_action->'invoice'->>'total')::numeric*100))) then
          raise exception 'invoice review inferred currency correction lacks explicit evidence';
        end if;
        v_resolved_fields := array_append(v_resolved_fields,'currency');
        v_resolved_invoice_keys := array_append(v_resolved_invoice_keys,'currency');
      end if;
      if v_zero_balance_correction then
        v_fact := p_action->'ownerProvidedFacts'->'currency';
        if v_to_stage is distinct from 'proposal'
          or v_resolution->'extractedFacts' is distinct from jsonb_build_object(
            'currency',v_current_action->'invoice'->'currency','outstanding',v_current_action->'invoice'->'outstanding')
          or p_action->'invoice'->'outstanding' is distinct from v_current_action->'invoice'->'total'
          or v_resolution->>'currency' not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')
          or jsonb_typeof(v_fact) is distinct from 'object'
          or v_fact - array['value','sourceMessageId'] <> '{}'::jsonb
          or v_fact->'value' is distinct from p_action->'invoice'->'currency'
          or v_fact->>'sourceMessageId' is distinct from v_resolution->>'sourceMessageId'
          or (v_current_action->'invoice'->>'subtotal' is not null and v_current_action->'invoice'->>'tax' is not null
            and (jsonb_typeof(v_current_action->'invoice'->'subtotal') is distinct from 'number'
              or jsonb_typeof(v_current_action->'invoice'->'tax') is distinct from 'number'
              or round((v_current_action->'invoice'->>'subtotal')::numeric*100)
                + round((v_current_action->'invoice'->>'tax')::numeric*100)
                <> round((v_current_action->'invoice'->>'total')::numeric*100))) then
          raise exception 'invoice review zero balance correction lacks explicit evidence';
        end if;
        v_resolved_fields := array_append(v_resolved_fields,'currency');
        v_resolved_invoice_keys := array_append(array_append(v_resolved_invoice_keys,'currency'),'outstanding');
      end if;
      v_unpaid_resolution := true;
    end if;

    v_missing_count := pg_catalog.jsonb_array_length(p_action->'missingFields');
    select count(distinct field.value)::integer
      into v_distinct_missing_count
      from pg_catalog.jsonb_array_elements_text(p_action->'missingFields') as field(value);
    if v_missing_count is distinct from v_distinct_missing_count
      or exists (
        select 1 from pg_catalog.jsonb_array_elements_text(p_action->'missingFields') as next_field(value)
        where next_field.value not in ('invoiceNumber','customerName','invoiceDate','dueDate','total','currency','direction')
          or not (v_current_action->'missingFields' @> pg_catalog.to_jsonb(next_field.value))
      ) then
      raise exception 'invalid invoice review missing fields';
    end if;

    for v_field in select pg_catalog.jsonb_array_elements_text(v_current_action->'missingFields') loop
      if not (p_action->'missingFields' @> pg_catalog.to_jsonb(v_field)) then
        v_invoice_key := case when v_field = 'customerName' then 'clientName' else v_field end;
        v_fact := p_action->'ownerProvidedFacts'->v_field;
        if pg_catalog.jsonb_typeof(v_fact) is distinct from 'object'
          or (v_fact - array['value','sourceMessageId']) <> '{}'::jsonb
          or v_fact->'value' is null or v_fact->'value' = 'null'::jsonb
          or p_action->'invoice'->v_invoice_key is null
          or p_action->'invoice'->v_invoice_key is distinct from v_fact->'value'
          or nullif(v_fact->>'sourceMessageId','') is null then
          raise exception 'invoice review fact lacks owner evidence';
        end if;
        if v_field = 'direction' and v_fact->>'value' is distinct from 'receivable' then
          raise exception 'invoice review direction must be explicitly receivable';
        end if;
        select exists (
          select 1 from public.whatsapp_messages m
          where m.provider_message_id = v_fact->>'sourceMessageId'
            and m.workspace_id = p_workspace_id and m.phone = p_phone
            and (m.customer_id is null or m.customer_id = p_customer_id)
            and m.audience = 'owner' and m.direction = 'inbound'
            and m.status in ('received','accepted') and m.created_at >= v_created_at
        ) into v_message_exists;
        if not v_message_exists then raise exception 'invoice review fact source is outside owner scope'; end if;
        v_resolved_fields := pg_catalog.array_append(v_resolved_fields, v_field);
        v_resolved_invoice_keys := pg_catalog.array_append(v_resolved_invoice_keys, v_invoice_key);
      end if;
    end loop;

    if (cardinality(v_resolved_fields) = 0 and not v_unpaid_resolution)
      or ((p_action->'ownerProvidedFacts') - v_resolved_fields)
        is distinct from (coalesce(v_current_action->'ownerProvidedFacts','{}'::jsonb) - v_resolved_fields)
      or ((p_action->'invoice') - v_resolved_invoice_keys)
        is distinct from ((v_current_action->'invoice') - v_resolved_invoice_keys) then
      raise exception 'invoice review update cannot overwrite existing facts';
    end if;

    if v_to_stage = 'incomplete' and v_missing_count = 0 then
      raise exception 'complete invoice review must become a proposal';
    end if;
    if v_to_stage = 'proposal' and v_missing_count <> 0 then
      raise exception 'incomplete invoice review cannot become a proposal';
    end if;
    if 'currency' = any(v_resolved_fields) then
      if p_action->>'currencySource' is distinct from 'user' then
        raise exception 'owner-provided currency must retain its source';
      end if;
    elsif p_action->'currencySource' is distinct from v_current_action->'currencySource' then
      -- Legacy reviewDraft stored null provenance for confident extracted
      -- currencies. Its missingFields list preserves that confidence result.
      -- The invoice currency remains protected by the fixed-fact check above.
      if (v_current_action->>'currencySource' is null
        and p_action->>'currencySource' = 'photo'
        and v_current_action->'invoice'->>'currency' ~ '^[A-Za-z]{3}$'
        and not (v_current_action->'missingFields' @> pg_catalog.to_jsonb('currency'::text))) is not true then
        raise exception 'invoice review currency source is immutable';
      end if;
    end if;
  end if;

  if v_to_stage in ('proposal','saving','saved') and
    (p_action->'invoice' is null or pg_catalog.jsonb_typeof(p_action->'invoice') is distinct from 'object'
      or p_action->'missingFields' is distinct from '[]'::jsonb
      or coalesce(p_action->'validationIssues','[]'::jsonb) is distinct from '[]'::jsonb
      or p_action->>'currencySource' is null
      or p_action->>'currencySource' not in ('photo','user')) then
    raise exception 'incomplete invoice review proposal';
  end if;

  return query
    update public.whatsapp_pending_actions p
      set action = p_action, version = p.version + 1
      where p.id = p_id and p.version = p_version
        and p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
        and p.consumed_at is null
        and (p.expires_at > pg_catalog.clock_timestamp() or p_from_stage = 'saving')
        and p.action->>'type' = 'invoice_review_draft' and p.action->>'stage' = p_from_stage
      returning p.id, p.version, p.generation, p.action, p.created_at, p.expires_at;
end
$function$
$definition$;
  if exists(select 1 from pg_catalog.pg_proc where oid=target and
    (proacl is distinct from old_acl or proowner is distinct from old_owner
      or prosecdef is distinct from old_definer or proconfig is distinct from old_config
      or md5(replace(prosrc,chr(13),'')) <> 'fd9dbe74cc189b9f64d39c59406bec79')) then
    raise exception 'Retained invoice review routine security or source changed';
  end if;
end;
$retained_review_correction$;
commit;
```
