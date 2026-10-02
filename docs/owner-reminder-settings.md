# Verified owner WhatsApp, reminders, and Conversations

## Product behavior

Settings contains one owner connection flow: enter your own number including the country code, open WhatsApp, and send the prefilled LINK message. Phone possession is verified server-side. The dashboard updates automatically; no workspace-wide client attestation or manual code field is required. A collapsed fallback explains how to send the message from another device. Setup expires after ten minutes and can be canceled. Disconnecting preserves invoices and conversation history.

The configured business name is required. The verified owner can read all invoices in the same workspace, including invoices uploaded through the dashboard and their actual customer names and individual currencies. Deterministic reads handle invoice lists, status, balances, dates, contacts, and stored files without AI planning. Recent delivered conversation turns provide context; ambiguous invoice references ask for an invoice number or customer name.

Supported edits are total, currency, dates, customer, notes, and invoice number. The bot shows a proposal and requires an explicit confirmation within ten minutes. A payment confirmation records the remaining balance using the existing accounting transaction. Paid and settled invoices cannot be edited through this flow. Invoice versions prevent overwriting dashboard changes. Confirmation receipts bind the outcome to the inbound WhatsApp message, so retries cannot confirm a newer proposal. Tax values from both dashboard and assistant imports are preserved.

Owner uploads reuse the existing durable photo extraction/review workflow and resolve the real invoice customer. Ordinary customer messages remain scoped to their own invoices and cannot create, edit, or confirm invoices. Owner access requires a matching verified phone, actual workspace ownership, owner membership, configured business name, active binding, and absence of suppression. Owner reads and final outgoing claims recheck authorization.

Follow-up preferences control tone, first reminder delay, cadence, allowed weekdays, contact hours in the workspace timezone, maximum reminders, handling after the limit, pausing on replies, and daily dashboard summaries. Paid invoices always stop reminders. Every new reminder draft includes the business name. Changing the name, timezone, or preferences invalidates previous reminder approvals.

A client phone can be saved as a contact without agreement. A separate optional per-client agreement enables that client's eligible invoice updates. Saving a contact does not grant permission to send. STOP remains a phone-wide barrier and cannot be cleared by setup or ordinary dashboard changes.

Conversations shows permanent inbound and outbound WhatsApp history and delivery status, with older-message pagination and refresh while visible. Exact outgoing text is stored before the send claim. Signed provider callbacks reconcile status using saved correlation tokens. Owner and customer audiences remain distinct. History cannot be written from browser clients.

## Release package

Apply these migrations in order, then deploy the corresponding application commit:

1. 20261002020102_owner_followup_conversations.sql
2. 20261002050339_verified_owner_ledger_actions.sql

The second migration records the currently deployed verification schema and functions, replaces the redundant attestation gates, and backfills configured owner numbers only from existing verified, active bindings. It also adds atomic owner confirmation receipts and service-only ledger action functions. Production application of this migration requires explicit approval because it updates existing verified bindings.

Read-only production inspection on 2026-10-02 found the verified test number already linked to the accessible workspace containing the five dashboard invoices. Preserve that workspace. The earlier alternative account contains zero invoices; do not transfer the number or move invoices without resolving the account preference. The requested test reminder name is CETLD test. No account or business-name rewrite has been applied.

Existing collection delivery gates and QA recipient restrictions remain in effect. The Cloud API adapter exposes service replies, invoice update templates, media, and typing indicators; collection reminder dispatch remains separately held. This release does not enable delivery, change Meta configuration or provider secrets, or perform real sends.

## Verification and release smoke checks

Final verification: npm test reported 549 tests, 545 passed, zero failed, and four optional integration checks skipped. Typecheck, JavaScript syntax checks, and git diff --check passed. The independent review found no remaining actionable blockers.

Checks include owner/customer scope tests, full ordered migration chain in PGlite, phone possession and direct-setting forgery denial, atomic payments and edits, tax preservation, stale invoice rejection, confirmation replay, revocation, setup component behavior, immediate connected-phone refresh, cursor pagination retaining older messages, and callback history correlation. A legacy-schema upgrade regression preserves the existing verified proof and binding.

A local owner-handler read using the five actual production invoice rows confirmed the existing identifiers, customers, and stored currencies. This did not invoke an AI provider, write production data, or send WhatsApp messages.

Authenticated browser rendering and deployed WhatsApp behavior remain release smoke checks. After approved migration/deployment, verify signed-in setup, owner greeting, invoice list and file lookup, one explicitly authorized test correction/payment, Conversations synchronization, and provider receipt status. Keep real test sends limited to the approved test number. Local browser opening was denied during this session; component checks are not browser-rendering evidence.
