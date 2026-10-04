# Invoice field coverage for the local owner-assistant candidate

The local implementation extends the typed workspace catalog and uses scoped server RPCs. The model supplies business operations and values; authenticated server context supplies the owner and workspace. This file describes local code, not a production verification.

| Field or action | WhatsApp owner interface | Dashboard / important limit |
| --- | --- | --- |
| Invoice number | Read, ordinary update with unique-label and payment/state guards; create uses actual workspace numbering | Saved label comes from the numbering trigger. Attachment override proposal supports AUTO/workspace convention only, retaining printed source number and audit. Arbitrary new numbering patterns are unsupported. |
| Issue date / due date | Read, create, update; relative dates use owner's timezone | Dashboard displays saved issue date and due date. |
| Currency / total | Read, create, typed correction with amount precision and ledger guards | Any payment or reversal history blocks financial correction; monetary components and saved line items must reconcile. |
| Notes | Read, create, update | Same persisted notes. |
| Paid / unpaid | Paid records remaining balance via payment RPC. Unpaid with actual payments prepares later-confirmed immutable reversals; original receipts remain | No cash refund, payment deletion or arbitrary amount_paid/status overwrite. Already-unpaid is read-only. |
| Customer name / email / phone | Read/edit scoped customers; invoice creation can resolve/create a customer | Existing invoices can reassign to one existing own-workspace customer by explicit selection or unambiguous John / JohnSmith resolution; current contacts are authoritative, source retained. No implicit shared customer rename. |
| Subtotal / tax / discount | Scoped reads and typed existing-invoice correction | Shared canonical/legacy-minor display; subtotal plus tax minus discount equals total. Source minor fields remain in history. |
| Line items | Read saved items; attachment review retains its create path | Existing invoices have typed item editors in WhatsApp direct mode and dashboard. Quantity/price and subtotal reconciliation enforced. Ordinary generic creation retains its existing basic field limits. |
| Invoice direction | Read and typed correction without payment history | Payable and unknown direction block incoming-payment and collection controls. Ordinary creation retains its existing receivable path. |
| Seller/buyer names, payment instructions | Read and bounded nullable text correction | Same persisted business projection in dashboard; raw source and system metadata stay private to the server. |
| Custom business facts | Read/create/update flat typed scalar fields, merged on update; protected system/security names rejected | Both invoice and customer fields are shown. No DDL, arbitrary metadata or credentials exposed. |
| Delete / restore invoice | Existing guarded lifecycle, reminder cancellation, recovery window | No physical invoice or payment deletion; existing payment audit remains. |
| Payment amounts, reversals, reminder/consent/security state | Dedicated audited domain workflows only | Cannot be bypassed by custom fields, batch, invoice metadata or direct model credentials. |

The authenticated dashboard correction RPC uses partial patches, CAS and stable request identity. WhatsApp direct corrections verify the current scoped persisted row and immutable correction audit before reporting completion. Interrupted calls recover the same receipt; a later changed row prevents treating the old result as current. Financial and recipient corrections invalidate reminder review; sending or quarantined claims must be reconciled first.

Externally managed invoices use their authoritative accounting workflow for financial changes and settlement. Generic local corrections cannot silently change their totals, currency, customer, numbering, itemization or classification. Benign local text/date/custom-field changes remain separate. Trusted provider imports preserve source metadata and canonical workspace numbering, validate owner scope, and retain exact existing receipts rather than overwriting financial facts. New provider invoices are receivable; aligned historical provider imports preserve missing direction without reclassifying stored history. Conflicting historical financial facts or explicit payable classification require reconciliation.

Remaining limits: ordinary invoice creation and manual dashboard creation retain their existing field entry paths and do not have the expanded typed item editor used for existing invoices. Outgoing supplier-payment recording needs a separate domain workflow. Historical local invoices with unknown direction and payment history need reviewed classification remediation before new local incoming payments. Extended typed corrections are single-invoice direct operations; batches retain their existing catalog and server integrity guards.

No model can overwrite amount_paid, raw metadata, payment/reversal records, consent, security state, arbitrary schema or credentials. Proposed SQL and browser/runtime changes require coordinated review and explicit authorization before migration or publication. Sender activation and real outreach remain separate and disabled.
