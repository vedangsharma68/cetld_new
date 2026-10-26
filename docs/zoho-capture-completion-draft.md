# INCOMPLETE CAPTURE — draft only, no rollout recommendation

Base: main `f019a995c6ef712388f16be5529d0107c7653003` (PR201).

**Original-account capture is NOT implemented. Do not merge/deploy/apply this
partial stage as a substitute for coherent capture.** All linked reminders remain
PR200-blocked; imports and the PR199 diagnostic are unchanged. There is no origin
binding table, verified state, capture-enabling flag or JSON grant in this patch.

## Exact useful dependency closed

The production export previously ended its server journal before the separate
runtime metadata/link PATCH. The new server path owns a one-shot operation from
before the first caller lease PATCH through atomic **unverified** linkage and
durable result completion. It bypasses both caller and runtime metadata finishers.
A committed completion whose HTTP acknowledgement is lost can be recovered by a
SELECT-only operation RPC, without redispatching a provider call.

A distinct prospective cutover records actual new invoice INSERTs only. It does
not copy PR201 admissions/journals or admit old rows by read/retry/edit/import,
timestamp, restored record or invoice-number deduplication. Old lease changes,
direct linkage and PR201 journal insertion permanently exclude the new candidate;
clearing metadata/linkage cannot rearm it. Normal edits before reservation may
remain eligible; changes after reservation invalidate that operation. An excluded
or completed operation can never become a fresh capture candidate.

The server reserves the invoice/customer snapshot and epoch before token work,
records attempt 1 only at start, and starts before any adapter search/contact or
invoice write. It pins prepared account/credentials without an integration-level
retry. Missing epoch and prior-stage rows retain unverified legacy export without
activating/selecting/reconsenting a connection. A changed known epoch does not
fall through to another export in the same call. No actual provider ran here.

The source guarantee is limited to observed supported write paths. The database
cannot detect a remote write that performs no database operation. This limitation
must not be hidden by declaring the new candidate or journal to be origin proof.

## Actual remaining capture work — not a provider-documentation blocker

