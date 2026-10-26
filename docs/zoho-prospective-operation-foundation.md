# Zoho prospective admission and operation foundation — review packet

Base: main `8fd37aeb547ba3bd92e0a5343972fd5f92c9eadb` (PR200).

**This stage creates no verified original-account binding and enables no linked
reminders.** It records prospective row admission, transient connection epochs
and unverified export attempts. PR200's JS preflights, SQL predicates, queue,
approval, payment, final-dispatch and receipt-continuation refusals are unchanged.
PR199's isolated current-account diagnostic is unchanged. No flag, JSON field,
journal outcome or diagnostic response supplies authority.

## Implemented boundary

- An AFTER INSERT trigger registers the actual new invoice UUID, workspace and
  authoritative workspace owner in a private admission table. Caller timestamps,
  lease metadata and asserted binding fields are irrelevant. Existing rows get
  no admission on read, edit, retry, restore, reimport or deduplication. Linked
  inserts and test invoices are not local export candidates. Deleted/moved or
  reused prospective UUIDs retire their admission permanently; restoration does
  not create a new one. No existing row is backfilled.
- A private ledger records server-generated Zoho epoch UUIDs and monotonically
  advancing per-scope generations. Actual connection insert, selection/revision
  change (including same-account selection and away/back), regional/account
  change, credential replacement/reconsent and disconnect/reconnect rotate it.
  Tombstones survive deletion, so reconnect revision 1 cannot recover an old
  epoch. Status/lease/sync bookkeeping alone does not rotate it.
- Ordinary token refresh through the existing service-only RPC uses a private
  transaction/revision permit. It preserves an existing epoch only when account
  and regional identity stay unchanged. A refresh that changes that identity
  rotates the epoch. The permit cannot be supplied as metadata/GUC/JSON or
  written by service_role directly; it is removed in the same transaction.
  An existing preinstallation connection has **no epoch**: ordinary refresh and
  status/read work do not enroll it. Intentional selection/reconsent/reconnect
  can create a future operation epoch, never invoice origin provenance.
- Three service-only RPCs read current operation context, reserve and transition
  a Zoho export journal. They derive current account/region from the connection;
  the reserve takes an expected epoch/version, not an original-account assertion.
  Owner/workspace/invoice scope, prospective candidate admission, invoice version,
  updated_at, canonical UTC full-row fingerprint and exact epoch are checked.
  No server journal authority derives from owner-editable sync lease fields.
- The actual server integration uses this boundary for the first eligible
  journaled attempt. It rechecks prepared invoice facts/lease and current epoch,
  reserves, starts once, invokes the existing adapter with pinned prepared
  account/credentials, then finishes as `created_unverified`,
  `duplicate_unverified` or `unknown_unverified`. There is no integration-level
  authorization retry that selects another connection inside that operation.
  Existing adapter duplicate recovery/numbering behavior is retained.
  Account/lease/linkage/version/deletion changes invalidate completion and stop
  the existing finish-link path for that response.
- Reserve/start/finish are separate transactions. The operation has a server
  two-minute deadline; a repeated start cannot dispatch again through that
  operation. Identical valid terminal finish can return `replay_unverified`,
  never authorization. Missing/unknown/malformed transitions fail closed.

The journal stores attempted account/region, scoped UUIDs, version, timestamps,
row hash and unverified outcome. It stores no invoice/customer/provider body,
customer identity/contact, tokens or secrets. Its RPC responses do not expose
provider bodies or new origin claims. Existing export output remains unchanged.

## Explicit limitations and deferred work

**Admission is not verified creation/export history.** Old workers can still
export without this new journal; older/legacy rows, missing-epoch connections,
already-linked rows and later retries/recovery retain their existing unverified
behavior. A second reserve returns only `retry_unverified`; the existing export
recovery path can continue outside this first-attempt journal. It cannot acquire
a fresh operation or mint binding from that classification. A direct service
PATCH, current import writer or recovered duplicate never creates origin proof.

Even `created_unverified` means only that this adapter invocation reported a new
creation. It does not attest original customer/account identity, exclude earlier
unobserved operations, or prove an atomic invoice-linkage write. All rows in this
stage remain ineligible for linked reminders. There is no binding table, capture
RPC, verified state or reminder consumer of the journal.

Original provider-account identity and operation epoch are different: the first
must be immutable evidence of actual origin; this epoch is transient authority
for one observed connection incarnation. An old operation cannot resume after
reconnect/reconsent or away/back, even when the account string is the same.
Normal same-identity refresh can continue that operation within its deadline.

