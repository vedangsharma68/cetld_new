# Original-bound Zoho read prerequisite — reminder restoration remains blocked

This PR closes the protected original-account exact-read prerequisite. It does
**not** complete selective reminder authorization or establish production
readiness. All PR200 refusal functions, JS reminder consumers and old evidence
wrappers are unchanged. The only result is read-only inspection with
`reminderAuthority:false`. No output from this method is accepted by any gate.

## Why this is the safe scoped cut

Source witnesses from current main (PR202 installed):

- `automation/whatsapp/owner-reminders.mjs:77-106` routes prepare/confirm through
  `reminderPaymentRpc`. `app.owner_assistant_reminder` (shared-owner migration
  20261023061702, lines 142-210) validates consent/review/payment then schedules
  approval; it does not create an origin-bound claim.
- `automation/engine.mjs:71` calls `claimDueFollowups`; `automation/core-store.mjs:49`
  invokes `cetld_core_claim_due_followups`. PR200 explicitly excludes external
  invoices at candidate selection AND claim recheck. A manual send-now approval
  feeds that shared queue; enabling just approval does not produce a safe send.
- `automation/whatsapp/approved-reminders.mjs:99` requires a claim and final
  `cetld_core_authorize_first_party_reminder`. Receipts and generic delivery have
  separate final gates. The older `_with_external_read` wrappers use a
  caller-set GUC; PR200's predicate always returns false. Reopening those wrappers
  would not establish durable original binding or connection-race authority.

The unresolved source condition is the absence of an origin/epoch-scoped exact
claim-to-final protocol across this shared scheduler and receipt path. This PR
therefore grants nothing at preview, approval, payment check, queue, claim,
first-party/generic final authorization or receipt continuation. Local-only
reminders, diagnostic, imports and existing owner payment/date/lifecycle policies
are unchanged. This is implemented useful read infrastructure, not a claim that
the requested overall reminder restoration is finished.

## Implemented boundary and contract

Server library method:

```js
await accounting.inspectOriginalInvoice({userId, workspaceId, invoiceId});
```

`userId` comes from existing trusted server authentication, never a new HTTP or
model parameter. There is no new API/action/model registration. Extra fields,
including provider/account/org/external-ID overrides, are rejected. The service
SQL preflight resolves actual workspace owner, invoice, captured operation,
immutable invoice/customer origin, live account/region/epoch and saved facts.
Unbound/legacy/PR201/imported/unsupported/wrong-scope/disconnected/mismatched rows
fail before token preparation. Metadata cannot create origin. Reconnect to the
same original account permits a new inspection of an existing genuine binding;
it never upgrades legacy rows. Its new epoch invalidates all in-flight reads.

Exactly one invoice GET is pinned to the original Zoho regional endpoint and
account; no lists/searches/retries/org discovery. One **5,000 ms** end-to-end
referenced deadline includes SQL preflight, existing token preparation/refresh,
GET/body and final SQL context recheck. Refresh token response and SQL context
JSON are bounded at 16 KiB; invoice body at 256 KiB, with redirect and fatal UTF-8
checks. Ordinary token refresh preserves epoch; expected connection plus epoch
rechecks detect switch, away/back, reconnect and credential replacement. An
already-started store/refresh request may settle after the deadline; abort checks
prevent a subsequent provider invoice GET or acceptance. No late result grants
anything, and no general retry is enabled.

Remote identity/customer/currency/total/paid/balance/status/date/due/reference must
match protected origin AND current saved row. Only unchanged zero-paid sent or
overdue supported states are inspected successfully. Credits/write-off must be
explicitly zero. Missing `credits_applied` or `write_off_amount` is **unverifiable**;
their availability in real GET responses has not been verified here. This strict
contract is not weakened by provider assumptions. Owner date corrections make
inspection unavailable; original dates are never changed. Partial payments or
other financial divergence do not update local money or manufacture receipts.
401/403/404/throttle/network/timeout/malformed responses are unavailable, never
confirmed absence. All errors are generic and exclude upstream bodies/secrets.