The raw response is already available at `providers.mjs`'s invoice POST.
[Zoho's create-invoice response contract](https://www.zoho.com/books/api/v3/invoices/create-an-invoice.md)
exposes the necessary customer, currency, total, balance, status, dates and
reference fields. The current ID-only return shape is **not** a technical reason
that validation cannot be added in this same PR. No external impossibility has
been established; the blocker is unfinished implementation/security-test work:

1. Add a separately branded fresh-POST receipt at the adapter's actual POST
   boundary, with strict complete-field normalization, bounded body/deadline,
   redirects rejected, pinned endpoint/account/region and exact invoice/customer
   identity/facts/reference validation. Do not brand list/reference/number reuse,
   recovery, retry, incomplete, malformed or conflicting responses. Preserve 4097
   legacy behavior while refusing origin on any response whose freshness is not
   proven. Audit contact resolution against saved local customer identity; a
   same-name lookup alone is not that proof. No synthetic receipt from an ID.
2. Carry that receipt only through the trusted server operation; owner metadata,
   stage admissions, stage journals and caller/RLS finish payloads cannot supply
   it. Establish the real capture cutover and old-writer coverage before enabling
   authority. These partial-stage records must not be upgraded/backfilled.
3. Extend atomic completion to insert a protected immutable binding and external
   linkage in the same transaction under the expected invoice/customer snapshot,
   lease and epoch. Add immutable linkage/account/customer guards for all later
   service/import writes and same-ID/account collisions. Add recovery/replay
   rules that recover only the already-committed binding, never redispatch.
4. Add the missing offline adapter receipt mismatch/body/timeout matrix and real
   SQL binding/forgery/collision/immutability tests, then rerun focused checks and
   exact-head CI. Those capabilities/tests are not claimed by this draft.

This is a bounded remaining path to export capture, not a request to implement
imports or reopen reminder authority. Keeping the draft unmerged is preferable
to treating another foundation rollout as automatically warranted. The author
has not established that the remaining work cannot fit this PR safely; capture
is simply incomplete at this head. CI passing does not resolve that gap.

## Current protocol and safety boundary

Two private tables hold the new cutover/operation and transaction-local write
permit. Both enable RLS, have no caller policies and revoke all table privileges
from public/anon/authenticated/service_role. Server-generated birth/operation IDs
cannot be supplied by invoice metadata. Trigger/helper functions are owner-only;
the three public SQL RPCs grant service_role EXECUTE only, without grant option:

- `cetld_probe_zoho_capture_completion`: bounded SELECT-only candidate lookup;
  derives owner from actual saved workspace/invoice, admits nothing.
- `cetld_zoho_capture_completion_protocol`: fixed reserve/start/complete/abort
  actions. Completion permits only `created_unverified`/`duplicate_unverified`;
  no verified outcome exists. Unknown/aborted operations never rearm.
- `cetld_recover_zoho_capture_completion`: SELECT-only recovery of an unchanged
  committed unverified result. Wrong scope/op/link/hash returns no result.

All protocol results explicitly contain `originCaptured:false`. Neither those
results nor the tables are consumed by any reminder gate. Local-only reminder
behavior and every existing linked refusal remain in place.

Locks: invoice -> customer -> connection -> epoch -> protocol row. Each RPC is
its own transaction; reservation expires after two server minutes. Provider work
is outside SQL locks. A provider write may succeed while a switch/edit invalidates
completion; that is not repaired. There is no distributed atomicity claim. If
storage is unavailable after dispatch, the durable started operation can remain
unresolved; it is not eligible for a new operation and is never origin proof.

A valid unverified completion updates linkage and result in one transaction; an
error after invoice UPDATE rolls both back. Terminal replay/recovery checks exact
unchanged saved linkage/hash; it does not assert today's account as original
origin. Later ordinary/import edits can invalidate recovery but cannot turn the
record into a binding. Immutable binding enforcement is still absent/deferred.

## Exact additive migration review packet

`supabase/migrations/20261026141000_zoho_capture_completion_protocol.sql`

- UTF-8 LF: **20,535 bytes**.
- SHA256: **`2fd3d4daf94d8868cc794be100064222fa04c9d6d737456bfe8d042f6016bad1`**.
- One BEGIN/COMMIT; no installation business-row DML/backfill. Runtime DML is
  inside function definitions. Two tables, two triggers, five new functions;
  **no existing function body, owner, OID, ACL, mode or search_path changes**.
- Functions use empty search_path; row hashing functions fix timezone to UTC.
  Source/owner/ACL/connection protection/schema CREATE guards run before creation;
  unexpected default grants on the new objects abort before commit.
- Exact PR200 contained base/approved LF/approved 31-CRLF predecessors are accepted
  as in PR201; definitions are not normalized or rewritten. Unknown source/ending,
  ownership, ACL or default-grant drift aborts atomically. No guessed aliases.
- Supabase CLI is absent. No packages were installed and no remote SQL applied.

Additional PR201 source hashes were derived from isolated main replay under
`search_path=pg_catalog,public` and checked by the executable tests:

| Predecessor | UTF-8 pg_get_functiondef SHA256 |
|---|---|
| public token-refresh successor | `fb4e3a8f82aabc64dd0ae525938341c9170336582af9c58737d816ae27497110` |
| `app.admit_accounting_invoice_insert()` | `881380398dd689c2096d45e8772edfed4364ce3b0dc6b11e0cfc1a341ecdc015` |
| `app.track_accounting_connection_epoch()` | `546976eeae6c0629f5b27b1cd38eb64a8368bde26234c7cae1ebb9892fd25fc5` |
| public operation context | `8b6e02843dbe8bb44115e382ac02161e39921a70813d83b57bb56e4309785106` |
| public operation reserve | `ddb82ed9446b67650eac92ff12c79e397296facfe43a247888d21b6535c7e28d` |
| public operation transition | `8fa84c5c3e4593f5d47acbea993c3ffe03e0e5642dcc01c61f28700ec276011e` |

The migration's first guard contains the complete signatures and all PR200 hash
variants. Tests reconstruct the approved CRLF bodies, apply PR200 then PR201,
assert the exact refresh successor, and compare every preexisting pg_proc row
before/after this migration. Seeded existing invoice data stays unchanged.

**Review only, not an apply request.** For independent catalog review, use a
read-only transaction, canonical search_path, pg_get_functiondef/UTF-8 SHA256,
proowner/prosecdef/proconfig/proacl for each signature in the first guard; inspect
app schema CREATE and connection table/column ACL/RLS. No provider/business-row
lookup is needed. Verify the exact artifact bytes/hash above before any future
decision. No installation or rollout is recommended at this incomplete head.

If coherent capture is subsequently approved, independently apply its reviewed
schema before code. Code ahead of schema fails the protocol RPC before provider
dispatch. PR201 old workers burn new candidates through metadata/journal/link
events and remain unverified. Code rollback to PR201 does not enable any reminder
or origin grant. Do not delete tombstones or restore permissive reminder functions
as rollback; any schema rollback requires separate review.

## Executable checks and limitations

All databases, providers, recipients and HTTP callbacks are isolated fixtures.
The current four new tests prove new-vs-PR201 cutover, irreversible old-worker
fences, grants/scope/version/epoch/lease/customer invalidation, normal refresh,
away/back/reconnect/expiry, atomic rollback, terminal replay and lost-ack recovery
with a single fake provider invocation. They assert no snapshots, claims,
messages/proposals or reminder authority. They **do not** prove fresh-receipt or
immutable-binding correctness; those are absent.

Commands/results:

```sh
node --import tsx --test --test-concurrency=2 tests/zoho-capture-completion.test.mjs tests/zoho-prospective*.test.mjs tests/manual-invoice-sync.test.mjs tests/invoice-sync-coverage.test.mjs tests/invoice-sync-native-sql.test.mjs tests/accounting-invoice-diagnostic.test.mjs tests/accounting.test.mjs tests/accounting-routes.test.mjs tests/external-reminder-containment*.test.mjs tests/external-reminder-verification-sql.test.mjs tests/test-invoice-export.test.mjs tests/tally-routing.test.mjs
```

Initial batch: 13/14 files passed; native manual API exposed a missing caller
automation_version projection. Fixed by reading the version server-side while
retaining the exact caller-observed updated_at SQL comparison. The native SQL
file then passed (1 test). No assertion was removed to resolve it.

`node tests/zoho-capture-completion.test.mjs`: 4 passed; `npm run typecheck` and
`git diff --check`: passed. Final focused rerun of the new protocol, native SQL API, manual API and PR201
upgrade-path files passed all 4 files (0 failed/skipped). Exact-head existing CI
results are recorded in the PR. No duplicate full local release run or CI rerun is needed.
No new API function, package, CI gate, skip, configuration or spend. vercel.json
and the Hobby function budget remain unchanged. No merge/deploy/remote SQL or
actual provider/AI/send activity was performed; no live acceptance is claimed.
