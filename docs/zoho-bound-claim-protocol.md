# Disabled Zoho origin/epoch claim-to-final protocol foundation

**No reminder sender is enabled. Overall protected reminder restoration and
production readiness are NOT complete.** This is the explicitly allowed disabled
claim-protocol cut, not another informational read. It adds immutable private
claim/attempt state, fresh-read challenges, one-use final candidate permits,
irreversible invalidation and scoped receipt audit. It is not registered with an
API, model, integration factory, scheduler, engine, provider or webhook. The new
functions are owner-executable only; no service-role executor is granted. There
is no flag/GUC/metadata path that enables it. Every result says
`deliveryAuthority:false`; the factory has no sendReminder/Graph transport.

## Concrete dependency closed

Current code executes:

1. owner reminder confirmation schedules the shared queue;
2. `FollowUpEngine.run` calls `CoreAutomationStore.claimDueFollowups`;
3. prepareReminder, intent persistence and payment check;
4. core authorizeDelivery, then approved-provider facts and its separate final RPC;
5. Graph POST, core markSent, first-party receipt and async signed callback.

The old claim has no protected original-account/epoch binding. PR200 intentionally
blocks linked rows, and PR203 inspection is informational. Reopening a predicate
would neither bind those successive gates to one attempt nor prevent switch/
STOP/revert from reviving an old worker's capability. This PR implements that
missing private claim/challenge/final-attempt lifecycle without reopening any of
the existing consumer gates. It creates NO public core queue claim/message.

Supported here: private owner-only protocol transactions and fake-HTTP proof.
Still blocked: **all** linked owner preview/proposal/confirmation, payment check,
automatic/manual queue, generic/final dispatch, approved sender and business
receipt/cadence continuation. QuickBooks/Tally/imports/legacy/PR201 remain blocked
before token/provider access. Local-only reminders and PR199 are unchanged.

## Protocol and binding

`createDisabledZohoClaimProtocol({executor,store,accessToken,fetchImpl})` requires an
explicit trusted private executor. There is no default service RPC or public API.
Input is only `{userId,workspaceId,invoiceId}`. Handles/permits/receipt references
are frozen opaque objects kept in instance-local WeakMaps, not JSON evidence.
Clones, caller fields, informational inspection results and GUCs cannot use them.

Private SQL resolves workspace owner, current invoice/customer and genuine PR202
origin + customer mapping through the installed PR203 context RPC. It captures
original operation/account/region/customer/external invoice identity, current
epoch, invoice version/schedule and full invoice/customer/origin fingerprint.
Settings/consent are hashed server-side. The data frame additionally requires
active same-customer consent, no STOP, due approved/active/scheduled state, contact
hours/cadence and unchanged approved-preference time. **This is not an owner
approval/template/commercial-recipient authority validator.** Those existing
consumer gates are still closed and must be combined in the future bridge.

- Claim: one durable journal row per invoice/version/schedule, two-minute lease.
  Existing public/private in-flight or quarantined attempts block another claim.
  Identity/frame/lease are immutable; journal writes require a private per-backend,
  transaction/claim context. No owner/member/service table writes or execute.
- Challenge: exactly once, nonce + five-second server deadline before any token/
  provider work. A matching live frame is checked again after token preparation.
- Read: one exact Zoho GET pinned to original account/region/customer/invoice,
  one five-second end-to-end client deadline, no list/search/retry/reselection.
  Exact currency/total/zero paid/balance/status/dates/reference and explicit zero
  credits/write-off must match protected original AND local state. Reuses bounded
  256 KiB JSON/redirect/UTF-8 transport and existing deadline-aware token refresh.
  It does not promote PR203's informational output; it performs its own challenged
  GET and submits internally constructed typed facts with the private nonce.
- Reserve: SQL independently rechecks live frame, nonce, read lease and exact
  normalized facts. Atomically stores one attempt and only a permit hash. The
  opaque random token is returned once, expires within two seconds and never
  appears in JSON returned by the JS factory.
- Begin: SQL rechecks binding, policy snapshot, epoch, lease, attempt and permit
  under current locks, then consumes it by moving to posting. Client removes its
  permit before awaiting SQL. Replay cannot create another attempt. This remains
  a **candidate reservation with deliveryAuthority:false**, never a send grant.