Example sanitized result (offline identifiers):

```json
{"provider":"zoho_books","workspaceId":"<workspace UUID>","invoiceId":"<local UUID>","originalAccountId":"90001","region":"in","externalInvoiceId":"99001","externalCustomerId":"88001","currency":"USD","total":"5.00","paid":"0.00","balance":"5.00","status":"sent","date":"2026-10-01","dueDate":"2026-10-20","checkedAt":"<UTC timestamp>","existence":"verified","reminderAuthority":false}
```

Numeric strings may follow PostgreSQL's numeric scale; comparison uses exact
integer minor units, never floating-point rounding. Customer names/contact,
metadata, fingerprint, token material and raw provider bodies are not returned.

## Exact additive migration review

File: `supabase/migrations/20261027050000_zoho_original_bound_read.sql`

- UTF-8 LF bytes: **13,211**. SHA256: **`56d2ada78e82410003cdd63b798b59ca47e90266468ef38fb37f5ca977fd0daf`**.
- Atomic BEGIN/COMMIT; ONE new SELECT-only SQL function, no new tables/triggers,
  installation/runtime business-row DML, context/evidence persistence or backfill.
- Existing functions/OIDs/sources/owners/ACL/security/search_paths remain exactly
  unchanged. New function: postgres owner, SECURITY DEFINER, empty search_path,
  UTC, STABLE, only owner/service EXECUTE without grant option. Unknown default
  function grants abort. No PUBLIC/anon/authenticated permission.
- Reuses exact PR200/201/202 source guards (including refresh successor
  fb4e3a8f82aabc64dd0ae525938341c9170336582af9c58737d816ae27497110 and
  approved CRLF variants). Private origin/customer/completion/epoch table RLS,
  owner and table/column ACLs plus six exact active capture trigger/relation/function bindings are checked. The exact **20** protected CHECK/PK/UNIQUE/FK definitions and validation states
  are guarded by a digest explicitly restricted to `contype in ('c','p','u','f')`:
  `4e724a814f77fd0002fa4ccf59637e10c31efcf292ab75b20e20e9f5bb41660a`.
  PostgreSQL versions differ in whether NOT NULL also appears as `contype='n'`;
  those representation-only rows are not part of this semantic digest.
- NOT NULL is independently mandatory: exact `pg_attribute` catalog digest
  `8f3a72a36de67e045982275071a34cba02f62c7ac614a7f59b331a435e55b9ee`
  covers all **53** live columns, including **39** NOT NULL flags, in these four
  tables. Inputs: qualified relation name, attribute position/name, formatted
  type/typmod, attnotnull, identity and generated status, ordered by relation and
  position. Missing/extra/renamed/altered columns, types or NOT NULL flags abort.
  Both digests were derived from the exact PR201/PR202 schema in isolated main
  replay; no production-hash allowlist or source normalization was added.
- No row lock is retained across HTTP. Each context is a fresh statement snapshot;
  full invoice/customer/origin/mapping/owner + epoch fingerprint must match at
  every check. This is not a final authorization lock or distributed transaction.
  A race after the final inspection check can make its informational result
  stale; no sender may use it as authority. Existing gates remain blocked.

Additional PR202 hashes were derived from isolated exact main replay under
`search_path=pg_catalog,public` (not guessed or normalized):

| Function | SHA256 of UTF-8 pg_get_functiondef |
| --- | --- |
| `app.fence_old_zoho_export_journal()` | `7251a86ee41eadfe50d2a018d29cbecb30921230db0ec68c134faf6de062fe3a` |
| `app.fence_zoho_capture_candidate()` | `ac7167eca0e297b75fc36acf690189764e0054980e087e58eb000f32d3767d0e` |
| `app.guard_zoho_bound_customer()` | `8f6e33e0cdf72a3497a3353a5e6d532f1b3ef51e71bd9c6a1dda31a46a667fef` |
| `app.guard_zoho_bound_invoice()` | `6a3ea57db81270a75667c9bae7bb68af15c5fdb34230d6d23ac9a09dac07f58f` |
| `app.guard_zoho_customer_origin()` | `15dd360f944bdf228b50d515eb2ef7fc3e836d3456d4df687cc952f80a68bc1a` |
| `app.guard_zoho_origin()` | `67447599b7c2baef5c975ce47fc28a247b7a0429f71693eb64bb5eac3c42f706` |
| `cetld_zoho_capture_completion_protocol(uuid,uuid,uuid,text,uuid,timestamp with time zone,bigint,uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,date,date,text,text)` | `639642afa5ba4c61119d9146bdf1fac1a940de8b5f97838452e6faaa1fc5f8ec` |

