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
- Successor `20261027100000_zoho_first_party_reminder_bridge.sql`: **128,301 UTF-8 bytes**,
  SHA256 `6a76042a9588192501139dd4fcf5a4a55cd78127ddc039152d6142dcd433bb4e`.

The successor is one atomic guarded transaction. Two new private RLS tables
(transaction context and immutable core/journal mapping), eleven private definer
helpers/policy copies, one fixed-action service-only RPC and two new triggers.
All new functions have empty search_path; all private tables/functions deny
PUBLIC/anon/authenticated/service access. Only the narrow public bridge grants
service EXECUTE. No general table write/verified flag or caller account override.
Unknown default grants, column ACLs, RLS/policy or source drift abort.

Existing function OIDs, owners, ACLs, definer/invoker flags, search paths and other
security attributes are preserved. On the canonical path five existing bodies change:

- capture completion: customer-before-invoice lock/recheck only;
- private candidate protocol: compatible customer/invoice order/recheck;
- private invalidation: add owner-membership invalidation;
- private owner routine: explicit supported-origin branch;
- public first-party receipt: explicit mapped-attempt branch.

The observed installed path additionally restores the canonical public approved-final
guard (six existing bodies total) and creates one missing canonical private helper.
All six unchanged observed CRLF functions, PR200 predicates and generic core gates
remain byte-identical. The migration includes the full exact predecessor inventory:
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

### Observed installed-source repair — still unapplied

Chronological main is a reconstruction fixture, not a claim about installed
production source. The independently reported installed shapes are reproduced
from reviewed migrations offline, and their full hashes are asserted before
applying any repair. No live access by agent was used.

Before the strict canonical bridge guards/copies, the same atomic transaction:

1. Accepts only approved-final canonical `286ea00f…` or exact observed
   `a9cb55e078ac3203d20bc375f6b5cc7859709fefc417cef06699d824fc37d84f`.
   For the latter, reinstates exactly the six-line protected legacy-approval
   refusal/hold block and asserts the resulting full hash is canonical. No weak
   predecessor is merely allowlisted for execution.
2. Creates `app.legacy_reminder_approval_matches(uuid,public.invoices)` only when
   absent, from its exact reviewed canonical definition. Resulting full hash:
   `5f6f096cf89040c2682cdf299d105694f4f913c98b9c6ad99f91e2c0dc836415`.
   Owner postgres, SQL/STABLE/definer, empty search_path, owner EXECUTE only.
   Existing canonical definition/OID is untouched. Unknown source, flags, owner,
   ACL or default grants abort; no receipt, approval or provenance is inferred.
3. Accepts receipt canonical `d0071207…` or exact observed
   `add70c665905608618618b6156b7c849ec5b49ea59790b8f30da108c606cfb42`.
   Repairs only the nullable version/mode condition to the canonical coalesce
   expression. The 68 CRLF plus two historical inserted LF endings stay intact.
   Repaired pre-branch hash is
   `73a9eadb281a6d107b63b46d0a9c8ee3b463b7b043bf0b839a2154d7d9142c42`;
   a comparison-only normalized copy exactly matches `d0071207…`.
   The mapped-receipt branch is then inserted using the installed body's line
   ending, retaining the original OID/ACL/config. The resulting body has 71 CRLF;
   its comparison-only LF copy matches the canonical branch hash `ff44a3b7…`.

Six unchanged functions accept only their canonical hash and the following exact
observed CRLF hash. Comparison copies must normalize exactly to canonical and
match the specified CRLF count; unknown/mixed variants fail. None is rewritten.

| Function | Observed full SHA256 | CRLF |
| --- | --- | ---: |
| `app.reminder_canonical_json(jsonb)` | `51b89ca99fca774daa6077454b735c3059636e4c23d77878115198ae574b5f66` | 5 |
| `cetld_core_check_local_reminder_payment(uuid,uuid,uuid)` | `5bfeccccb370e82543aba56fcd241ead4f8fbc29739569bdd32848acc92f9178` | 23 |
| `app.first_party_receipt_audit_guard()` | `ca43f160c886182e72350fcde7ced8551c59b2030cabf75147e5983f5bd01658` | 1 |
| `app.first_party_consent_phone_lock()` | `2a0b2fcd396d8e1ce63be7118af5dc60a94269f1a50ae89c5afaa4876e44c1d1` | 8 |
| `app.cancel_first_party_phone(text,uuid)` | `265269a0711b3a5dfc72636455f330a9da199823251d1d4075f308dcf48d4dff` | 17 |
| `app.first_party_suppression_hook()` | `fc1a836b55819bdc964c200cfd92eab098b364af633725dd5d2eaa8a166d03f9` | 4 |

The exact-hash reconstructions retain invoker status for canonical-json,
receipt-audit and consent-phone-lock, as encoded in their canonical definitions;
no definer upgrade is made. Preserve and independently inspect actual flags as
well as owner/ACL. Public functions retain owner + service EXECUTE without grant
option; private functions retain owner EXECUTE only. Known generic core 31-CRLF
variants remain covered by their existing exact guards.

Helper dependency inventory, checked before creation/copying:

| Relation | Required columns |
| --- | --- |
| `app.reminder_approvals` | workspace_id, owner_id, invoice_id |
| `public.owner_assistant_proposals` | workspace_id, owner_id, action, state, result |
| `public.whatsapp_pending_actions` | workspace_id, phone, id, version, consumed_at, action |
| `public.whatsapp_direct_write_receipts` | workspace_id, owner_id, phone, request, result |

Private approvals must remain postgres-owned with RLS and no non-owner table or
column grants. Missing tables/columns fail closed. SQL helper creation also
validates its referenced columns; the existing 34 exact helper source/ACL guards
and 29 trigger audit remain in force. No entire historical migration, data
backfill or historical approval conversion is run.

For fresh operator **catalog-only read-only** compatibility review, inspect
`pg_get_functiondef`, SHA256, `proowner`, `prosecdef`, `proconfig`, semantic ACL and
CRLF counts for these eight signatures plus the possibly absent helper. For
example (extend the VALUES with the exact inventory above):

```sql
select e.signature, p.oid, pg_get_userbyid(p.proowner) owner,
 p.prosecdef, p.proconfig, p.proacl,
 encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') full_sha256,
 (length(p.prosrc)-length(replace(p.prosrc,E'\r\n','')))/2 crlf_count
from (values
 ('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)'),
 ('public.cetld_core_record_first_party_receipt(text,text,text,text,text,text)'),
 ('app.legacy_reminder_approval_matches(uuid,public.invoices)')
) e(signature) left join pg_proc p on p.oid=to_regprocedure(e.signature);
```

This probe changes no schema/data and invokes no business/provider routine.
Compare dependency columns/RLS/ACL via catalogs too. Foundation is still held;
its guards run before successor repair. Apply neither until independent review
approves this exact packet. Canonical-path repair is a no-op; later unknown drift
aborts the complete transaction, including helper creation and both repairs.

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
node --import tsx tests/zoho-installed-compatibility.test.mjs
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

Bounded installed-compatibility correction proof: **16/16** new actual-SQL tests
passed, including exact observed hashes/absence/CRLF, atomic drift rollback,
unchanged installation row hashes, forged versionless approval/words and the
unwrapped service final gate. Bridge suite **111/111** passed on canonical and
observed shapes, including actual owner/engine/fake GET+POST/signed receipt and
versionless cadence. No runtime/provider/API/package/config changes in this
correction. Exact updated-head CI and commands/results are recorded on PR204.
