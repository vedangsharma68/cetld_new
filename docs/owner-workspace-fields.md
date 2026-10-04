# Owner business data and custom fields

The WhatsApp owner assistant continues to use one `workspaceData` tool. It can
read, create and edit supported business records using a structured operation
or a natural-language request translated against the server catalog. The model
never receives a database credential or a DDL operation.

Owner-defined categories use `business_records`, a fixed workspace-scoped table
with a `record_type`, `name`, and `custom_fields`. Examples include suppliers,
projects, inventory items, expenses as notes, equipment, orders, and business
tasks. Adding a category or field does not alter the shared database schema.
The dashboard Business records page reads this same persisted storage under
authenticated owner RLS. Creation and edits work in direct and confirmation
modes, using existing action receipts. These records do not post transactions
to the invoice/payment ledger or update an external accounting provider.

Customer and invoice names are resolved in the verified owner's workspace.
An exact match takes precedence; a bounded fallback normalizes spaces and case
so `John`, `John Smith`, and `JohnSmith` can find the same record. Writes require
one match. Multiple matching customers or invoices require clarification. The
fallback refuses a truncated candidate set above 500 records. Reads can return
multiple matching records. Conversation history provides reference context;
current database results provide facts and success evidence.

The saved business timezone supplies today, tomorrow and yesterday to both
the chat model and the operation planner. Relative date values are resolved by
the server. A single date edit explicitly requesting tomorrow is also resolved
from the owner's message, preventing a stale model-generated calendar date.

`status: "unpaid"` is a payment-fact check, not a payment reversal. An invoice
with no recorded payment, zero amount paid and a draft/sent/overdue status is
already unpaid, so the result says no change was made and requests no
confirmation. Paid, partially paid, void/cancelled invoices, or invoices with
payment rows are refused with `PAYMENT_GUARD`. There is no supported WhatsApp
payment correction or reopening operation. Review recorded payments and use an
authorized accounting correction/reversal process first; this change does not
implement or authorize that process. Failed writes cannot create a proposal or
justify an awaiting-confirmation claim.

`customers.custom_fields` and `invoices.custom_fields` hold extension facts.
Keys are lowercase snake_case, up to 64 characters. Values are text (up to
1,000 characters), finite numbers, booleans or null. Each saved object is limited
to 50 keys and 8 KiB. System, ledger, identity, security and credential names are
reserved. Updates merge supplied keys with existing data; null means not set.
Use `describe` to discover the field rather than adding a command for each key.

Direct customer/invoice creation and updates persist these fields atomically
through the existing message-bound write RPC and receipts. Customer proposals
and invoice custom-field-only proposals support the existing button/later
confirmation flow, expiry and version checks. In button mode, create an invoice
through the normal invoice creation flow, then add its custom fields in a
separate confirmed edit; mixed ledger/custom-field proposal edits are not
supported. Existing payment and invoice accounting guards remain in force.

Custom fields are available in workspace reads and the dashboard invoice detail
shows both its customer custom fields and invoice custom fields, with escaped
labels/values. Dashboard invoice edits preserve these columns. Customers without
invoices remain available through workspace reads; this change adds no separate
customer management page.

| Business area | Supported | Deliberate boundary |
| --- | --- | --- |
| Customers | Read/list, create, edit name/company/email/phone, custom fields; existing safe deletion path | Linked owner/security contact protected; customers attached to invoices cannot be deleted |
| Invoices | Read/list, create, edit number/dates/currency/total/notes, custom fields; existing soft-delete/restore | Paid/terminal ledger guards remain; one unambiguous target; invoice custom fields in button mode are a separate edit |
| Payments | Read payment facts; existing verified settlement action | No arbitrary amount-paid edit, payment deletion/reversal or reopening paid invoices |
| Business settings | Business name, currency, timezone, follow-up preferences, assistant preferences | Owner linking/verification/security fields use the dedicated verified flow |
| AI settings | Read/update approved model selections | Credentials and arbitrary provider settings are inaccessible |
| Files | Existing attachment analysis/review/save and invoice file send | No arbitrary storage path or unrestricted file mutation |
| Other business categories | Read/list/create/edit names, categories and flexible custom fields; dashboard display | Informational records; no stock movement, expense posting, tax calculation or accounting-provider write inferred from a field |
| New business record removal | Set an `archived` custom flag or rename a disposable record | No new physical business-record deletion API; archive flags remain visible |
| Other owners/workspaces | None | Scope supplied by authenticated server context; cross-tenant calls rejected |

The broad interface manages supported business data rather than granting a model
unlimited access to every shared-schema table. Auth users, memberships, security
configuration, provider credentials, audit logs and payment facts remain protected.

Apply the forward migration `20261004071329_owner_workspace_fields.sql` before
deploying the matching application code. Its function updates assert their
expected patch points and fail if the installed baseline differs. Do not run it
against production without separate authorization. Local PGlite and scripted
provider tests establish offline behavior; live AI interpretation, deployed
dashboard reload and real WhatsApp delivery still need authorized post-deployment checks.

Local Chrome fixture checks also exercised the actual dashboard module and CSS
with Supabase/auth bootstrap replaced only in the localhost server response.
Business records and invoice detail were inspected at desktop and 390px mobile
widths. Long fields wrap without horizontal overflow; false, zero and null values
remain visible; HTML-like names/values stay literal text with no injected nodes.
A fixture edit survived the real Refresh action and a browser reload, with
Business records navigation restored. All captured database reads included the
workspace filter. Empty records and simulated unavailable storage rendered their
messages; storage failure did not prevent invoice loading. This proves local
rendering and mock persistence, not deployed Supabase persistence or delivery.
