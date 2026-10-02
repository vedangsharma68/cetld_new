# AI backend contract

Server-only entry point: `/api/ai?action=settings|diagnostic|extract|assistant`. All calls
require `Authorization: Bearer <Supabase access token>`. Server validates the
user through Supabase Auth and checks `workspace_members`; every data query uses
the user's token, RLS, and an explicit workspace filter. No service-role key.

## Configuration

Server environment: `GEMINI_API_KEY`, `OPENCODE_ZEN_API_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`. Never prefix the AI key with a public/client variable
prefix or put it in a database, URL, request from a browser, or source file.
Rotate any key previously shared in chat before configuring hosting secrets.

## Fixed Gemini diagnostic

Workspace owners and admins may explicitly run the Settings diagnostic. The
server sends four sequential, fixed requests to `gemini-3.5-flash-lite`: tiny
text, a bundled readable PNG, a small structured response, and the current
exported invoice extraction schema with that PNG. It never uses workspace
invoices, accepts no prompt/file/model/URL input, invokes no fallback provider,
and performs no writes or outbound messaging. Reports contain only the model,
stage/status, HTTP status, finite categories, recognized Google ErrorInfo
metadata, and allowlisted field paths; provider messages and bodies are
discarded.

The probe has a 45-second total budget, bounded response reads, cancellation,
and a per-user server cooldown. A successful HTTP response with an invoice
payload that fails local validation is reported separately as
`contract_invalid`; it is not treated as an HTTP rejection.

Unit tests use mocked provider contracts and the bundled fixture. They do not
contact Google, so this change does **not** identify the production HTTP 400
root cause. An authorized owner/admin must run the deployed probe and review
its finite report before drawing that conclusion.

Apply the AI settings migrations, including
`supabase/migrations/20260928110000_zen_primary_gemini_fallback.sql`, to
the target **non-production** database before integration testing. The forward
migration normalizes legacy rows before enforcing the provider-specific model
contract. This branch does not apply migrations remotely or deploy production.

Workspace answers use the saved primary and fallback models. Existing default
selections remain OpenCode Zen `space-bunny-free` and `longcat-2.5-preview-free`.
Both pickers also offer Cloudflare Llama 3.3, Llama 4 Scout, Mistral Small 3.1,
GPT OSS 20B, Qwen3 30B A3B, GLM 4.7 Flash, and Gemini 3.5 Flash and Flash Lite.
The browser labels for GPT OSS, Qwen3, and GLM map to their canonical Cloudflare
IDs; those full IDs are stored, not the shorthand labels. Unknown IDs are
rejected at the API and provider boundaries. The models endpoint and settings
writes check Cloudflare and Gemini catalogs; legacy Zen checks require its
server credential. These checks do not prove successful live generation.
A retryable provider failure receives bounded
retries before the configured fallback is tried. A 429 is surfaced as a safe
temporary rate-limit error after those attempts; no key or provider response
body is returned. Cloudflare failures continue through the existing Gemini
recovery chain, and the Cloudflare circuit breaker remains active. Invoice
extraction continues to use its dedicated Gemini configuration. The Zen model
IDs can be overridden server-side with `ZEN_PRIMARY_MODEL` and `ZEN_FALLBACK_MODEL`.

Provider references: [Cloudflare model catalog](https://developers.cloudflare.com/workers-ai/models/),
[Cloudflare OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/),
and [Cloudflare model search API](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/).

`AIProvider.generate()` / `generateStructured()` are the shared server abstraction
for extraction and assistant planning. Authentication errors advance to the
next model without retrying the rejected leg.
Financial answers are **deterministically rendered tool results**, not LLM prose.
The model selects tools; it cannot supply authoritative financial values.

## Workspace model settings

`GET /api/ai?action=settings&workspaceId=<uuid>` returns:

```json
{"workspace_id":"...","primary_model":"space-bunny-free","fallback_model":"longcat-2.5-preview-free"}
```

`PUT /api/ai?action=settings`, JSON body:

```json
{"workspaceId":"...","primary_model":"space-bunny-free","fallback_model":"longcat-2.5-preview-free"}
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
3.3 primary and Gemini Flash fallback. An explicitly disabled fallback remains
disabled as a user selection; provider safety recovery follows its existing policy.

Before using the new model selections, review and apply
`supabase/migrations/20261002060000_workspace_ai_model_choices.sql` to the target
database. It expands model checks without rewriting saved rows or changing RLS.
This migration is generated only and has not been executed, including locally.
The migration-executing tests are excluded from this change's verification.

## Invoice extraction (review required, never auto-saved)

`POST /api/ai?action=extract`. Choose one input:

- Existing private invoice file: `{"workspaceId":"...","fileId":"..."}`.
  The server looks up `invoice_files` under caller RLS, checks the path belongs
  to that workspace/invoice, then downloads up to 10 MiB from `invoice-files`.
- Pre-save upload: `{"workspaceId":"...","file":{"base64":"...","mimeType":"application/pdf","fileName":"invoice.pdf"}}`.
  Maximum decoded size 3 MiB, below the serverless JSON payload limit. No URL
  inputs. This lets the upload UI prefill a draft before any invoice is saved.

PDF, PNG, JPEG, WebP only, with MIME/signature validation. Images and PDFs are
sent to Gemini as inline media; if Gemini fails retryably, the configured
OpenCode Zen fallback chain receives the same bounded input. Scanned/poor-quality
PDFs may require another image upload or manual entry; model support is not a
guarantee of OCR accuracy. Provide the appropriate privacy disclosure before
enabling uploads.

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
Confidence is model-reported, not calibrated probability. The extractor receives
the workspace business name to classify whether the business issued the invoice
or owes it. The UI displays uncertainty and warnings and requires an explicit
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
