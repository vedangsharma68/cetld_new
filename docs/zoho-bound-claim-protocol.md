# Protected Zoho first-party reminder bridge — PR204

Draft, unapplied and unmerged. This PR now implements the functional bridge in
addition to its held foundation. Offline success is not production readiness,
live provider acceptance, live STOP/START or customer-AI proof.

## Supported path

Only a genuine immutable PR202 Zoho origin, with its protected customer mapping,
matching current original account/region and a fresh connection epoch, can use
this path. The supported approval is the existing **versionless, template-only
WhatsApp owner prepare/explicit-confirm workflow**, backed by the consumed
proposal and protected confirmation receipt. This approval format's SQL helper
is named `legacy_reminder_approval_matches`; it does **not** admit legacy
accounting rows. There is no grandfathering, metadata grant or new test grant.
The original approved-recipient/WABA/template restrictions remain; this does not
open reminders to every commercial recipient.

Actual path:

1. Existing verified owner-message and pending-action/CAS checks prepare and
   confirm exact template words, parameters and invoice/customer/preferences
   snapshots. The private origin-scoped copy preserves the existing validators.
2. The first-party scheduler's engine store atomically creates a real
   `cetld_core_automation_delivery_claims` row and immutable private journal/map.
3. Actual approved-provider preparation, intent persistence, local payment audit
   and intermediate core authorization run against that same scoped claim.
   Payment must remain zero; no provider response updates local money.
4. The internal candidate reader performs one five-second challenged GET pinned
   to original account/region/invoice/customer. Auth/ordinary refresh, SQL context,
   HTTP, JSON/body and reserve share that deadline. No list/search/retry/reselect.
5. One SQL transaction consumes the one-use candidate and runs the real approved
   final-policy implementation. It checks the current immutable binding, live
   epoch/frame, actual core claim, owner approval, exact snapshot/hash, template,
   default draft, phone/customer/consent/STOP, payment audit, cadence, preferences,
   versions, deletion/test/payable/in-flight/lease/idempotency protections.
6. A final synchronous monotonic one-use check immediately precedes Graph POST.
   No intervening HTTP/SQL/other asynchronous operation is performed. The existing
   approved provider and durable receipt adapter handle HTTP acceptance.
7. The existing receipt RPC dispatches mapped attempts through an atomic private
   receipt bridge, then its unchanged counter/cadence/reconciliation policy.
   Actual webhook raw-body HMAC verification and WABA/phone filtering precede
   callback handling. Duplicate/cross-message callbacks cannot count twice.

The source-derived policy copies are private, owner-executable only. Their
external predicate is a private backend/transaction/invoice context, never a
caller GUC/JSON flag. All originals keep their fail-closed external predicates;
only the existing owner routine and receipt routine acquire explicit bound
branches. The candidate always returns `deliveryAuthority:false`; final send
permission comes from the independent composed SQL reservation and the runtime's
opaque, instance-local one-use state. PR203 inspection is never accepted as proof.

Still blocked before token/provider access: unbound/legacy/imported invoices,
PR201 admissions/journals, current-org diagnostics, wrong account/scope, QuickBooks,
Tally, generic core/cloud/other workers and standalone old evidence wrappers.
Linked v2/free-form/fallback/dashboard/AI review paths remain unavailable. Local-only
reminders and PR199 diagnostic behavior remain. Bound imports and owner financial
payment/mark-paid/void refusals are unchanged. Owner notes/delete/undo/date rules
remain; a date correction preserves the immutable original and makes this read/
reminder unavailable when current dates differ. Draft-origin or otherwise
nonmatching provider status is not upgraded into payable authority.

## State, races and trust

Private claim: invoice/version/schedule, owner/workspace/customer, immutable origin
operation/account/region/external identities, current epoch and exact frame;
two-minute lease. Challenge: one server nonce, five seconds. Candidate: one attempt,
only a stored permit hash, deadline at most two seconds and no later than the
read deadline. No nonce/permit is returned by read-only recovery.

Both the beginning **and end** of final SQL enforce expiry/current frame. A slow
policy/template lock rolls back consumption and reservation. The runtime also
uses monotonic time from reserve-request start, a five-second overall final-read
budget, and a synchronous consumed-before-POST check; a late SQL HTTP response
cannot grant a stale send. Individual bridge RPCs are bounded too. Lost responses
may leave committed state, never permission to retry.

