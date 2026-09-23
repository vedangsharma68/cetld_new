# AI backend contract

Server-only entry point: `/api/ai?action=settings|extract|assistant`. All calls
require `Authorization: Bearer <Supabase access token>`. Server validates the
user through Supabase Auth and checks `workspace_members`; every data query uses
the user's token, RLS, and an explicit workspace filter. No service-role key.

## Configuration

Server environment: `OPENROUTER_API_KEY`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`. Never prefix the AI key with a public/client variable
prefix or put it in a database, URL, request from a browser, or source file.
Rotate any key previously shared in chat before configuring hosting secrets.

Apply `supabase/migrations/20260922185109_ai_workspace_settings.sql` to the
target **non-production** database before integration testing. This branch does
not apply migrations remotely or deploy production.

The primary default is `qwen/qwen3.8-27b:free`; the fallback defaults to null.
The exact primary ID was present in OpenRouter's live public model catalog on
2026-09-22. Runtime requests validate current availability. Missing/unavailable
models fail safely; only an explicitly configured fallback is attempted once.
There is no alternate API/provider or automatic paid-model substitution.

`AIProvider.generate()` / `generateStructured()` are the shared server abstraction
for extraction, assistant planning, and future WhatsApp agent integration.
Timeout defaults to 20 seconds per upstream attempt; at most two completion
attempts. Authentication/malformed-output errors do not trigger fallback.
Financial answers are **deterministically rendered tool results**, not LLM prose.
The model selects tools; it cannot supply authoritative financial values.

## Workspace model settings

`GET /api/ai?action=settings&workspaceId=<uuid>` returns:

```json
{"workspace_id":"...","primary_model":"qwen/qwen3.8-27b:free","fallback_model":null}
```

`PUT /api/ai?action=settings`, JSON body:

```json
{"workspaceId":"...","primary_model":"qwen/qwen3.8-27b:free","fallback_model":null}
```

Owner/admin only; both IDs are checked against the catalog. Members can read.
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

PDF, PNG, JPEG, WebP only, with MIME/signature validation. Images are inline
image inputs; PDFs use OpenRouter's file-parser plugin (`pdf-text`, a currently
supported legacy alias). Scanned/poor-quality PDFs may require another image
upload or manual entry; parser/model support is not a guarantee of OCR accuracy.
The document is transmitted to OpenRouter and its configured parsing/model
providers; provide the appropriate privacy disclosure before enabling uploads.

Response fields: `invoiceNumber`, `customerName`, `invoiceDate`, `dueDate`,
`subtotal`, `tax`, `total`, `outstandingAmount`, `currency`, `clientPhone`,
`clientEmail`, `lineItems`, each with `value` and `confidence`.
Also `uncertainFields`, `warnings`, `reviewRequired: true`, `model`, `usedFallback`.
Currency is ISO code or null (ambiguous symbols are not guessed). Confidence is
model-reported, not calibrated probability. UI must display uncertainty/warnings
and require review before using the existing invoice-save workflow.

## Dashboard assistant

`POST /api/ai?action=assistant`:

```json
{"workspaceId":"...","message":"Who owes us the most?","history":[]}
```

Optional history: at most 8 `{role:"user"|"assistant",content:"..."}` entries.
No client-supplied system messages/tool results, no scope-changing tool args.
Response: `answer` (deterministic Markdown report), `sources` (structured tool
results), optional `guidance` (general collection suggestions), `asOf`, `timezone`,
`model`, `usedFallback`, `readOnly:true`. UI should render `sources` as financial
cards/tables and escape user text; `answer` is a safe plain-text fallback.

Read-only tools: `getInvoices`, `getCustomer`, `getPayments`,
`getOutstandingSummary`, `getOverdueInvoices`, `getActivity`.
Totals use exact decimal arithmetic, grouped by currency, with no exchange-rate
assumptions. Collection totals use recorded payment transactions; outstanding
balances use invoice `amount_paid`. These may differ if records are unreconciled.
Date boundaries use UTC. Aggregates refuse more than 5,000 source rows instead
of silently reporting partial totals. Lists are bounded and marked where truncated.
The existing unprefixed core schema has no verified follow-up log; activity
explicitly distinguishes invoice/payment events and current follow-up metadata.
Legacy `cetld_*` automation tables are not mixed into workspace financial data.

## Verification / integration boundaries

`npm test` runs regression tests; `npm run test:ai` includes isolated PostgreSQL
(PGlite) migration/RLS tests and mocked HTTP/model tests. `npm run typecheck`.
`npm run test:ai:live` is an opt-in real completion smoke test that requires an
already configured `OPENROUTER_API_KEY`; it never prints the key or response.
Live authenticated model/extraction tests were not run in this workspace because
the secret environment was not configured. No new UI wiring is included.

Before production: verify end-to-end against a staging Supabase deployment and
configure platform rate limits/usage quotas. Per-request size/tool/time limits
are enforced here; distributed usage billing/rate limiting is not implemented.