Unknown/mixed CRLF/content/source/ACL/disabled-trigger/default-grant drift aborts
atomically. Tests reproduce the approved 31-CRLF predecessor bodies and preserve
them byte-for-byte; altered CRLF is refused. No remote source was accessed.

Operator sequence after independent approval: verify main/PR head and exact file
bytes/hash; compare installed predecessor function definitions/security and
private-table/trigger protections read-only; apply schema before code; verify the
one new function owner/ACL/source and unchanged existing functions/business row
counts. Old code remains fully blocked throughout. The code may be rolled back
without deleting origin/mapping/admission/journal data. Dropping/revoking the new
unused read function, if desired, needs separate operator review. No agent SQL
apply, deployment or merge is part of this work.

## Offline executable proof

The new suite exercises actual protected capture SQL, service preflight, existing
auth/token refresh, fake OAuth/Zoho GET, final context recheck and unchanged
reminder payment/predicate refusal. It checks no invoice/customer/payment,
snapshot, conversation, queue/claim/proposal/send writes on inspection outcomes.
All network is fake; real SQL is isolated PGlite. It does not demonstrate actual
provider field availability, multi-session PostgreSQL contention, live consent
STOP/START, customer AI, delivery or production acceptance.

Commands/results are recorded in the PR at its fixed head:

```sh
node --import tsx tests/zoho-original-bound-read.test.mjs
node --import tsx --test --test-concurrency=2 tests/zoho-capture-completion.test.mjs tests/zoho-fresh-create-receipt.test.mjs tests/zoho-prospective*.test.mjs tests/accounting.test.mjs tests/accounting-routes.test.mjs tests/accounting-invoice-diagnostic.test.mjs tests/external-reminder-containment*.test.mjs tests/external-reminder-verification-sql.test.mjs tests/invoice-sync-native-sql.test.mjs tests/direct-owner-write-sql.test.mjs tests/tally-routing.test.mjs
node --import tsx --test --test-concurrency=2 tests/accounting-invoice-diagnostic.test.mjs tests/accounting.test.mjs tests/zoho-fresh-create-receipt.test.mjs
npm run typecheck
git diff --check
```

No full local release run or CI rerun; existing exact-head CI runs once per
configured event. No new packages/API functions/config/gate/test skips. Historical
fixtures omitting PR202 also omit this source-dependent migration; assertions
remain intact. vercel.json and Hobby deployment budget are unchanged.

## Separate dependency readiness finding — no dependency change

The supplied advisory GHSA-mrhx-c7xc-m3w5 concerns resource exhaustion in zod
below 4.6.6. Lockfile source confirms @vercel/functions 3.9.9 -> @vercel/oidc 3.8.9
-> @vercel/cli-config 0.3.0 -> zod **4.1.11**. This is one advisory appearing at
four affected dependency nodes, not four independent root vulnerabilities.

Application source uses `waitUntil` in `api/whatsapp.js:1` and `next` from the
functions middleware subpath in `middleware.js:1`; the installed `waitUntil`
implementation calls `getContext().waitUntil`, with no Zod/CLI parsing. The root
functions entry imports neither its oidc subpath nor @vercel/oidc. Within that
package the OIDC dependency occurs in separate oidc entrypoints. The transitive
CLI parser uses Zod on local config/auth JSON. No application OIDC/CLI-config/Zod
call or request-payload-to-Zod path was found by the narrow source search. This
is a reachability observation, **not an exploitability clearance**, and does not
replace the supplied high audit finding.

