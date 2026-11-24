# Lifecycle migration work map

Source inspected: retained `supabase/migrations/20261002090000_invoice_soft_delete.sql`, especially lines117-225,244-535,856-938. This is source evidence, not a claim about current deployed function bodies.

## Required behavior, not yet implemented

- Invoice hard delete is prohibited while its business exists, even for unpaid invoices. Candidate hard delete currently conflicts with this and must not become the imported-record path.
- Lifecycle caller must be business owner and have owner membership. This restriction belongs to lifecycle only. Do not change ordinary customer CRUD membership access.
- Prepare is idempotent by business, owner and key; one pending proposal per owner/business; expires in ten minutes by database time.
- Proposal snapshots invoice updated_at, number, customer, total/currency/status and payment/reminder risk. Confirm must reject stale invoice/risk snapshots.
- Payment risk includes positive balance paid, paid status, or any payment ledger row. Reminder risk includes sending/sent/quarantined claims and accepted/sent/delivered/read/unknown customer reminders.
- Exact case-sensitive DELETE plus invoice number is required when payment/reminder risk exists. Otherwise trimmed case-insensitive yes is accepted. Pending dispatch in sending state blocks deletion.
- Confirm soft-deletes with owner attribution, cancels follow-up state and next date both as fields and metadata, cancels claimed/failed dispatches, blocks pending reminder messages, consumes pending invoice actions. It retains financial records and files.
- Payment requests must reject deleted records before idempotency lookup. Void/cancelled/paid are terminal for new payments. Draft is allowed. Full settlement marks paid and cancels reminder metadata; partial settlement preserves prior legacy status.
- Deleted invoice/payment/file reads and modifications must be denied outside the owner restore flow. Signed URL lifetime and restore-safe file retention need explicit handling.
- Undo/cancel branches and service-message proof rules still require full mapping beyond the portion inspected this run. Do not infer them from confirm.

## Next implementation order

1. Preserve full invoice/customer financial and lifecycle state in additive schema, distinguish upload state from business state and retain updated_at revision semantics.
2. Implement owner proposal/cancel/confirm/undo transaction boundaries and risk provider interface. Fail closed when required reminder state cannot be established.
3. Replace preview DELETE with prepare/confirmation/restore UI, including mobile card layout. Do not combine reversible soft-delete with storage cleanup intended for permanent hard deletion.
4. Test races: payment or reminder acceptance after prepare; active dispatch; replay after deletion; expired proposal; wrong owner; stale revision; repeated confirmation; restore and retained PDF; financial immutability.
5. Map imports and reminder integration before any production cutover. Existing native synthetic payment/import tests are only slices.

## Cancel/undo source continuation, lines548-684

- Cancel checks owner/business/actor proposal, pending state, expiry and distinct service request proof. Cancel replay binds stored cancellation message ID.
- Undo requires exactly one of invoice UUID or invoice number and valid idempotency key. It searches only invoices deleted by this owner in this business; ambiguous invoice number fails.
- Undo replay binds invoice selection, actor, idempotency key and service request identity. Service utterance must be an allowed restore/undo phrase for the invoice number, backed by a distinct inbound event after deletion.
- Restore requires the matching deleted proposal and deletion timestamp, within thirty days by database time. It clears deleted attribution but does not resume reminders: terminal/fully-paid stays cancelled, otherwise paused, and next follow-up remains null in both fields and metadata.
- Restore records an idempotent result in the proposal. It never recreates or erases payment history, reopens dispatch claims or resends customer messages.