Switch, away/back, reconnect/reconsent/credential replacement permanently invalidate
old claims. Same-account reconnect may create a *new* inspected/claimed operation
for a valid immutable origin; it cannot resurrect an old attempt. Normal token
refresh preserves the epoch. Invoice/customer/settings/consent/STOP/owner-membership
changes invalidate pending claims irreversibly, including edit/revert and STOP/
START. No owner-editable lease or metadata can restore one.

Lock order for the composed path is phone advisory -> owner membership -> settings
-> customer -> invoice -> connection -> epoch -> core claim -> private journal.
Capture and the private protocol now lock customer before invoice, matching
review/approval and customer tone invalidation. Capture rechecks the locked
customer against the locked invoice. Receipts use the compatible historical
phone/settings/customer/invoice/core/private order. No lock spans HTTP. Tests use
single-session PGlite with explicit interleavings; multi-session PostgreSQL lock/
liveness testing remains unverified (no local PostgreSQL server was available).

Receipts make the private journal terminal *before* legitimate counter/version
writes in the same transaction. Thus its own receipt does not self-cancel; no
service/GUC/invoice-DML invalidation bypass is installed. All other pending edits
still cancel or quarantine. Scoped historical receipts after STOP/account switch
can audit/count their own accepted attempt once; they never restore approval,
resume a paused invoice or authorize another send.

Unknown POST, lost final acknowledgement and missing receipt acknowledgement are
quarantined. There is no automatic redispatch, recovered permit, invented receipt,
cleanup/reset/unquarantine or rebind. A committed receipt survives lost HTTP
acknowledgement. Explicit known policy re-review still uses the existing review
hold path. Recovery is read-only state/attempt metadata, not an authorization.

The backend is the trusted HTTPS provider/signature attestor. Service JSON cannot
create/alter original provenance or private contexts/tables; existing origins and
current SQL facts are independently required. This is not a defense against an
operator/compromised trusted backend fabricating provider attestations. Zoho or
consent can change after the last read/SQL commit and before provider receipt:
SQL and external providers do not form a distributed atomic transaction.

## Exact migration/security packet

Apply neither migration without independent source/security review. Held foundation:

- `20261027070000_zoho_bound_claim_protocol.sql`: **29,088 UTF-8 LF bytes**,
  SHA256 `0fdd30024791eb05a6dec249a66f0839be7c1526397e1d52ece2126723521758`.
- Successor `20261027100000_zoho_first_party_reminder_bridge.sql`: **123,888 UTF-8 LF bytes**,
  SHA256 `e7b3e41db3cbc737080099b29c0fe30ef9e11c4065d08714be90850b66823e80`.

The successor is one atomic guarded transaction. Two new private RLS tables
(transaction context and immutable core/journal mapping), eleven private definer
helpers/policy copies, one fixed-action service-only RPC and two new triggers.
All new functions have empty search_path; all private tables/functions deny
PUBLIC/anon/authenticated/service access. Only the narrow public bridge grants
service EXECUTE. No general table write/verified flag or caller account override.
Unknown default grants, column ACLs, RLS/policy or source drift abort.

Existing function OIDs, owners, ACLs, definer/invoker flags, search paths and other
security attributes are preserved. Exactly five existing bodies change:

- capture completion: customer-before-invoice lock/recheck only;
- private candidate protocol: compatible customer/invoice order/recheck;
- private invalidation: add owner-membership invalidation;
- private owner routine: explicit supported-origin branch;
- public first-party receipt: explicit mapped-attempt branch.

Everything else, including PR200 predicates and both generic core gates, remains
byte-identical. The migration includes the full exact predecessor inventory:
21 prior capture/read guards plus 34 exact policy/protocol helper signatures with
semantic ACL inventories derived offline. It supports only the audited contained
approved LF/31-CRLF core variants; unknown/mixed line endings abort. No unknown
source is normalized. PR203 context predecessor is
`273f1fc397a0505ba49e97d7e6625fa63da86acef1f813dab208434335270dbd`;
refresh successor remains
`fb4e3a8f82aabc64dd0ae525938341c9170336582af9c58737d816ae27497110`.

