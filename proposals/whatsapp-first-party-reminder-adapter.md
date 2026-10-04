# Disabled first-party invoice reminder adapter proposal

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
