# Paid invoice total corrections — installation review

Status: prepared and tested in isolated PostgreSQL fixtures. This migration has not been applied to production. Its installation requires separate approval.

Reviewed SQL SHA-256: `d4406a4d5e7600368f603ad03dddee1246a1e11b3a231ddcae53a5106194851a`.

Exact SQL: [20261006163000_owner_invoice_total_corrections.sql](../supabase/migrations/20261006163000_owner_invoice_total_corrections.sql).

The owner may correct a local invoice total, subtotal, tax, discount and itemization while keeping all original payment receipts and reversal records. The correction locks the invoice and its payments, verifies net unreversed payments equal `amount_paid`, and writes the existing immutable correction audit with before/after snapshots. Recorded history keeps currency, customer, invoice number and direction fixed. Repeating an unchanged currency in a total correction is allowed. Connected accounting financial edits remain blocked; those corrections must occur in the connected ledger.

Outstanding is `max(total_amount - amount_paid, 0)`. Overpayment is `max(amount_paid - total_amount, 0)`, shown separately in the dashboard, invoice export and owner tool results. The feature never sends money, creates refunds, transfers credit, allocates excess to another invoice, or alters an existing payment/reversal. A monetary correction that becomes fully paid has `paid` status and cancelled reminders. Increasing a previously paid total above its net payments produces an open sent/overdue invoice with reminders paused until a fresh review.

The migration adds a private, inaccessible transaction context keyed by backend PID, transaction ID and invoice ID. Only the existing authorized correction function creates the context for its one update and removes it before returning; custom session settings cannot provide authorization. Original precision checks remain. The original paid-not-above-total check becomes a nonnegative-payment check plus an exact, positive-overpayment projection constraint. Direct unaudited repricing and new overpaid inserts remain blocked by triggers. Existing function privileges are retained and new private helpers/context have no application-role privileges.

It also adds `stale` to the reopening-proposal state CHECK, matching the correction function's existing invalidation behavior. Correcting an invoice invalidates an earlier reopening preview; stale or replayed confirmation buttons cannot reverse payments against the corrected invoice.

Installation performs no business-row backfill, payment/reversal change, external accounting write or customer message. Derived metadata is refreshed only during subsequent local monetary writes; authoritative accounting source metadata is retained; historical rows remain unchanged. Rollback after accepting an overpayment would require explicit reconciliation of affected invoices before restoring the old paid-not-above-total constraint; dropping the forward SQL blindly is unsafe.

Verification uses the actual default owner handler and compact `workspaceData` toolset, Supabase SDK, owner direct runtime, correction RPC, persisted readback and immutable audit. Isolated cases cover partial/full/reversed payments, corrected amount increases/decreases, unchanged currency, exact replay, stale buttons, subsequent nonfinancial changes, itemization consistency, tenant/auth guards, external accounting refusal and forged session-setting/private-context denial. Source document facts and payment/reversal row snapshots are compared before and after.

Run the focused regression with:

```sh
node --test tests/invoice-total-correction-sql.test.mjs tests/invoice-correction-ui.test.mjs tests/invoice-clear-itemization.test.mjs
```