Future capture must establish a new protected capture-admission cutover and
durable first-attempt protocol; **it must not upgrade these stage admissions,
old journals, editable lease history or old-worker activity into proof**. It must
atomically capture verified original account/region/customer and invoice linkage
under the expected lease/version. Unknown/duplicate/retried exports remain
unverified. Imports require separately pinned collection and atomic account-safe
persistence. Import races/indexes are deliberately unchanged here. Reminder
restoration still requires independently reviewed bounded original-account reads,
protected fresh evidence and every JS/SQL gate together. QuickBooks/Tally gain
no journal/capture capability; shared-phone consent is not addressed.

SQL locks are ordered invoice -> connection -> epoch -> operation. Connection
mutations/refresh lock connection before epoch and do not acquire invoice locks.
Locks last only for their individual database transaction. A connection can
change while provider work is in flight: that response is invalidated, but the
provider may already have created an object. This stage does not make remote
creation and SQL a distributed atomic transaction and performs no repair.

## Exact migration artifact and security review

`supabase/migrations/20261026110000_zoho_prospective_operation_foundation.sql`

- UTF-8, LF: **21,330 bytes**.
- SHA256: **`30760efbf9f2f99d771c70155d67bd11f902436c4e7dbe7f799d2c803ddd2da3`**.
- Atomic BEGIN/COMMIT, transaction-local `search_path=pg_catalog,public`.
- Four private tables, two triggers, six new functions. All tables enable RLS
  with no caller policies and no public/anon/authenticated/service_role table
  privileges. No new schema, package, API function, config or deployment gate.
- Trigger/helper functions have empty search_path and owner-only EXECUTE.
  The three public RPCs grant only service_role EXECUTE without grant option.
  They validate authoritative workspace ownership and row scope themselves.
  New reserve/transition functions fix timezone to UTC for row hashing.
- Exactly one existing function body changes: the token-refresh RPC delegates to
  the private transactional helper. Its OID, signature, owner, SQL language,
  security-definer mode, search_path, ACL and all other pg_proc attributes are
  checked unchanged. Existing reminder functions are byte-for-byte unchanged,
  including approved 31-CRLF variants.
- All predecessor hashes, owners (`postgres`), private/public EXECUTE boundaries,
  connection table protection and private-schema CREATE privileges are checked
  before object creation. Unknown source/line-ending/owner/ACL drift aborts;
  unknown definitions are never normalized or patched speculatively. Unexpected
  default grants on new functions/tables are independently rejected before commit.
- No business-row DML, admission/epoch backfill, cleanup, repair or binding edits
  execute during migration. DML inside function definitions runs only during
  subsequent authorized operations. Isolated tests compare seeded business rows
  before/after installation and verify they are identical.

Accepted exact UTF-8 pg_get_functiondef SHA256 values, derived from isolated
main replay under the canonical catalog search path (not live attestation):

| Installed function | Accepted SHA256 |
|---|---|
| `app.invoice_has_external_ledger(invoices)` | `80321aeca14fc9c5f333f74ab938ff238a99869b7645edabb91235a4e6dfecde` |
| `app.reminder_external_read_matches(invoices,uuid)` | `cbe9a66a4d8fb965f211cae88723eb9fdaa89030185bc4776bc340f4f753058e` |
| `app.reminder_local_status_payable(invoices)` | `cf7a45a506f61501b5c6f229e297a9d46585a0fd193c54278057206c66df67da` |
| `cetld_core_claim_due_followups` contained base | `c6a34979b74fd37d80aa5f133bd2bd33157deda76a1fe374743d7351e070c6a3` |
| Same, contained approved LF | `515a146cfc808f3bcfc8290a9fa883d9d5d725649c696b656e34964cd868b687` |
| Same, contained approved CRLF | `7682bf8e74ce798442b3054f4672e888c952dce4fce70c31a80554606e1ab6ef` |
| `cetld_core_authorize_delivery` contained base | `f8c636e89460d6107b0f009c893c1e02a2a5d155f10c9f6ee66ba405d01e5876` |
| Same, contained approved LF | `3f73ac01580326a2106f9529c8794f59607a205e7a8d86e96febe51095eabcb4` |
| Same, contained approved CRLF | `a642cdbd4d09e1aab02e2f02f21e3faf9948e40415520f187a87fb8bb121a8df` |
| Existing `cetld_update_accounting_connection_tokens` | `da4b98688566ce8526e0362eaae7bcfe29b2381b81f5bb7197608f5f4e7d1150` |

