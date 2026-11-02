# AI backend contract

Server-only entry point: `/api/ai?action=settings|diagnostic|extract|assistant`. All calls
require `Authorization: Bearer <Supabase access token>`. Server validates the
user through Supabase Auth and checks `workspace_members`; every data query uses
the user's token, RLS, and an explicit workspace filter. No service-role key.

## Configuration

WhatsApp chat uses server-only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
The primary is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; the existing Cloudflare
Scout model is the default backup. Saved Cloudflare choices remain usable.
Legacy non-Cloudflare WhatsApp selections resolve to these existing free models
without rewriting saved settings. No new provider or paid tier is required.

Gemini generation, fallback, model verification and enabled extraction routes
make no Google requests, even when an old `GEMINI_API_KEY` is configured. The
legacy Settings diagnostic is disabled by withholding its credential; its
response shape remains available. Saved legacy model IDs are preserved for
compatibility, but Gemini cannot be selected for new settings or returned as an
available model. Legacy standalone diagnostic/codec fixtures are unit tests,
not enabled routes. Other existing dashboard model settings remain unchanged.

Cloudflare failures retain bounded retries and the existing circuit breaker.
When its available models are exhausted, WhatsApp says chat is temporarily
unavailable, asks the user to retry, and states that nothing was lost: invoice
records and local reviews remain saved. Invoice reads, menus and review actions
continue locally without relying on provider availability.

## WhatsApp invoice containment and conversational memory

Invoice photos/PDFs always use the local reader, with `EXTRACTION_ROUTE=offline`
set or unset. The flag remains supported for the direct owner review route.
Images use bundled Tesseract OCR; PDFs use local selectable text and parsers.
Unreadable documents require a clearer upload or manual input, with no model
fallback. Customer receipt photos/PDFs receive a deterministic explanation to
ask the business owner to verify and record payment. They never start an owner
review, mark the workspace, or create invoices/payments.

Provider chat receives the last **20 eligible ordinary messages**, scoped by
workspace, phone, audience and owner/customer identity, from the server-owned
`whatsapp_provider_memory` table. Only successfully completed ordinary chat
pairs enter that store. Invoice intake, extracted fields, corrections, reviews,
confirmations and deterministic invoice replies remain in the local audit and
are excluded. Caller history, summaries, profiles, response schemas, media,
checkpoints and unissued tool transcripts cannot supply provider context.
Only registered static tools and results from tool calls issued in that turn
can enter a non-invoice tool loop; private results stop that loop locally.

`whatsapp_private_invoice_terms` retains local field/evidence terms across
review replacement, cancellation, history pruning and invoice/customer updates.
Provider memory and current messages are screened for quotations of those terms,
including previously ordinary messages that later become invoice-bearing. Both
new tables have RLS and service-only access. Storage failure fails closed for
that chat attempt without forwarding raw history. Historical audit rows have
unknown provenance and are not copied into provider memory; ordinary memory
starts accumulating after deployment. Existing history remains available locally.

The old permanent workspace provenance mark remains intact for existing data
and other callers. WhatsApp no longer uses it as a global functionality wall.
Invoice questions use verified database reads and deterministic receivables
rendering, separating drafts, issued receivables and currencies. Incomplete or
unsupported questions receive an honest local refusal, never a model-invented
balance. Reminder dispatch, Zoho provenance and commercial-send gates are unchanged.

Apply `supabase/migrations/20261101120327_private_whatsapp_chat_memory.sql` before
deploying the application. It adds private memory/term tables, retention triggers
and a local backfill; it does not unmark or rewrite pre-existing data. Rollback
can revert application usage and detach the new triggers while retaining the
new tables/data. Do not deploy the old unsafe provider path as a privacy rollback.

## Workspace model settings

`GET /api/ai?action=settings&workspaceId=<uuid>` returns:

```json
{"workspace_id":"...","primary_model":"space-bunny-free","fallback_model":null}
```

`PUT /api/ai?action=settings`, JSON body:

```json
{"workspaceId":"...","primary_model":"space-bunny-free","fallback_model":null}
```

