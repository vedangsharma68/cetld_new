# Dashboard invoice corrections

Local candidate only; requires the separately reviewed `owner_correct_invoice` migration. Do not deploy this UI without that RPC.

Existing invoice edits use the authenticated owner RPC with workspace/invoice scope, expected updated timestamp, a request UUID and a typed changes-only patch. A successful result must include `ok: true`, `completed: true` and the exact persisted invoice in `record`. An interrupted response retains the request UUID for an unchanged retry. A different patch gets a new UUID.

The correction form covers invoice number, scoped existing customer reassignment, line items, subtotal, tax, discount, total, currency, dates, notes, direction, seller and buyer names, and payment instructions. It does not silently rename or update the selected customer's contact details. Monetary components must be numeric; remove a component with zero and provide a coherent total. Clearing the due date uses explicit null.

Financial/customer/itemization controls are disabled after any original payment, including a fully reversed payment. Server policy remains authoritative. Incoming payment, reminder and template-test controls are limited to receivables; payables and unknown directions cannot start those dashboard actions. Existing payments remain a separate explicit receipt workflow.

`invoice/business-fields.mjs` is a read-only representation shared across consumers. Canonical subtotal/tax/discount take precedence over legacy `*_minor` metadata, while old tax values remain visible. Typed item fields and the original printed number are shown without exposing unrelated metadata. Dashboard row mapping restores actual invoice balances and customer binding after metadata, so cached/extracted copies cannot override current customer or ledger facts.

Original invoice metadata and source documents are not rewritten by this UI. The proposed RPC must preserve them and retain immutable correction history. Original document numbering is displayed independently from the corrected workspace invoice number.

Manual new-invoice creation retains its current implementation. Its ordinary form still lacks this typed item editor and remains receivable-only. Generic custom business fields continue to be shown through the existing field views. No sender activation, production data mutation, migration, publication or live model call is part of this local work.

Offline verification includes real dashboard submit callback execution, request identity after interrupted/repeated calls, persisted-result requirements, field normalization, legacy money display, escaping, scoped customer contact display and payment/direction UI guards. These checks are not a live browser or production end-to-end result.