The exact chronological main chain produces approved-final predecessor
`286ea00f8e2ebf9bf843bc13bf45fd2d9884e4208d523185ef11abe50469746a`.
A partial fixture reinstall lost the exact delivery/words block and produced
`60f3cbe76915a27769c1e664cf208a5cccb194e361d6f7d3b13ec71d63528271`;
the new migration rejects that incomplete definition. No compatibility waiver.

Version-portable protection retains the 20 c/p/u/f constraints digest
`4e724a814f77fd0002fa4ccf59637e10c31efcf292ab75b20e20e9f5bb41660a`
and independent 53-column/39-NOT-NULL digest
`8f3a72a36de67e045982275071a34cba02f62c7ac614a7f59b331a435e55b9ee`.
Foundation journals add 10 c/p/u/f constraints digest
`89b715bfd5cb2aa5328d160f808d278dc7504e1534d7effe3a6aa19db7e8fece`
and 34-column/27-NOT-NULL digest
`6128cb8ac69188093275a549e6c9d7084ac19def04887df4061c2bcfac37ba86`.
NOT NULL is never inferred solely from version-dependent pg_constraint 'n' rows.

A 29-trigger semantic digest audits relation/function, event bits, enabled state,
columns, arguments and WHEN expression, including epoch, admissions, capture,
private invalidation, test, branding, version, preferences, STOP and consent locks:
`365e9a3337b16054e0e26f1b18766d61ec55a8813c719dd2ad1f081193a9de4b`.
The original six capture and ten foundation registrations are also checked. New
core updates/deletes cannot rewrite a mapped claim into permission. Existing
fail-closed STOP/quarantine transitions remain possible.

No installation business-row DML/backfill. No provenance migration/upgrade of
existing admissions, journals or invoices. Runtime effects are the explicitly
reviewed reminder claim/intent/reservation/receipt/counter/cadence operations;
no invoice financial/customer/origin/snapshot/import/model mutation.

Review/rollout order: read-only compare exact source/ACL/RLS/constraint/attribute/
trigger inventories and bytes; approve both held migrations; apply foundation then
successor before code; verify five source changes, unchanged old security and
business hashes; only then independently review/deploy code/current CI. If the
successor aborts, the foundation remains disabled and old workers fail closed.
Old code cannot use this bridge. Code rollback leaves protected attempts/audits
and signed historical receipt handling intact; never delete/reset journals or
unknown attempts. No automatic SQL rollback script or remote application by agent.

## Offline proof and remaining review

`tests/fixtures/zoho-bound-reminder.mjs` now installs the exact chronological full
migration chain; it never reinstalls an earlier optional gate over a later patch.
The injected database option attaches only the offline HTTP fixture. Historical
partial fixtures omit the dependent successor; no assertion/test/gate is skipped.

Tests exercise real owner confirmation, engine/core claims, approved provider,
final SQL and signed webhook with fake exact Zoho GET/Graph POST, plus each
snapshot/financial/transport/race/rollback/replay/uncertainty guard. Local-only
positive and owner date/delete/financial/test guard regressions remain. Network
sentinels reject every other external request; no actual credentials/providers,
customer AI, business data, sends, imports, SQL or deployment are used.

Exact focused commands and outcomes are recorded on draft PR204. Required commands:

```sh
node --import tsx tests/zoho-first-party-reminder-bridge.test.mjs
node --import tsx --test --test-concurrency=2 tests/zoho-original-bound-read.test.mjs tests/zoho-capture-completion.test.mjs tests/zoho-prospective-export.test.mjs tests/zoho-prospective-foundation-sql.test.mjs tests/zoho-fresh-create-receipt.test.mjs tests/external-reminder-containment-sql.test.mjs tests/external-reminder-verification-sql.test.mjs tests/reminder-durability-sql.test.mjs tests/direct-owner-write-sql.test.mjs tests/invoice-lifecycle-sql.test.mjs tests/whatsapp-owner-sql.test.mjs tests/tally-routing.test.mjs
npm run typecheck
git diff --check
```

One fixed-head configured CI run follows focused proof; no manual reruns or full
local release duplication. No packages, config, API functions, CI gates/skips or
spend changes. vercel.json/Hobby budget unchanged. Separate Zod four-high advisory
remediation still needs a compatible patched resolution/review. Actual provider
field availability, deployed/installed source compatibility, multi-session locks,
real STOP/START, customer AI and genuinely authorized live delivery proof remain
independent work. Stop for review; do not apply, merge or deploy.