Owner/admin only; both IDs are checked against their provider catalogs. Members can read.
The SQL table contains model IDs and timestamps only. An absent settings row
reads as defaults; updates are atomic upserts. Direct database writes are also
restricted by RLS; syntactically valid but unavailable IDs still fail at runtime.

The primary model is excluded from the fallback picker and the fallback model
is excluded from the primary picker. A legacy duplicate selection retains the
primary and clears the duplicate in the picker; server reads resolve it to a
distinct default. New duplicate writes
are rejected by the API and database constraint.
Unavailable options remain visible but disabled. Saved selections are retained
during temporary provider outages; saving other settings does not replace them.

WhatsApp owner chat reads the same `workspace_ai_settings.primary_model` and
`fallback_model` columns. No separate `owner_provider` or `owner_model` columns
are needed. With no settings row, owner chat keeps its current Cloudflare Llama
3.3 primary and Cloudflare Scout fallback. WhatsApp chooses only existing Cloudflare models; saved settings are not rewritten.

The direct workspace settings path supports the free Zen aliases documented
above. The existing WhatsApp proposal SQL path has a separate older model
allowlist and does not support these aliases; use the typed Workspace AI
Settings page/API for those model selections. No new migration is needed for
the direct settings path.

## Invoice extraction (review required, never auto-saved)

`POST /api/ai?action=extract`. Choose one input:

- Existing private invoice file: `{"workspaceId":"...","fileId":"..."}`.
  The server looks up `invoice_files` under caller RLS, checks the path belongs
  to that workspace/invoice, then downloads up to 10 MiB from `invoice-files`.
- Pre-save upload: `{"workspaceId":"...","file":{"base64":"...","mimeType":"application/pdf","fileName":"invoice.pdf"}}`.
  Maximum decoded size 3 MiB, below the serverless JSON payload limit. No URL
  inputs. This lets the upload UI prefill a draft before any invoice is saved.

PDF, PNG, JPEG, WebP only, with MIME/signature validation. This endpoint parses
locally and constructs no model provider. PDFs without readable text and images
that cannot be verified require another upload or manual entry. Source documents
and extracted fields never enter an extraction-provider request.

Response fields: `direction` (`receivable`, `payable`, or `uncertain`), `invoiceNumber`, `customerName`, `invoiceDate`, `dueDate`,
`subtotal`, `tax`, `total`, `outstandingAmount`, `currency`, `clientPhone`,
`clientEmail`, `lineItems`, each with `value` and `confidence`.
Also `uncertainFields`, `warnings`, `reviewRequired: true`, `model`, `usedFallback`.
Currency is one of INR, USD, EUR, GBP, AED, SGD, AUD, CAD, or CHF, or null
(ambiguous symbols are not guessed). CETLD's invoice and payment ledger stores
two decimal places, so currencies with zero or three minor-unit digits (such as
JPY, KWD, or BHD) are rejected across settings, invoice entry, extraction, and
Assistant invoice actions. Amounts with more than two decimal places are rejected
without rounding. Existing rows in unsupported currencies remain readable with
their stored decimal value labeled as unsupported; repricing and payment
recording are blocked, so create a corrected invoice in a supported currency.
Confidence describes local parser evidence, not a calibrated probability. WhatsApp requires the verified owner to state issuance; the local reader never infers it from a seller name. The UI displays uncertainty and warnings and requires an explicit
direction choice. Only confirmed receivables can enter the collections ledger;
payables and uncertain invoices remain unsaved. Zero totals, subtotal plus tax
differences greater than one minor unit, and partial outstanding amounts are
rejected at save time. A one-cent printed rounding adjustment remains visible
as an extraction warning for owner review.
A partial balance needs a separately recorded payment. Missing due dates require
owner input before Assistant save or follow-up approval.

## Dashboard assistant

`POST /api/ai?action=assistant`:

```json
{"workspaceId":"...","message":"Who owes us the most?","history":[]}
```

