# Allowlisted draft-invoice cleanup in the current Zoho account

`POST /api/accounting` with `action: "invoice-cleanup"` is an owner-only,
remote cleanup for exactly two synthetic QA draft invoices. It shares the
existing accounting function and the PR #199 diagnostic's exact saved-row read,
auth, connection checks, token preparation and bounded provider read.
Every operational result says `provenance: "provenance_unverified"`: the current
connection is not proof of the original export destination or linkage ownership.

## Invocation and fixed allowlist

Use an existing authenticated workspace-owner bearer session. The JSON envelope
must contain exactly these three fields. Query parameters are rejected:

```http
POST /api/accounting
Authorization: Bearer <existing-owner-session>
Content-Type: application/json

{"action":"invoice-cleanup","workspaceId":"<workspace-uuid>","invoiceId":"27e4bc93-fa0c-42ff-8813-bc371a623fb0"}
```

| Saved local invoice UUID | Exact Zoho invoice ID |
| --- | --- |
| `27e4bc93-fa0c-42ff-8813-bc371a623fb0` | `4264719000000068001` |
| `5076cb85-c892-44d6-aea9-9b7af8e95d38` | `4264719000000044008` |

The caller cannot select a provider, external ID, organization, account or user.
Auth resolves the user and workspace ownership. `getDiagnosticInvoice` reads
only the exact saved row in that workspace, including soft-deleted rows without
restoring them. The requested local ID and saved external ID must match one
allowlisted pair exactly, the provider must be `zoho_books`, and any stored
linkage markers must agree. Mismatches fail before connection/token/provider
work. The current owner/workspace connection supplies the organization.

## Preconditions and remote operations

The connection must be connected, owner/workspace/provider scoped, with a
numeric organization ID and matching allowlisted Zoho region/API/accounts
domains. Token identity and connection revision/credentials are checked using
the existing integration and `sameAccountingConnection` expectations.

**Zero local database writes includes refresh lease/token metadata.** Ordinary
diagnostic token refresh needs those writes, so cleanup fails closed with
`unverifiable` / `token_refresh_required` if credentials need refreshing. It
never claims a lease, refreshes or saves tokens. Use the ordinary connection
lifecycle separately to refresh credentials before trying cleanup again.
This restriction takes precedence over reusing the diagnostic's write-capable
refresh operation; its behavior is unchanged.

One exact `fetchInvoiceBalance` read uses diagnostic mode, without retries.
The provider response must have the correct exact invoice ID, correct optional
organization ID, supported currency/status, and safe nonnegative amounts.
All of these must hold before DELETE:

- `status === "draft"`;
- `balanceMinor === totalMinor`;
- `paidMinor` is null or zero.

A valid non-draft is `skipped` / `not_draft`. A draft with reduced balance or
payments is `skipped` / `paid_or_partially_paid`. Unsafe/malformed data is
`unverifiable`. A pre-read HTTP 404 is `already_absent`, with no DELETE.
Other errors, including 403 or HTTP 200 with a provider error code, do not
establish absence or permit deletion.

After passing preconditions and scope revalidation, cleanup issues exactly one
`DELETE /books/v3/invoices/<encoded-exact-id>?organization_id=<current-account>`.
Only a parsed JSON body with numeric `code === 0` confirms deletion. A failed or
unconfirmed DELETE is `unverifiable` / `provider_delete_unverifiable`, without
retry. Each DELETE attempt is followed by one exact read, while scope and the
deadline still permit it. HTTP 404 produces
`verification: "absent_confirmed"`; every other read result produces
`verification: "absence_unverifiable"`. A second successful invocation after
deletion reports `already_absent` and makes no additional DELETE.

Connection identity/account/region/domains/revision/credentials and the saved
row/linkage/version/deletion state are rechecked around remote work. Ownership
is reauthorized before deletion and after each remote operation. Changes yield
`connection_changed` or `local_record_changed`; revoked ownership yields 403.
These checks are observations, not transactional locks across Zoho and cetld.
If a race or timeout occurs after DELETE starts, the remote action may have
completed; no automatic retry occurs.

## Outcomes and sanitized response

Operational outcomes use HTTP 200 with `outcome` equal to `deleted`,
`already_absent`, `skipped` or `unverifiable`:

```json
{
  "workspaceId": "10000000-0000-0000-0000-000000000001",
  "invoiceId": "27e4bc93-fa0c-42ff-8813-bc371a623fb0",
  "provenance": "provenance_unverified",
  "checkedAt": "2026-11-15T08:00:00.000Z",
  "outcome": "deleted",
  "provider": "zoho_books",
  "currentAccountId": "987654321",
  "exactId": "4264719000000068001",
  "verification": "absent_confirmed"
}
```

`skipped` and `unverifiable` include a stable reason. Other reasons include
`invoice_not_allowlisted`, `linkage_invalid`, `not_connected`,
`connection_invalid`, `provider_authentication_failed`, `provider_access_denied`,
`provider_throttled`, `provider_read_unverifiable`, `cleanup_unavailable`, and
`timeout`. Early or invalidated outcomes omit provider/current-account facts.
Local request failures use the diagnostic's 400/401/403/404/405 mapping, with
413 for oversized JSON. Responses are `no-store` with `no-referrer` policy.

## Bounds and explicit non-effects

One eight-second deadline spans auth, local reads, token preparation, exact
pre-read, DELETE, post-read, body consumption and revalidation. The abort-safe
fetch wrapper prevents late continuations from starting further requests.
There are no retries, organization discovery, list/search/enumeration, or
caller-selected remote targets. Request JSON uses the existing 32 KiB limit;
provider success bodies, including DELETE acknowledgments, are capped at
256 KiB. Provider error bodies are not read.

There are **no local database writes of any kind**. Both saved rows stay exactly
as they are: the soft-deleted row stays deleted and the active row stays active.
There are no customer/payment writes, snapshots, imports, syncs, conversations,
model calls, reviews, queues, reminders, sends, OAuth authorization,
organization selection or disconnect operations. Results are neither persisted
nor logged; raw provider bodies, customer details, credentials and arbitrary
error text are never returned or logged. This result grants no reminder, send
or queue authority.

The cleanup classifier reserves the fixed action or local `invoiceId` selector
in body or query before the normal accounting dispatcher is imported. Forged
and identifiable malformed cleanup selectors cannot fall through. Ordinary
bodyless OAuth callbacks retain their existing route. The explicit diagnostic
action retains its existing handler and behavior. Cleanup imports accounting
preparation/adapters directly, never the assistant, action dispatcher,
automation runtime or reminder runtime.

No new API function, schema migration, production SQL, dependency, env/config,
CI/gate or reminder-path change is included. The unchanged Hobby-budget test
continues to count 11 API functions plus one middleware function.

## Offline verification

```sh
node tests/accounting-invoice-cleanup.test.mjs
node tests/accounting-invoice-diagnostic.test.mjs
node --import tsx --test --test-concurrency=2 tests/accounting*.test.mjs tests/zoho-*.test.mjs tests/tally-routing.test.mjs tests/assistant-accounting-*.test.mjs tests/external-reminder-verification-sql.test.mjs
npm run typecheck
git diff --check
```

Tests use mocked provider transports and ephemeral local SQL fixtures. No live
provider deletion, deployment or production-readiness claim is made.
