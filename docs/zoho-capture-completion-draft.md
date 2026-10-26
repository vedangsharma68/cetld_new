# New Zoho export origin capture — independent review packet

Base: main `f019a995c6ef712388f16be5529d0107c7653003` (PR201).
This same unmerged PR now implements capture for a strictly supported fresh
export path. No earlier partial draft was applied; this migration defines the
new coherent cutover. No PR201 admission/journal or old invoice is upgraded.

**Origin capture is not reminder authority. Every PR200 JS/SQL reminder refusal
is unchanged, including preview/proposal/confirmation, claim/payment/final gate
and receipt continuation. PR199's current-account diagnostic is unchanged and
remains provenance_unverified. Imports and reminder restoration are not enabled.**

## Supported capture and deliberately unverified cases

Capture requires an actual new invoice INSERT after installation, an untouched
first server operation, a usable current Zoho epoch, and a one-use receipt issued
only at the adapter's actual successful first invoice POST. The response must
have exact string invoice/customer IDs, matching pinned account (when echoed),
reference, number, dates, currency, total, explicit payment_made, balance and
concrete matching draft/sent/overdue status. Total equals saved total, payment is
explicitly zero and balance equals total; payments are never inferred from a
balance difference. Missing payment_made or any required fact is unverified.

Customer resolution permits either a positively confirmed fresh contact creation
from the saved local name/email/phone, or a unique exact lookup matching a
customer ID already protected by a same-account/region origin binding. Mere
same-name matching, ambiguous contacts, mutable legacy customer external fields
and current-org metadata cannot supply identity. Response contact/customer IDs
must equal the actual invoice POST customer_id. Unique existing unbound provider contacts
remain unverified. Ambiguous lookup or a conflicting protected customer ID is
refused before invoice POST. This intentionally does not promise binding for every new row.