The CRLF test reconstructs the exact approved predecessors from main, reproduces
PR200's accepted raw CRLF hashes, applies PR200 locally, then verifies this stage
accepts the exact contained hashes above without changing those functions.
Unknown content, mixed endings, owner and ACL changes are rejected atomically.

Supabase CLI is absent; no packages were installed. The migration follows the
repository filename convention. No remote SQL has been applied by this agent.

## Independent rollout and read-only checks

1. Review exact bytes/hash and PR200's installed contained sources. In a read-only
   transaction, set `search_path=pg_catalog,public`; inspect pg_get_functiondef,
   UTF-8 SHA256, proowner/prosecdef/proconfig/proacl for the six signatures listed
   in the migration's first guard. Inspect connection table RLS/table and column
   ACLs and the app schema CREATE ACL. Abort review on drift; do not expand the
   allowlist just to apply the migration.
2. Independently approve/apply this schema migration **before** deploying code.
   Existing connections/invoices remain unenrolled. Old workers keep their
   unverified behavior and PR200 refusals; there is no capture window or reminder
   reopening during mixed-version rollout. Code ahead of schema fails storage
   preparation before provider dispatch rather than silently inventing a journal.
3. After independent application, read catalog RLS/ACL/trigger/function state and
   confirm private tables received no migration backfill. No provider or customer
   data lookup is needed for this catalog review. Do not run export/sync merely
   to initialize a connection epoch.
4. Code rollback to PR200 leaves protected bookkeeping in place and reminders
   blocked. Do not drop tombstones/journals, restore permissive reminder bodies,
   or recycle these records into future origin proof. Any schema rollback needs
   separate review; no destructive rollback SQL is supplied.

## Offline evidence and commands

Earlier sanitized witnesses on main (no network transport):

- `automation/accounting/integration.mjs`, `sync`/`fetchAll`: page one under
  fixture account A, setOrganization(B), page two under B; observed
  `[{page:1,accountId:'fixture-A'},{page:2,accountId:'fixture-B'}]`, persisted
  together with `syncStatus:'synced'`. Imports remain deferred, not fixed here.
- `automation/invoice-sync-store.mjs`, `finishInvoiceSync`: compares invoice
  metadata lease fields. An authenticated owner UPDATE merging
  `bookkeeping_sync_attempts:0` and a new attempted_at succeeded under real SQL
  RLS/triggers. `automation/runtime.mjs` has a service-role finish hook, but that
  same lease/CAS alone is not origin authority. The new journal does not trust it
  as an admission record.
- `automation/accounting/store.mjs`, `updateConnection`/`insertConnection`:
  forced refresh revision `1 -> 2`; disconnect/reinsert revision `1`. New SQL
  tests now prove the separate epoch survives normal refresh and never resets
  into the old identity on reconnect.

Focused command (13 files, all passed, 0 failures/skips):

```sh
node --import tsx --test --test-concurrency=2 tests/zoho-prospective*.test.mjs tests/accounting.test.mjs tests/invoice-sync-coverage.test.mjs tests/invoice-sync-native-sql.test.mjs tests/accounting-invoice-diagnostic.test.mjs tests/accounting-routes.test.mjs tests/tally-routing.test.mjs tests/external-reminder-containment*.test.mjs tests/external-reminder-verification-sql.test.mjs tests/zoho-rebind-retention.test.mjs tests/zoho-network-retry.test.mjs
```

The new direct SQL file contains four tests; export boundary/integration file
contains two. SQL cases cover no-backfill, forged grants/fields, wrong scope,
old rows/workers, token refresh, account changes, away/back, reconnect, lost lease,
linkage/deletion changes, timeout and replay without authority. Export tests use
fake adapter callbacks and an isolated PostgREST-shaped SQL fixture; all transport
URLs must remain `https://fixture.supabase.test`. They assert no snapshots, claims,
proposals or messages are created by the integration exercise.

`node tests/manual-invoice-sync.test.mjs` passed 6 tests;
`node tests/test-invoice-export.test.mjs` passed 9 tests. The manual fixture now
explicitly accepts only the new service-scoped context RPC returning a legitimate
missing epoch; all prior authorization/export assertions remain.

`node tests/zoho-prospective-foundation-sql.test.mjs` passed 4 tests after the
final migration changes. A final focused runner containing accounting, diagnostic,
manual export and the new export-boundary file passed all 4 files, no skips.

`npm run typecheck` and `git diff --check` passed. Exact-head full GitHub Actions
results are recorded in the PR after completion; no live/provider/dispatch
acceptance or production-readiness claim follows from these tests.
