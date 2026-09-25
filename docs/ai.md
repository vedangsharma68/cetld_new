# AI backend contract

Server-only entry point: `/api/ai?action=settings|extract|assistant`. All calls
require `Authorization: Bearer <Supabase access token>`. Server validates the
user through Supabase Auth and checks `workspace_members`; every data query uses
the user's token, RLS, and an explicit workspace filter. No service-role key.

## Configuration

Server environment: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`. Never prefix the AI key with a public/client variable
prefix or put it in a database, URL, request from a browser, or source file.
Rotate any key previously shared in chat before configuring hosting secrets.

Apply the AI settings migrations, including
`supabase/migrations/20260925130000_gemini_primary_openrouter_fallback.sql`, to
the target **non-production** database before integration testing. The forward
migration normalizes legacy rows before enforcing the provider-specific model
contract. This branch does not apply migrations remotely or deploy production.

Workspace answers use `gemini-3.5-flash` as the primary model and the verified
`openrouter/free` endpoint as the optional fallback. Invoice extraction uses
`gemini-3.5-flash-lite` with the same OpenRouter free fallback. Unknown and
paid IDs are rejected at the API, provider, and database boundaries; fallback
must be OpenRouter Free and primary must be Gemini. The models endpoint and
settings writes verify current provider availability. A retryable provider failure receives bounded
retries before the configured fallback is tried. A 429 is surfaced as a safe
temporary rate-limit error after those attempts; no key or provider response
body is returned. There is no automatic paid-model substitution.

`AIProvider.generate()` / `generateStructured()` are the shared server abstraction
for extraction and assistant planning. Authentication/malformed-output errors
do not trigger fallback.
Financial answers are **deterministically rendered tool results**, not LLM prose.
The model selects tools; it cannot supply authoritative financial values.

## Workspace model settings

`GET /api/ai?action=settings&workspaceId=<uuid>` returns:

```json
{"workspace_id":"...","primary_model":"gemini-3.5-flash","fallback_model":"openrouter/free"}
```

`PUT /api/ai?action=settings`, JSON body:

```json
{"workspaceId":"...","primary_model":"gemini-3.5-flash","fallback_model":"openrouter/free"}
```

Owner/admin only; both IDs are checked against their provider catalogs. Members can read.
The SQL table contains model IDs and timestamps only. An absent settings row
reads as defaults; updates are atomic upserts. Direct database writes are also
restricted by RLS; syntactically valid but unavailable IDs still fail at runtime.

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
OpenRouter Free fallback receives the same bounded input. Scanned/poor-quality
PDFs may require another image upload or manual entry; model support is not a
guarantee of OCR accuracy. Provide the appropriate privacy disclosure before
enabling uploads.

Response fields: `invoiceNumber`, `customerName`, `invoiceDate`, `dueDate`,
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
Confidence is model-reported, not calibrated probability. UI must display
uncertainty/warnings and require review before using the existing invoice-save
workflow.

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
