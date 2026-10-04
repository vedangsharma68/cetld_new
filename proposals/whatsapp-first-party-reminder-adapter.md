# Disabled first-party invoice reminder adapter proposal

The optional durability SQL now rejects local-ledger authorization whenever an
invoice has a trimmed, nonempty `external_provider`, `external_invoice_id`,
`metadata.accounting_provider`, or `metadata.bookkeeping_record_id`. Empty,
space-only and null values carry no accounting authority. Matching keys in owner
custom fields are labels and cannot select a ledger. The SQL predicate is
self-contained; it does not depend on the separate owner correction migration.
The service-only final gate independently invokes this check before reserving a
dispatch. External records require a separately reviewed fresh accounting check.
This change does not enable, deploy or approve the reminder sender.

This is a design proposal, not an activated provider. No reminder adapter, new
template, scheduler, credentials, migration or feature flag is enabled by this
change. Existing `meta`/`wapi` factory rejection and the Cloud outbound hold remain.

## Repository blocker and current official sources

The hold originated in commit `e51e38c` (Add guarded WhatsApp Cloud API integration).
`automation/whatsapp/README.md` explicitly says the Cloud integration is separate
from reminders pending a Meta debt-collection policy review. The current
`factory.mjs` rejects `meta`/`wapi`, `cloud-outbound.mjs` returns no `sendReminder`,
and `runtime.mjs` creates the engine through that unsupported production factory.
No AGENTS.md or .agents instructions were found in this checkout.

Reviewed on 2026-10-04:

- [Official messaging policy](https://whatsappbusiness.com/policy/), dated
  September 23, 2026, restricts debt-collection services. It also requires recipient
  opt-in, honoring opt-out, approved templates for initiated conversations, and a
  24-hour customer service window for free-form replies.
- [Official utility-message page](https://whatsappbusiness.com/products/conversation-categories/utility/)
  includes payment reminders related to a past purchase or subscription.
- The policy's linked Meta Commerce page redirected to a login/block page;
  developer utility-template documentation could not be retrieved.

The utility use case supports investigating first-party purchase invoice
notifications. It does not establish an unconditional first-party exemption or
approve CETLD, every business category, a template, or a third-party collection
service. Do not replace the repository hold with a claim of policy approval.

## Minimal future code and disabled guards

Add a separate `automation/whatsapp/cloud-reminders.mjs`, exporting
`createFirstPartyReminderProvider({env, fetchImpl, store, consentStore})`. Wire it
from `createAutomationRuntime` only when **all** of these explicit server flags
and configuration checks pass:

1. `AUTOMATION_OUTBOUND_ENABLED === 'true'`.
2. `WHATSAPP_REMINDERS_ENABLED === 'true'` (new flag; absent means disabled).
3. `WHATSAPP_OUTBOUND_ENABLED === 'true'` and the current fixed approved QA-contact
   allowlist intersected with configured `WHATSAPP_TEST_ALLOWLIST`. Do not widen it
   as part of implementing the adapter.
4. Explicit supported provider mode, configured Meta phone/WABA/version and
   credentials, and a server-reviewed utility template name/language/version.
5. Reviewed first-party purchase/subscription use case and template for the
   business, separately from arbitrary free-form reminders or external collection.

Do not make `createWhatsAppProvider` fall back to mock in production. If any guard
fails, return a stable disabled/blocked result before a credential is used or a
network request is made. Keep the supported fake provider in isolated tests.

Do **not** alias `sendReminder` to `sendInvoiceUpdateTemplate`. That existing
neutral QA template has different copy and invoice-status eligibility, and does
not dispatch the owner-approved reminder body. Substituting it would misrepresent
what the owner approved.

## Reviewed template, recipient and invoice binding

Use an approved utility template with bounded factual parameters derived from a
fresh owner/workspace-scoped invoice: verified business name, customer's name,
actual displayed invoice number, amount/currency, and due date, with an opt-out
instruction. Exact copy and category require separate review and template approval;
no draft string in this proposal is a production-approved message.

The adapter must reread `invoices.customer_id`, current customer/recipient phone,
workspace business settings, direction, amount paid, due date, deletion/status and
approved preference version. Accept only an issued receivable representing the
reviewed first-party use case. Reject paid, void, canceled, deleted, paused,
ambiguous, stale, mismatched-currency, or changed-recipient invoices.

The rendered template body must equal the durable owner-reviewed reminder text.
Persist template name/language/revision, exact parameters and a body hash with the
claim. If the current free-form approved body is incompatible, request a new
review; never silently discard custom text or use an arbitrary model-written
template. LLM output cannot choose workspace, owner, credentials, recipient,
template approval, delivery token or consent status.

## Required database work before activation

Existing core claim/auth SQL checks owner, invoice state/version, preferences,
local contact hours and reminder limit. It does **not** check recipient consent or
suppression. Existing STOP revokes consent and suppresses Cloud messages but
leaves the core schedule active. The mock reminder pipeline can still dispatch
after an owner resumes it; its mock provider has no consent guard.

A separately reviewed additive migration must provide:

- A scoped final dispatch authorization RPC binding claim, owner, workspace,
  actual invoice/customer/phone, template snapshot and recipient consent generation.
  Check current explicit recipient opt-in/category, global/workspace suppression,
  phone/customer binding, invoice state/version and approved settings atomically.
  Lock/recheck consent against STOP before changing the claim to sending.
- STOP/refusal cancellation of matching unpaid recipient schedules and pending
  claims independent of `pauseOnReply`. Preserve invoice/payment facts. Owner
  resume must not clear suppression or grant consent; fresh recipient opt-in must
  use the existing sanctioned consent process.
- Opaque tenant-bound callback correlation for core claims/messages, connecting
  signed Meta status callbacks to the correct invoice and exact dispatch intent.
  Existing conversation callback handling updates `whatsapp_messages`; it does
  not reconcile `cetld_core_automation_delivery_claims`.
- An idempotent sweep to quarantine expired sending claims, with an attention
  receipt and original snapshot. Current SQL leaves an abandoned sending lease in
  sending forever; unlike the memory fixture it does not reclassify that state.
- Idempotent reconciliation of accepted/sent/delivered/read/failed receipts.
  Complete count/cadence exactly once while preserving a payment, STOP, pause or
  reply that arrived during dispatch. Reject forged callbacks or a different
  owner/workspace/phone/token and do not let callbacks resurrect canceled work.

Do not apply a migration from this document: there is no proposed SQL file or
production approval for these database changes yet.

## Delivery and interruption contract

Persist intent before authorization and perform no awaited work between the
final gate and provider dispatch. Use the stable `(workspace, claim)` key and
opaque callback correlation. A timeout/lost Graph response, lost receipt, or
expired sending lease is **uncertain**; no blind retry. Retry only a proved
pre-dispatch failure or definitive rejection under the bounded claim budget.
An accepted HTTP result is acceptance, not delivery; report delivery only from
verified provider receipts.

The local engine change in this QA branch makes a caught accepted-delivery
receipt failure attempt the existing scoped unknown quarantine and attention
event, preserving any already-sent receipt. A killed process cannot execute that
catch and still requires the database sweep/reconciliation work above. A consent
change after final authorization cannot recall an already dispatched HTTP request;
the adapter must document that limit and immediately block subsequent sends.

## Activation prerequisites and QA boundary

Before any controlled live QA: approve the concrete adapter and exact migration;
review the applicable business use case and actual approved template; verify the
account/template/provider configuration without changing scopes or billing; verify
recipient opt-in and the explicit authorized QA contact; confirm accounting/local
payment reconciliation and a working signed status callback; approve one bounded
QA send separately. Existing credentials alone are not authorization to send.

Only after those pass should an explicitly authorized scheduler call the existing
worker route with authenticated owner/workspace configuration. The current
`vercel.json` daily WhatsApp inbox cron is not a reminder tick scheduler. No cron,
provider setting, account scope, billing setting, consent or persistent activation
was changed during this QA work.
# Implemented disabled local candidate

Approved server snapshots additionally require a concrete immutable approval
revision and exact configured WABA/phone-number account binding. Missing WABA
configuration, revision or mismatched account blocks dispatch. These metadata
assertions still require the future approved-template registry gate; they are
not a claim that a fixture template has Meta account approval. Eligibility is
deliberately restricted to `sent` receivable invoices. The `overdue` enum and
other statuses are unsupported by this candidate until separately reviewed.

`automation/whatsapp/cloud-reminders.mjs` now exports
`createFirstPartyReminderProvider`. It is intentionally absent from the provider
factory and runtime selection. All three outbound/reminder flags must be true;
the existing fixed QA contacts intersect the configured test allowlist. No
configuration or credentials were installed. Server construction fixes the owner,
workspace and immutable template snapshot. Only `UTILITY`, `APPROVED`,
`first_party_invoice_reminder` snapshots qualify. The six supported parameters
are current business name, customer name, saved invoice number, remaining amount,
currency and due date. The rendered body must exactly equal both the caller's
body and persisted owner-reviewed body. No arbitrary text transport is exposed.

The candidate requires **new** RPC `cetld_core_authorize_first_party_reminder`
with `p_owner_id`, `p_workspace_id`, `p_claim_id`, `p_snapshot` (JSONB), and
`p_snapshot_hash` (SHA256 of JSON serialization). Snapshot fields bind invoice,
customer, phone, reviewed body, invoice version/update timestamp, preferences
timestamp, consent ID/creation timestamp, and template name/language/body/ordered
parameters. An authorization receipt must return `authorized:true`, the exact
`snapshot_hash`, and a durable opaque 64-hex `callback_token`. Missing RPC,
database error, denial, or mismatched receipt blocks HTTP. This RPC is absent in
all deployed migrations; no fallback to existing consent or core authorization
is allowed. The existing core gate remains necessary and the new gate must
require its scoped, unexpired `sending` claim/token and invoice version.

Future production DDL must atomically lock and validate owner/workspace ownership,
claim/lease/version, invoice eligibility/payment/deletion/pause, exact reviewed
body/preferences, current customer phone, recipient opt-in/category and global
and workspace suppression. It must validate the configured approved template
against a durable server registry, verify/recompute the fingerprint, reserve one
dispatch per claim/key, and persist the opaque callback correlation. STOP and
gate acquisition need one documented lock protocol so no unprotected sequential
read can authorize a suppressed recipient. Already dispatched HTTP cannot be
recalled; a later STOP blocks future attempts. Only dispatch HTTP follows a
successful final gate, with no intervening asynchronous work.

`tests/fixtures/proposed-reminder-gate.sql` is an **offline-only contract fixture**,
not a migration or proof of production atomicity. It tests deployed rows/stores
and durable one-dispatch reservation under mocked HTTP. It deliberately lacks
deployment role grants, the production global lock protocol, template registry,
fingerprint recomputation, STOP schedule cancellation, lease sweeping and receipt
reconciliation. No fixture SQL should be applied to production.

2xx with a valid provider message ID means accepted, not delivered. HTTP 5xx/408,
lost responses and malformed success receipts are unknown. Confirmed other
non-2xx responses are rejected. Every reserved attempt, including a rejection,
stays nonreplayable until a future durable reconciliation policy explicitly
permits a new attempt. Current engine quarantines uncertainty and retains accepted
receipt/count handling; signed delivery callbacks do not yet reconcile core
claims. The production runtime also currently requires a linked accounting
record/provider to check payment; local-invoice production checks need separate
reviewed implementation. Tests use the existing nonproduction mock payment-check
path with actual core stores and SQL, not production accounting calls.