The create response is available and [documented by Zoho](https://www.zoho.com/books/api/v3/invoices/create-an-invoice.md).
The adapter now validates it directly; ID-only return shape is not a blocker.
A private WeakMap in the adapter brands only actual POST result objects; exported
pure validation, JSON clones, metadata, fake adapter results and caller flags
cannot mint that capability. It is consumed once against the operation's exact
local invoice/customer/account/region/external ID before any capture RPC.

Reference/number dedup, recovery/retry, incomplete or nonmatching facts, unknown
status, contact ambiguity, legacy rows and missing epoch never mint origin.
Existing 4097 numbering fallback remains available, but its second POST can
never issue a fresh receipt even if it returns matching facts. Unknown writes
are not retried. Contradictory invoice/customer/account/reference identity fails
before local linkage; unsupported financial facts remain unverified. Existing
legacy unverified exports retain their established path.

Capture is limited to the app's supported two-decimal currencies and canonical
Zoho regional endpoints. Requests reject invalid endpoint/account before sending
credentials, reject redirects, read at most 256 KiB with fatal UTF-8/JSON decoding,
and have a 40s operation deadline plus 15s per request. Fetch and stalled body
reads race abort signals. Capture lookup reads do not retry or paginate/enumerate;
HTTP success requires Zoho code 0. Auth preparation is bounded to 15s. No new
connection, organization choice, permissions or QA reconsent is performed.

## Server protocol and atomic immutable result

A separate new cutover records actual INSERT only. Read/edit/retry/reimport/
dedup/created_at/restore cannot admit an old row. Owner lease changes, direct
linking and PR201 journal insertion permanently exclude the candidate; clearing
those fields does not rearm it. The known PR201 old-worker paths are fenced
before provider writes. A PR201 journal racing an active new operation is
skipped while permanently excluding the new candidate; the old RPC returns no
operation ID and its runtime cannot dispatch. A remote action that performs no database operation is
not observable by SQL; no read or old-worker activity is treated as proof.

Canonical saved-invoice save/retry/reconciler uses this native path; generic
legacy provider actions stay unverified and cannot later upgrade the candidate.

The native server path owns reserve -> token preparation -> start -> provider
work -> completion. It runs before caller lease PATCH and bypasses ordinary
caller/runtime metadata finishers. Reserve records current invoice/customer
hashes and account epoch; start alone spends attempt 1 and issues a private
one-shot nonce to the server. The nonce is never saved in invoice metadata,
sent to Zoho, exposed by probe/recovery, or returned in the application API.
There is no integration-level authorization retry/account reselection.

A fresh internally branded receipt supplies typed canonical facts to the
service-only completion RPC. SQL rechecks owner/workspace/local row, operation,
nonce, two-minute lease, invoice/customer hashes, current connection epoch,
account/region, local money/status/dates/reference and protected customer mapping.
It derives original account/region from the protected operation, not caller JSON.
Only then does one transaction insert the private immutable origin and update
saved external linkage. A post-invoice-write failure rolls both back. The nonce
is cleared after completion. Old JSON evidence or a verified flag cannot grant
origin; wrong nonce/scope/facts/phase fails closed.

The trusted server is the HTTPS observer; SQL does not independently observe
Zoho or cryptographically authenticate provider responses. service_role EXECUTE
is a trusted backend boundary. Owners/members cannot invoke these RPCs, and even
service_role has no direct table read/write privileges. This does not claim to
protect against arbitrary code execution or compromise of the trusted backend.

The binding freezes original owner/workspace/provider/account/region, local and
external customer/invoice IDs, operation and normalized POST facts. No names,
contacts, tokens, raw provider bodies or secrets are stored in it. A row's binding
cannot be updated/deleted, even through ordinary service DML. Invoice UUID reuse,
link/provider/workspace/customer reassignment and accountless financial/sync
updates are rejected. Customer external identity/sync overwrite is also rejected.
Same external invoice ID within a workspace is conservatively unique across
accounts, preventing cross-account collision assignment without changing existing
public indexes. No binding repair/rebind/backfill exists.

**Imports of bound invoices/customers fail closed** until separately pinned,
account-authorized import semantics exist. Unbound imports are unchanged. This
is not a general import fix or a claim of atomic legacy snapshot persistence.
Ordinary notes/operational metadata and owner lifecycle remain subject to existing
policies; they cannot change original identity. Origin tombstones survive deletion.

## Recovery, epoch races and locking

Locks: invoice -> customer -> connection -> epoch -> operation. SQL transactions
end before/after remote work; remote creation and SQL are not distributed atomic.
Switch/away-back/reconsent/reconnect/credential replacement changes epoch and
invalidates pending completion. Same-identity refresh preserves the epoch and
pending operation. A switch after committed capture never rewrites original
identity. A fresh future operation may use protected customer identity only in
that original account/region; legacy/unbound records never gain it via reconnect.

Lost completion acknowledgement uses a bounded SELECT-only recovery of the
already-committed, unchanged operation/link/binding. A capture attempt requires
a captured binding result; it cannot accept an unverified result as capture.
No provider redispatch occurs. Ordinary unverified export acknowledgement can
still recover an explicitly unverified result, without origin authority. Replays
are read-only, exact scope/link/hash checked and idempotent; edits/deletion can
make recovery unavailable rather than trigger repair. A storage outage may leave
an unresolved started operation; it never returns to eligible. Failed/raced
completion can leave a provider object without a local link; no cleanup occurs.

## Exact additive migration and privilege review

`supabase/migrations/20261026141000_zoho_capture_completion_protocol.sql`

- UTF-8 LF: **31,120 bytes**.
- SHA256: **`f5e49bde2944c79567e291354d18330d8397e091ccd6b76109ca1243658b7010`**.
- One BEGIN/COMMIT. Three private RLS tables, eight new functions, five triggers.
  No installation business-row DML/backfill; runtime DML is inside definitions.
- No existing function body/OID/owner/ACL/security mode/search_path changes. Empty
  search_path on new functions; UTC for row hashing. Private trigger helpers are
  owner-only; the three public SQL RPCs grant service_role EXECUTE without grant
  option. Table privileges are revoked from public/anon/authenticated/service_role.
- Exact predecessor source/owner/ACL, app CREATE and connection protection checks
  precede creation. Unexpected default function/table grants abort before commit.
  Unknown source/line-ending drift is never normalized or blindly allowlisted.
- No migration/package/config/API-function/CI-gate/skip change beyond this scoped
  additive migration. Supabase CLI absent; no packages installed or remote SQL.

Additional PR201 hashes, derived exactly in isolated main replay under canonical
`search_path=pg_catalog,public`, including the independently specified successor:

| Predecessor | UTF-8 pg_get_functiondef SHA256 |
|---|---|
| public token-refresh successor | `fb4e3a8f82aabc64dd0ae525938341c9170336582af9c58737d816ae27497110` |
| `app.admit_accounting_invoice_insert()` | `881380398dd689c2096d45e8772edfed4364ce3b0dc6b11e0cfc1a341ecdc015` |
| `app.track_accounting_connection_epoch()` | `546976eeae6c0629f5b27b1cd38eb64a8368bde26234c7cae1ebb9892fd25fc5` |
| public operation context | `8b6e02843dbe8bb44115e382ac02161e39921a70813d83b57bb56e4309785106` |
| public operation reserve | `ddb82ed9446b67650eac92ff12c79e397296facfe43a247888d21b6535c7e28d` |
| public operation transition | `8fa84c5c3e4593f5d47acbea993c3ffe03e0e5642dcc01c61f28700ec276011e` |


The first migration guard contains complete signatures and all unchanged PR200
contained base/approved LF/31-CRLF hashes. Tests reconstruct approved CRLF from
main, apply PR200 then PR201, assert the refresh successor, reject source/ACL/
default-grant drift atomically, and compare every installed predecessor definition
and security attribute unchanged. Existing seeded invoice data is untouched.

## Independent apply-before-code review; no agent rollout

Review the fixed-head source, tests, exact bytes/hash and current CI first. In a
read-only catalog transaction with canonical search_path inspect pg_get_functiondef,
UTF-8 SHA256, owner/prosecdef/proconfig/proacl for every signature in the first
guard; inspect app CREATE and connection table/column ACL/RLS. No business/provider
lookup is needed. Unknown drift requires review, not allowlist expansion.

If independently approved, apply schema before code. Missing schema causes the
server probe to fail before provider dispatch. Old PR201 workers burn new candidates
and stay unverified during mixed rollout. No partial draft or historic table is
upgraded. Code rollback to PR201 retains origin protection and all reminder
refusals; old bound imports remain blocked. Do not drop guards/tombstones or
restore permissive reminder functions as rollback. Destructive schema rollback
requires separate review; none is supplied or performed here.

## Executable verification

Only isolated SQL, fake adapters and fake HTTP/Graph sentinels run. No actual
provider, customer data/AI, QA, sends, merge, deployment or remote SQL is used.

- Receipt suite: 4 tests; actual POST capability, one-use/clones/forgery, identity/
  financial/status/date/reference mismatches, ambiguous/unbound/protected contacts,
  dedup/4097/unknown transport, redirect/body/UTF-8/JSON/timeout/endpoint bounds.
- Real SQL/integration suite: 6 tests; fresh cutover/old workers, grants/scope,
  epoch/refresh/reconnect, version/lease/customer/delete races, atomic binding+link
  rollback, immutable identities, cross-account same-ID collision, lost ack with
  one POST, replay, no snapshot/queue/conversation/send effects and unchanged
  reminder refusal after genuine captured bindings exist.
- Existing accounting/diagnostic/export/test-invoice/reminder/routing regressions:
  17-file focused batch passed, 0 failed/skipped. A missing caller version projection
  was fixed by authoritative server version read plus the original exact observed
  updated_at comparison; no assertion was removed.

```sh
node --import tsx --test --test-concurrency=2 tests/zoho-fresh-create-receipt.test.mjs tests/zoho-capture-completion.test.mjs tests/zoho-prospective*.test.mjs tests/manual-invoice-sync.test.mjs tests/invoice-sync-coverage.test.mjs tests/invoice-sync-native-sql.test.mjs tests/accounting-invoice-diagnostic.test.mjs tests/accounting.test.mjs tests/accounting-routes.test.mjs tests/external-reminder-containment*.test.mjs tests/external-reminder-verification-sql.test.mjs tests/test-invoice-export.test.mjs tests/tally-routing.test.mjs tests/zoho-auto-number-export.test.mjs tests/zoho-export-diagnostics.test.mjs
npm run typecheck
git diff --check
```

Typecheck/diffcheck passed. Final receipt/SQL focused proof passed both files with 0 failed/skipped. Exact
updated-head existing CI
are recorded in the PR; no duplicate full local run. vercel.json and Hobby budget
are unchanged. This proves offline behavior, not production readiness or live
provider/dispatch acceptance. Imports and reminder restoration remain separate.
