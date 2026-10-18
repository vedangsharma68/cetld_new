# Approved invoice reminders and debtor tone

Normal first-party invoice reminders use the Meta-approved English Utility
`cetld_invoice_details_*_v1` templates. Gentle and relaxed map to relaxed; firm
maps to firm; professional, missing workspace tone, or an unknown workspace tone
map to professional. A non-null `customers.reminder_tone` overrides workspace
`follow_up_preferences.tone`, including legacy workspace selections. Invalid
customer tones are rejected by both the SQL constraint and the sender.

In an invoice drawer, choose **Customer reminder tone** to set or clear the
customer override. **Use workspace tone** saves SQL NULL. Changes affect all
invoices for that customer and pause existing approvals for review.

The old four update/gentle entries and their original three-parameter selector
remain unchanged. The existing `templateButtons: true` setting still selects the
legacy button variant when there is no debtor override. An explicit legacy
`follow_up_preferences.templateName` can select any of the four old names. The
isolated scheduled owner-test path retains its original selector and parameters.
The ordinary exact-match diagnostic continues to reject legacy button variants
without exact approved button evidence, as before.

The new five parameters are first name (trimmed first token, or `there`), business
name, invoice number, outstanding balance, and due date. INR is the default when
invoice currency is absent, formatted as `₹12,500` or `₹12,500.50`. Other invoice
currencies use their ISO code and two decimal places, e.g. `USD 12,500.00`.
Balances use decimal minor-unit arithmetic. Dates use `DD Mon YYYY`: timestamps
are converted to the workspace timezone; SQL DATE values are already workspace
calendar dates and are never shifted through UTC midnight. Parameters containing
braces, line breaks, control characters, empty text, or more than 256 JavaScript
string units are refused. Neither template prose nor template names are generated
by the model at send time.

## Human rollout

Review and apply these migrations in order after the current live test window:

1. `20261018060000_customer_reminder_tone.sql`
2. `20261018060100_invoice_details_templates.sql`

The second requires the existing `20261005070000_approved_whatsapp_reminders.sql`
predecessor. Its patches abort on unexpected gate definitions. They retain
consent/suppression, workspace ownership, payment checks, snapshot hashing,
reservation, idempotency and receipt handling. The customer lock precedes the
invoice lock to match tone-change invalidation. The catalog keeps the four old
rows and adds three immutable approval revisions for WABA `1734116767674237`.

The PR branch disables its own automatic Vercel preview deployment through
`git.deploymentEnabled`; other branches retain their existing behavior.

This change does not enable flags, change sender configuration, create consent,
schedule a live reminder, or deploy anything. Tests use disposable in-memory
PostgreSQL and injected Graph responses; no connected database migration or live
WhatsApp test is performed. Run the read-only template diagnostic and a separately
authorized live send test only when the owner chooses to do so after rollout.