- Receipt: only an attempt that actually reached private posting can record its
  scoped token/message/status. Duplicate same-event records are idempotent;
  cross-message and cross-attempt substitution fails. Delivered/read outrank
  later failure, and weak accepted/sent cannot overturn a conclusive failure.
  Receipt handling changes PRIVATE AUDIT ONLY, never invoices/counters/schedules,
  messages, payments, core claims or consent. Callback after switch/STOP may audit
  its own historical attempt; it cannot authorize another action.

Private receipt input presumes a future trusted HTTP-acceptance/signed-webhook
attestor. This PR does NOT validate a Graph signature or dispatch a POST; synthetic
receipt fixtures are not live provider acceptance proof. No privileged JSON audit
record can turn deliveryAuthority into true or make a public gate pass.

## Races, failure and recovery

Locks: phone advisory -> settings -> invoice -> customer -> connection -> epoch
-> private claim. The phone/settings prefix follows STOP. PR202 capture uses invoice-before-
customer; v2 review-capable installations' app.evaluate_reviewed_reminder uses
customer-before-invoice. These paths must NOT be composed blindly. The future
bridge must reconcile that order before enablement; cross-path deadlock/liveness
is not proven by isolated tests. The private executor remains inaccessible to
service/owner-member roles, so no enabled concurrent sender path is claimed.
No locks span HTTP.
Normal protected refresh preserves epoch and the claim. Account selection,
away/back, reconnect/reconsent/credential replacement invalidate it permanently.
New AFTER triggers invalidate pending private claims on invoice/customer/settings/
workspace/consent/suppression/epoch changes. Claimed/challenged/reserved becomes
cancelled; posting becomes quarantined. An edit/revert or STOP/START cannot revive
it, even if current values happen to match again. These triggers change no public
business fields. Four filtered indexes bound normal pending-claim lookups.

Read/SQL timeout does not permit another GET. If the deadline has passed, cleanup
is not allowed to start a new request; the non-reusable state/expiry remains and
requires separate review. A reserve/begin acknowledgement can be lost after commit;
read-only recovery returns state/attempt identifiers, never the permit or nonce.
It cannot redispatch or invent a receipt. Unknown posting remains quarantined and
blocks another claim. There is no cleanup/rebind/repair/unquarantine operation.
Account recovery alone cannot reset a cancelled claim's version/schedule identity;
a new explicit review/schedule is required. Unknown attempts need separately
reviewed reconciliation, not another epoch or edited metadata.

The provider can change after the last exact GET, and STOP/edit can occur after
SQL reservation and before HTTP. There is no distributed transaction with Zoho or
Graph. This disabled foundation sends nothing. Future wiring must run every
existing final policy check and consume the private candidate in the SAME SQL
transaction, then perform no asynchronous work before POST. An informational or
candidate result must never be treated as final permission.

## Exact remaining wiring before any enablement

This is code work still required, not a production/operator enable switch:

1. Add a narrowly scoped private SQL bridge that atomically creates the real core
   claim and this immutable binding; route exact-invoice first-party scheduler
   claims through it. Keep generic/unscoped/old-worker linked claims refused.
2. Integrate owner preview/confirmation, payment check, core authorization and the
   approved sender's final RPC with that same bound claim. Preserve their actual
   owner/approval receipts, exact words/delivery snapshot/fingerprint/template/
   default-draft, consent/STOP, commercial identity, phone, payment audit,
   settings/cadence/contact-hour/deletion/test/payable/inflight guards. The data
   frame alone is insufficient and intentionally grants no authority.
3. At final reservation combine the existing approved-provider policy validator
   and one-use private begin transition under the reviewed lock order. Only the
   approved sender may receive an internal dispatch capability/callback value;
   wire the engine adapters without exposing raw permits or generic JSON proof.
4. Bind core markSent/markFailed/quarantine and actual first-party signed receipt
   callbacks to the journal attempt, atomically preserving existing count/version/
   callback/dedup semantics. Route acceptance/signature evidence through an
   internal attestor, never caller JSON. Keep lost/unknown POST non-retriable.
5. Prove a complete real engine -> approved provider -> fake Graph -> actual SQL
   receipt positive path plus each isolated final guard, then independent source,
   migration, CI/deploy and genuinely authorized live-flow review. There is NO
   positive enabled engine/send path in this PR; tests prove it remains blocked.

## Migration/security review

`supabase/migrations/20261027070000_zoho_bound_claim_protocol.sql`: **29,088 UTF-8 LF bytes**, SHA256 **`0fdd30024791eb05a6dec249a66f0839be7c1526397e1d52ece2126723521758`**.

