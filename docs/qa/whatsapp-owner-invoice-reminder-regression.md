# Owner invoice and immediate reminder regressions

The invoice parser now accepts both `new invoice QA-REPRO-001, QA Repro Customer, Rs 1,500, due 25 Oct` and `new invoice QA-REPRO-001 for QA Repro Customer, Rs 1,500, due 25 Oct`. Both use the same amount, date, authorization and persistence validation. The supplied number retains the existing source-number semantics; generated cetld invoice numbers are unchanged.

Production logs inspected on 22 October 2026 identify a model argument transport failure, followed by exhausted reply repair. Trace `093f4d9470dce0ba` on deployment `dpl_6eVi1AS84KtHNmoarxihLogpbyTj` attempted `sendReminderNow` six times. The logged filter containers were strings containing JSON arrays, including a single `invoice_number eq` target. Each attempt failed `INVALID / FILTER_SHAPE` before reminder dispatch. The two final drafts then failed `fresh_database_read_required`. All model requests completed successfully, and context reads completed in under 500 ms. This trace supports malformed nested arguments as the cause, rather than a cold-start timeout or stale invoice read.

Reminder preparation now decodes a bounded JSON array once and validates exactly one equality filter on `invoice_number`, `id` or `customer_name`. It preserves the chosen target and does not remove extra filters or replan them. Multiple, malformed, empty or unsupported targets return an explicit request for one invoice number before dispatch. Protected identities and other operations retain their existing validation.

After preparation, the owner agent uses the existing server-rendered preview or specific refusal directly. This avoids another model pass that could obscure a missing phone, missing consent or ineligible draft invoice behind a generic reply-repair failure. A preview still requires later confirmation.

Regression coverage:

- `tests/text-invoice.test.mjs`: both number phrasings, shared amount/date validation, direct and confirmation adapters, protected fields and authorization.
- `tests/text-invoice-native-sql.test.mjs`: original text through the handler, SDK, SQL and durable replay; exact source numbers and amounts.
- `tests/owner-reminder-transport.test.mjs`: typed and serialized targets, malformed and multiple targets, one-call specific failure, authorization and scope checks.
- `tests/owner-chat-reminders.test.mjs`: create an invoice, immediately request “send him a reminder to pay” with serialized model filters, then verify specific contact/consent/draft refusals and an eligible preview. It asserts no customer sends, no invoice approval or queue change from preparation, and no second model call.

No reminder send gates, scheduler, consent gate, compliance wording, templates, accounting integrations or SQL migrations are changed.