Optional history: at most 8 `{role:"user"|"assistant",content:"..."}` entries.
No client-supplied system messages/tool results, no scope-changing tool args.
Response: `answer` (deterministic answer), `evidence` (safe source label,
freshness, completeness/truncation, and safe invoice references), optional
`guidance` (general collection suggestions), `asOf`, `timezone`, `model`,
`usedFallback`, `readOnly:true`. The UI renders the answer and minimal evidence
metadata; evidence excludes internal workspace and row IDs.

Read-only tools: `getInvoices`, `getCustomer`, `getPayments`,
`getOutstandingSummary`, `getOverdueInvoices`, `getActivity`, and
`getInvoiceDetails`. Named invoice/client questions are resolved
deterministically before model planning. One unambiguous match is enriched with
that invoice's customer contact fields, payment rows, original-file metadata,
safe follow-up/reminder metadata, latest recorded customer-response snapshot,
and bookkeeping-sync status. No unrelated workspace rows are added to the
model context; ambiguous matches return a clarification question.
Totals use exact decimal arithmetic, grouped by currency, with no exchange-rate
assumptions. Collection totals use recorded payment transactions; outstanding
balances use invoice `amount_paid`. These may differ if records are unreconciled.
Date boundaries use UTC. Aggregates refuse more than 5,000 source rows instead
of silently reporting partial totals. Lists are bounded and marked where truncated.
The existing unprefixed core schema has no verified follow-up/message-history
table; activity explicitly distinguishes invoice/payment events and the
current follow-up, reminder-draft, and latest-response metadata that is actually
present. Missing history is reported as not recorded rather than inferred.
Legacy `cetld_*` automation tables are not mixed into workspace financial data.

## Verification / integration boundaries

`npm test` runs regression tests; `npm run test:ai` includes isolated PostgreSQL
(PGlite) migration/RLS tests and mocked HTTP/model tests. `npm run typecheck`.
`npm run test:ai:live` is an opt-in real completion smoke test that requires the
server provider keys; it never prints keys or response content. Live
authenticated model/extraction tests were not run in this workspace unless
explicitly reported by the current verification run.

Before production: verify end-to-end against a staging Supabase deployment and
configure platform rate limits/usage quotas. Per-request size/tool/time limits
are enforced here; distributed usage billing/rate limiting is not implemented.


## Private-value containment (PR #211, repair round 3)

All production WhatsApp and web Assistant chat requests pass
`createPrivateChatProvider`. Retained values are screened with the same matcher
at current-message, positive-history, decoded tool argument/result, model-response
and memory-write boundaries. Protocol JSON is decoded recursively before matching;
malformed tool protocol fails closed. Caller transcripts, profiles, private schema
values, summaries, checkpoints and error bodies are not forwarded. Tool transcripts
must belong to the exact issued call. Local domain results stay local even when
not yet represented by a retained literal.

SQL and JS use identical generated Unicode 17 data: compatibility decomposition,
locale-independent upper/lower caseless folding, combining-mark and Cf removal,
a shared White_Space fold (including U+0085 and NBSP), and native decimal digits.
Arabic decimal/thousands punctuation normalizes with the numeric separators.
`generate-private-value-unicode.mjs --check` and
`generate-private-value-sql.mjs --check` verify committed artifacts; the language
vocabulary and date pivot come from `private-value-language.mjs`.

Numbers use exact decimal strings/BigInt. Complete valid international/Indian
comma/dot/space/apostrophe groups remain one value (`1 250` is not `1` and `250`).
Invalid grouping chains are segmented as lists, with comma+space separating list
items; `1250, 77` and `1250 77` cannot hide a retained `1250`. Malformed `1,2500`
does not become `1250`. Both valid grouping/decimal interpretations are checked
only against retained values. A dotted short date is also compared as one whole
amount when that interpretation exists, without comparing date components. Currency words and symbols are affixes; signed and
parenthesized scalar strings retain the magnitude conservatively. Decimal-comma,
trailing-zero, k/m/b multipliers, cardinal number phrases with comma/&/and
connectors, decimal phrases and common fractional/scaled phrases are normalized.
Typed `number:` aliases prevent canonical decimals gaining another thousands
interpretation on reload. Whole tokens distinguish 100/1000 and ann/planning.
Alphanumeric identifiers compare independently of punctuation/spacing, while
INV-12 and INV-123 remain different.

