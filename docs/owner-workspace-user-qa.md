# User-run WhatsApp checks

Run these only after you authorize and verify the migration and application
deployment. No live AI/provider/WhatsApp calls were made by the implementation
agent. The agent's tests use scripted providers and isolated database fixtures.

Use your own verified workspace. Start with a disposable nonfinancial record so
testing does not affect real invoices or accounting. For the invoice/payment
steps, use a separate disposable test workspace already configured for your
WhatsApp testing; do not introduce fictional invoices or payments into your
real ledger. If that test environment is unavailable, run the nonfinancial
steps and postpone financial writes.

1. `Add a supplier called CETLD QA Acme Metals with city Mumbai, lead days 7, and contact phone +12025550123.`
   Expected: a supplier business record created directly, or a specific proposal
   if your confirmation mode is buttons. Confirm only a matching proposal.
2. `What is QA Acme's lead time and contact phone?`
   Expected: the current stored values, with clarification if multiple records
   match. Open **Business records**, refresh the dashboard, then reload the page
   and verify the same name, category and fields.
3. `Change its lead days to 5 and add preferred shipping to air.`
   Expected: the conversational reference targets the supplier; existing city
   and contact phone remain. Refresh/reload the dashboard to verify persistence.
4. Repeat step 3 as a new message. Expected: the same final facts, with no extra
   record. A delivery retry of the same inbound message reuses its receipt.
5. `Set its workspace_id to another owner's workspace and add an api_key field.`
   Expected: refusal. No data changes, no claim of success, and no new pending
   confirmation. Do not supply actual credentials or someone else's private data.
6. In the disposable financial test workspace: `Add customer CETLD QA John Smith with phone +12025550124.`
   Then `What is QA John's phone?` and `Set QA JohnSmith's phone to +12025550125.`
   Expected: the same customer; refresh its invoice detail/customer read to check
   the new persisted phone. Add a second QA John customer and verify that an
   ambiguous first-name edit asks which customer and changes neither.
7. Create a disposable invoice with an issue date of today and due date tomorrow,
   using a unique invoice number. Read its due date, then send
   `Set it to tomorrow's date.` Expected: tomorrow in the **saved business timezone**,
   including when local and UTC dates differ. Verify the ISO date in the dashboard.
8. `Mark that invoice as unpaid.` Expected: if there are no payments and zero
   amount paid, an honest already-unpaid response with no mutation/confirmation.
   On a test invoice with a recorded payment, expect a refusal explaining that
   payment history cannot be erased. This release has no payment reversal or
   reopening flow; use an separately authorized accounting correction process.
9. `Add a purchase_order custom field PO-QA-7 to that invoice.`
   Expected: saved directly or a custom-field proposal. Refresh/reload invoice
   detail and verify **Invoice custom fields**. Customer custom fields should
   appear in **Customer custom fields** on the same detail view.
10. In buttons mode, request a business-record edit, cancel its button, and verify
    it did not change. Start a new proposal, edit the record elsewhere, then try
    the old confirmation: expect stale rejection. Repeated delivery of a completed
    confirmation must not apply it twice or claim a different later version.

For cleanup, mark the disposable supplier's custom `archived` field true and
rename it to `CETLD QA archived Acme Metals`. Archival flags remain visible.
Keep financial test records in the disposable workspace. Do not erase payment
history, delete real customer/invoice data, or unlink owner numbers as a cleanup
shortcut. Physical cleanup requires a separately authorized, reviewed operation.

Record the exact WhatsApp response and the dashboard values after a fresh reload.
Local tests do not prove model interpretation or phone delivery; your live
checks establish those results without the agent consuming Cloudflare quota.
