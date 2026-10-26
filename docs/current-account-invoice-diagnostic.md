# Saved invoice diagnostic in the current accounting account

`POST /api/accounting` with the fixed `action: "invoice-diagnostic"` selector is
an explicit owner-only diagnostic, using the existing deployed function.
It checks a saved invoice's exact external ID inside the workspace owner's
**current** authenticated Zoho Books organization. Historical export origin is
unknown: every diagnostic result says `provenance: "provenance_unverified"`.
It does not establish linkage ownership, the original export destination, or
authority to remind, approve, queue, dispatch or send.

## Invocation

Use an existing authenticated owner bearer session. The JSON body must contain
exactly this action and two UUID fields; no query parameters are accepted:

```http
POST /api/accounting
Authorization: Bearer <existing-owner-session>
Content-Type: application/json

{"action":"invoice-diagnostic","workspaceId":"<workspace-uuid>","invoiceId":"<saved-local-invoice-uuid>"}
```

No provider, external invoice ID, organization, account, user or action override
is accepted. Auth resolves the user and verifies workspace ownership. The saved
row resolves provider/external ID; the existing connection resolves the current
account. The exact row query includes soft-deleted rows without restoring or
rebinding them. Missing/unlinked/malformed/cross-workspace rows fail before any
provider request. Contradictory stored linkage markers are rejected.

## Sanitized examples (fictional identities)

Verified exact resource in the current account:

```json
{
  "workspaceId": "10000000-0000-0000-0000-000000000001",
  "invoiceId": "10000000-0000-0000-0000-000000000003",
  "provenance": "provenance_unverified",
  "checkedAt": "2026-10-26T08:00:00.000Z",
  "existence": "present",
  "provider": "zoho_books",
  "currentAccountId": "987654321",
  "exactId": "123456789",
  "status": "partially_paid",
  "currency": "INR",
  "totalMinor": 12500,
  "balanceMinor": 10000,
  "paidMinor": 2500
}
```

The same identity fields accompany an unsuccessful remote read after scope
revalidation, but no status/money fields are returned:

```json
{
  "workspaceId": "10000000-0000-0000-0000-000000000001",
  "invoiceId": "10000000-0000-0000-0000-000000000003",
  "provenance": "provenance_unverified",
  "checkedAt": "2026-10-26T08:00:00.000Z",
  "existence": "unverifiable",
  "provider": "zoho_books",
  "currentAccountId": "987654321",
  "exactId": "123456789",
  "reason": "provider_absence_unverifiable"
}
```

No Zoho error contract has been verified to prove exact-resource absence.
Consequently **no response is classified as absent**, including HTTP 404/code
1002. HTTP 401, 403 and 429 are respectively authentication, access-denial and
throttle failures; network, other HTTP errors, invalid JSON, wrong IDs/accounts
and unsafe status/money remain unverifiable. Provider error bodies are not read.
QuickBooks disconnected is `not_connected`; connected QuickBooks and Tally are
`provider_unsupported`. These are unavailable diagnostics, never simulated reads.

Local request failures use HTTP 400/401/403/404/405 (413 for oversized JSON).
Operational outcomes use HTTP 200 with `existence: "unverifiable"` and a stable
reason, including `timeout`, `connection_changed` or `local_record_changed`.
Those early/invalidated outcomes omit current-account/provider facts.

## Bounds, validation and effects

One five-second deadline spans auth, saved-row reads, token preparation/refresh,
the exact GET, body consumption and final revalidation. There is no provider
retry, auth-error retry, organization discovery, list/search or enumeration.
Success bodies are capped at 256 KiB. Late results are discarded; the fetch
wrapper rejects new requests after abort, including late refresh continuations.
An already-started ordinary refresh may have completed before cancellation; only
existing refresh lease/encrypted-token metadata operations are permitted.

The exact external ID, optional returned organization ID, currency, conservative
status vocabulary, safe nonnegative minor amounts and balance/total relationship
are validated. `paidMinor` is null unless Zoho supplies valid `payment_made`;
total minus balance is not treated as payments because of credits/write-offs.
Unsupported status/currency or amounts fail closed.

Connection identity/account/region/domains/revision/credentials and the saved
row/linkage/version/deletion state are checked around remote work. Ownership is
reauthorized afterward. The existing organization-selection operation now uses
revision CAS so an away-and-back account switch invalidates an in-flight read.
Normal token refresh is permitted; concurrent replacement/conflict invalidates
the diagnostic. These are bounded observations, not a lock on later changes.

The existing API entrypoint reserves the fixed diagnostic action or a local
`invoiceId` selector before importing the normal accounting dispatcher. Forged
actions on diagnostic envelopes and query/method selectors fail in the isolated
handler, with no callback or mutating-action fallthrough. The handler validates
the exact envelope before auth/provider work and imports accounting preparation
and adapters directly; it
does not import the assistant, action dispatcher, automation runtime or reminder
runtime. It never calls invoice/customer/payment writes, sync/snapshot/import,
conversation/model, review/queue/reminder/send, OAuth authorization, organization
selection or disconnect. Results are not persisted or logged. No raw provider
body, customer details, credentials or arbitrary error text are returned/logged.
Regular reminder read/gate behavior is unchanged. An executable SQL test proves
this diagnostic result cannot satisfy the existing reminder evidence checker.

No new deployed function, CI/config/gate change, schema migration, provenance
backfill, repair or production SQL is included. The unchanged Hobby-budget test
counts 11 API functions plus one middleware function, within the 12-function cap.

## Offline verification

```sh
node tests/accounting-invoice-diagnostic.test.mjs
node --test tests/tally-routing.test.mjs tests/accounting-routes.test.mjs
node --import tsx --test --test-concurrency=2 tests/accounting.test.mjs tests/accounting-routes.test.mjs tests/accounting-soft-delete-sync.test.mjs tests/accounting-invoice-integrity-sql.test.mjs tests/zoho-network-retry.test.mjs tests/zoho-organization-diagnostics.test.mjs tests/external-reminder-verification-sql.test.mjs tests/zoho-reminder-authority-sql.test.mjs tests/assistant-accounting-actions.test.mjs tests/assistant-accounting-tools.test.mjs tests/zoho-rebind-retention.test.mjs tests/exact-reminder-approval.test.mjs tests/reminder-cron-route.test.mjs tests/test-invoice-reminders.test.mjs tests/zoho-ledger-refresh.test.mjs
npm run typecheck
git diff --check
```

The new suite covers exact reads, soft deletion, forged selectors, owner/workspace
and current-account checks, negative effects, preparation/read races, malformed
payloads, errors, deadlines, redaction, unsupported integrations, token refresh
and rejection by the actual SQL reminder authority gate. SQL tests execute only
in ephemeral local fixture databases. No live provider/dispatch/UI verification
or production-readiness claim is made.