Dates accept dots/slashes/hyphens, DD/MM and MM/DD ambiguity, year-first forms,
short or full years, yearless numeric forms, English month names in either order,
ordinal suffixes and English ordinal days first through thirty-first. The shared
pivot is **00–69 → 2000–2069; 70–99 → 1970–1999**. Explicit years match only the
same retained year; yearless input matches retained month/day. A truly yearless
stored date cannot establish a year and remains conservative. Full-year fields
emit typed year-aware aliases, never lossy month/day aliases.

Complete local text-invoice instructions use the existing guarded parser before
clause separation. Web memory adapters forward both retained-value and private-span
checks, so punctuation inside a known name cannot create independent fragments.
Mixed turns retain whole independently understandable ordinary clauses; there
is no ordinary-intent allowlist. Referential/conjunctive fragments and action
constraints remain local. Original-offset private spans prevent splitting any known field across delimiters.
Unparsed create/correction statements stay opaque through the end of the turn;
only an independent prefix can precede them. Delimiters inside amounts, dates,
number phrases or protocol JSON cannot launder fragments into ordinary chat. Only the selected
ordinary text and screened ordinary answer enter the 20-message positive memory.
Legacy audit history remains local. The web memory scope is separate from the
WhatsApp scope; its internal service-only store requires the existing server-side
SUPABASE_SERVICE_ROLE_KEY after caller membership authorization. No ledger or
Storage RLS is bypassed. Dashboard UI files are unchanged.

Both audience menus are deterministic-local; customer receipts remain refusals
before extraction, marking, review or provider access. Invoice questions use
scoped database tools and deterministic replies. Cloudflare exhaustion never
falls back to Gemini and produces an honest temporary-unavailability reply.

The production fast battery uses the real handler directly (43 scenarios), and
`owner-engine.mjs` can no longer replace its wrapped provider. The original 38
planner/tool-state battery scenarios and 49 historical planner simulation suites
remain enabled as explicitly named **engine subsystem** tests using local mocks.
They are not counted as production privacy coverage. A paired actual-handler/
production-fixture test must show zero calls for retained `Explain 1250` and the
same sanitized mixed-turn payload. Native SQL tests separately cover retention,
backfill, local review, menus, both audiences, memory, receipts and failures.

Every SQL change remains in the **unapplied**
`20261101120327_private_whatsapp_chat_memory.sql`: replace locale-dependent
normalization with the shared Unicode map; expand the exact-number helper for
symbols/wrappers/native digits/multipliers; add the immutable invoker word-number
helper; update term aliases for word/identifier and typed year-aware dates; retain
linked customer name/company/email/phone on invoice insert/update; add company_name
to the existing backfill. All helpers retain empty search_path and direct EXECUTE
revoked from PUBLIC/anon/authenticated/service_role. The existing tables, indexes,
RLS/service grants, transaction, deduplication and trigger definitions are retained;
the ledger retention function body now includes the linked customer lookup.
Printed evidence has an explicit tagged source kind: the new immutable invoker
`app.private_invoice_evidence_aliases(text)` derives labelled payloads and
currency-bearing candidates before the first subsequent chat, even when amount
validation fails. The term retainer expands these aliases, and the review
trigger/backfill pass a named printedEvidence envelope. JSON numbers use only
numeric aliases; labelled monetary evidence does not acquire yearless-date
aliases. Full date fields preserve their explicit year. Direct execution is
revoked for this helper too. The owner review text is unchanged. No
original invoice/audit/mark rows are rewritten or unmarked. Re-run the drift,
atomicity/object-reference and ACL audit on the final migration hash before apply.

Residuals: arithmetic-derived expressions, scientific notation, hostile encodings
or homoglyphs beyond compatibility/combining-mark/Cf normalization, and resolving
relative dates when no retained value is restated. These are not universal
semantic DLP guarantees. Ordinary short dates, native decimal digits and the
supported natural number grammar are covered, not residuals.