One atomic additive BEGIN/COMMIT: three private RLS tables, four owner-only
SECURITY DEFINER functions, ten triggers (two new-table guards, eight invalidation
hooks), four filtered indexes. Empty search_path; UTC on hashing/protocol routines.
No installation business-row DML/backfill, no public API/service function grant,
no existing function body/OID/owner/ACL/search_path replacement. Runtime mutations
are limited to private protocol rows/context/audit. Existing source table writes
remain governed by their original policies and triggers.

All 21 installed source guards include accepted PR200 approved 31-CRLF variants,
PR201 refresh successor and epoch/capture guards, PR202 protected origin/identity
helpers and PR203 context RPC. The new PR203 predecessor was derived in isolated
exact-main replay under canonical search_path, not guessed:

`public.cetld_zoho_original_bound_read_context(uuid,uuid,uuid)`
SHA256 `273f1fc397a0505ba49e97d7e6625fa63da86acef1f813dab208434335270dbd`.

The reviewed semantic 20-constraint digest and independent 53-column/type/39-NOT-
NULL digest are reused exactly, as are table/column ACL, RLS, six exact active
capture trigger bindings and app CREATE protections. Unknown source, catalog,
ACL/default-grant or line-ending drift aborts. New function/table default grants
are audited; no hidden grantee or grant option survives. No source normalization
or raw production-hash allowlist was added. The migration itself is the exact
remaining predecessor hash inventory; original-read packet documents derivation.

After independent review ONLY: compare installed source/security/catalog/triggers
read-only, verify exact bytes/hash, apply schema before code, verify new private
ACL/RLS and unchanged business hashes/old functions. Owner-only executor and all
old blocks remain closed before/after code. Do not grant private EXECUTE or flip
any existing gate as a rollout shortcut. A code rollback leaves private journals
for audit; do not delete them or reset unknown attempts. Trigger/function removal
or receipt reconciliation needs a separately reviewed operator plan. No agent
apply/merge/deploy is authorized or performed.

## Offline proof and limits

Tests use isolated real SQL, actual token/capture/accounting integration and fake
OAuth/Zoho HTTP. They exercise claim/challenge/permit/begin/receipt transitions,
opaque forgery/replay, origin/scope/metadata/GUC/diagnostic negatives, SQL rollback,
reserve acknowledgement loss, unknown posting, late receipt audit, immutable
identity, switch/away-back/reconnect, refresh, edit/customer/preferences/STOP/START,
owner date/delete compatibility, remote identity/money/status/date/credit/error/
timeout/body/redirect failures, short permit expiry and unchanged old gates.
The actual engine/approved provider are also run negatively with Graph sentinels:
core claim remains refused, payment/Graph are not reached. No test bypasses that
real gate to claim an enabled positive send. Synthetic private receipts are only
journal fixtures. No multi-session PostgreSQL contention, real provider field
availability, real signature/callback, live STOP/START/customer-AI or sellability
proof is claimed.

Exact commands/results and exact-head CI are recorded on the draft PR:

```sh
node --import tsx tests/zoho-bound-claim-protocol.test.mjs
node --import tsx --test-name-pattern='switch/away-back' tests/zoho-bound-claim-protocol.test.mjs
node --import tsx --test --test-concurrency=2 tests/zoho-original-bound-read.test.mjs tests/zoho-capture-completion.test.mjs tests/zoho-prospective*.test.mjs tests/accounting.test.mjs tests/accounting-invoice-diagnostic.test.mjs tests/external-reminder-containment*.test.mjs tests/approved-reminders.test.mjs tests/engine.test.mjs tests/invoice-sync-native-sql.test.mjs tests/direct-owner-write-sql.test.mjs tests/tally-routing.test.mjs
npm run typecheck
git diff --check
```

No full local release rerun, parallel coding, packages, config/API functions, CI
gates/skips or spend. Historical fixtures omitting PR203 omit this exact dependent
migration; no assertion is removed. The separate Zod high-advisory dependency
finding remains open and unchanged; it needs its own compatible patched
resolution/review. None of this authorizes actual provider/customer-AI/business
QA/import/queue/send/cleanup/rebind work. All linked reminders remain blocked.


Focused results before publication: **9/9 protocol tests passed**, **13/13 existing
regression files passed**, and the final owner-date/delete/invalidation case
passed separately after its fixture correction. Typecheck and diffcheck passed.
No focused assertion was skipped or cancelled. Exact-head CI belongs on the draft
PR, without another code push merely to record CI metadata.
