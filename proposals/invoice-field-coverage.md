# Invoice field coverage audit

Local review of deployed 970c43c plus the candidate fixes; no live model calls or financial mutations. Broad custom business data is supported through validated `custom_fields` and `business_records`, but this is not unrestricted invoice editing.

| Field or action | WhatsApp owner interface | Dashboard / important limit |
| --- | --- | --- |
| Invoice number | Read, ordinary update with unique-label and payment/state guards; create uses actual workspace numbering | Saved label comes from the numbering trigger. Attachment override proposal supports AUTO/workspace convention only, retaining printed source number and audit. Arbitrary new numbering patterns are unsupported. |
| Issue date / due date | Read, create, update; relative dates use owner's timezone | Dashboard displays saved issue date and due date. |
| Currency / total | Read, create, ordinary update with amount precision, ledger and payment guards | Cannot reduce total below recorded payments or change currency across payment facts. |
| Notes | Read, create, update | Same persisted notes. |
| Paid / unpaid | Paid records remaining balance via payment RPC. Unpaid with actual payments prepares later-confirmed immutable reversals; original receipts remain | No cash refund, payment deletion or arbitrary amount_paid/status overwrite. Already-unpaid is read-only. |
| Customer name / email / phone | Read/edit the scoped customer record; invoice creation can resolve/create customer | Invoice customer reassignment is not supported by generic invoice update. Existing metadata copies may be historic extraction facts, not current contact facts. |
| Subtotal / tax | Creation and missing attachment review facts only | Ordinary invoice update does not accept these fields. Dashboard stores tax_minor metadata; create/review stores tax/subtotal, so conventions are not fully aligned. Do not claim full tax edit parity. |
| Line items | Missing attachment review facts only | Ordinary invoice update and generic invoice creation do not accept line_items. Dashboard retains extracted items but offers no item editor. |
| Invoice direction | Missing attachment review facts only | Generic create does not accept direction; current dashboard save accepts issued receivables. Payable editing is not implemented. |
| Seller/buyer names, payment instructions | No ordinary generic edits | Dashboard extraction metadata retains these; hidden form fields do not provide a general editor. |
| Custom business facts | Read/create/update flat typed scalar fields, merged on update; protected system/security names rejected | Both invoice and customer fields are shown. No DDL, arbitrary metadata or credentials exposed. |
| Delete / restore invoice | Existing guarded lifecycle, reminder cancellation, recovery window | No physical invoice or payment deletion; existing payment audit remains. |
| Payment amounts, reversals, reminder/consent/security state | Dedicated audited domain workflows only | Cannot be bypassed by custom fields, batch, invoice metadata or direct model credentials. |

Remaining work for full invoice parity needs a separately reviewed generic invoice patch schema with typed business metadata, shared dashboard representation, customer binding/ambiguity checks, payment/currency integrity and reminder invalidation. Expanding arbitrary metadata or declaring unsupported fields editable would be unsafe. This audit proposes no production migration or additional activation.