Recommend a separate reviewed dependency PR selecting an upstream-compatible
patched resolution (Zod >=4.6.6) and validating runtime imports, webhook scheduling,
typecheck, full CI and audit. Verify available package metadata and compatibility
there; do not downgrade or run blind audit-fix/overrides here. No package, lockfile,
provider/billing or deployment change was made. The reported red Vercel build
lines containing successful test names are not test failures; the prior exact
CI totals were 2613 pass / 0 fail / 3 existing skips. Live STOP/START/customer-AI
and actual provider/send acceptance remain separately unauthorized and unproved.


Original publication focused outcomes: **8/8 SQL/HTTP tests passed**;
**13/13 existing regression files passed**; after tightening scoped refresh/body
transport, **3/3 accounting/diagnostic/receipt regression files passed**.
`npm run typecheck` and `git diff --check` pass. No test was skipped/cancelled in
these batches. Exact-head CI result is recorded on the draft PR, without a
follow-up code push merely to record CI metadata.


## Catalog portability correction and public-method proof

Independent read-only review found the earlier all-constraint digest incompatible
with production's PostgreSQL catalog representation: the fixture has 39 NOT NULL
`n` entries in pg_constraint, while production records those flags only through
pg_attribute. All 20 CHECK/PK/UNIQUE/FK definitions and validation states matched.
The revised migration separates those two independent semantic protections; it
does not accept an alternate raw-catalog hash or ignore NOT NULL.

The actual SQL tests install successfully with all 39 n entries present and,
in an **isolated disposable fixture only**, remove those representation rows
while preserving every attribute flag and prove installation still succeeds.
They then emulate a missing old-version NOT NULL through pg_attribute and prove
atomic refusal despite an unchanged 20-row semantic digest. On the modern
representation actual ALTER COLUMN DROP NOT NULL also fails the guard. Existing
PK-drop negatives remain; column type/extra-column, source, CRLF, table/column
ACL, trigger and default-grant negatives remain enforced. The migration itself
contains no catalog or business-row DML. The fixture simulation is not a live
old-version PostgreSQL server test; no production access/application occurred.

A new test constructs the actual returned integration **after** replacing global
fetch with a strict sentinel, so even an unexpected OAuth path cannot use a
captured native transport. It calls integration.inspectOriginalInvoice directly,
proves real SQL context and connection/token preparation, one exact pinned GET,
redaction and reminderAuthority:false, then proves sanitized HTTP refusal and the
actual five-second public-method deadline even when fake fetch ignores abort.
The global is always restored in finally. No runtime/API parameter was added.

Correction checks:

```sh
node --import tsx tests/zoho-original-bound-read.test.mjs
node --import tsx --test-name-pattern='returned integration.inspectOriginalInvoice' tests/zoho-original-bound-read.test.mjs
node --import tsx --test --test-concurrency=2 tests/accounting.test.mjs tests/accounting-invoice-diagnostic.test.mjs tests/zoho-fresh-create-receipt.test.mjs tests/external-reminder-containment.test.mjs tests/external-reminder-containment-sql.test.mjs
npm run typecheck
git diff --check
```

Results: **10/10** SQL/HTTP tests passed; final public-method wiring proof **1/1**;
accounting/diagnostic/receipt/containment regressions **5/5 files**; typecheck and
diffcheck passed. No new skips/cancellations, package/config/gate/provider scope
changes, remote SQL, merge or rollout. Exact fixed-head CI is recorded in PR203;
no duplicate full local run or manual CI rerun. All reminder refusals stay intact.


Subsequent dependency remediation is reviewed separately in
[vercel-oidc-exclusion.md](vercel-oidc-exclusion.md). It removes unused upstream
OIDC/CLI-config/Zod from the installed artifact using a fail-closed local
replacement; it does not patch or bless the old bundled validator. The finding
above describes the pre-remediation dependency tree.
