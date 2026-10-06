# Nested invoice edit menus — production migration review

Production approval is required before applying this SQL or merging this branch.
Target: Supabase project `mbprssoufdelbszsawwu`, database schemas `app` and
`public`. The SQL changes one existing function in `app` only.

File: `supabase/migrations/20261006172223_owner_nested_edit_menus.sql`

SHA-256: `4bee04c0cba5c7db5623949a9a5b0cd641eb738e7630a7f49468da635f92362e`

## Problem and behavior

The application already generates Amount, Due date and Other fields actions.
Production's `app.owner_next_action_ref_valid(jsonb)` excludes their action
kinds, so the existing WhatsApp receipt CHECK rejects the nested reply. The
handler falls back to text, leaving no usable buttons. This is reproduced with
the default owner handler, real Supabase SDK, full SQL chain and receipt store.

The migration admits only `edit_amount`, `edit_due_date` and `edit_more` as
invoice record choices. It retains exact object keys, the 8 KiB bound, one to
three choices, label limits, UUID and finite timestamp validation. Existing
owner/outbound-only receipt checks, approval separation and function ACLs stay
in place. Runtime signatures, verified owner scope, current-record checks and
expiry still gate the click.

The application permits Edit details for paid invoices as well as draft, sent
and overdue invoices. Amount prompts preserve payment/reversal history and
describe explicit overpayment. They collect input only; subsequent changes
still use the audited correction path from the preceding total-correction PR.
Connected accounting amount changes are directed to the source ledger. Currency
changes after payment history remain blocked. Returning to Edit details uses
the original signed Edit details button and creates a fresh nested receipt.

## Scope and operational implications

SQL performs `CREATE OR REPLACE FUNCTION` in a transaction. There is no table
ALTER, constraint replacement, row update/backfill, table scan/rewrite, trigger,
index, grant, message send or change to any invoice/payment ledger. The existing
function owner and execute ACL are preserved. Installation updates the function
catalog and may wait for conflicting function DDL; it adds no table-level
locking operation. Normal receipt checks call the replacement validator once
committed. Existing valid top-level references remain valid.

This branch is stacked on the total-correction and source-duplicate proposals.
Keep those PR heads unchanged. Apply the three approved migration files in
timestamp order, and merge/deploy only after the approved database changes and
required checks succeed. No production migration has been applied here.

## Rollback

Prefer an application rollback while retaining the expanded validator. Once a
nested reference has been stored, restoring the older validator makes that
existing receipt fail its CHECK on a later row update. Reference expiry does
not remove the stored JSON or solve that risk. An isolated SQL regression
demonstrates this rejection and recovery with the expanded validator.

Restoring the old function would therefore require a separately reviewed receipt
reconciliation plan first. This proposal does not clear references, delete
history or authorize that reconciliation.

## Verification

Regression coverage uses the real default owner handler, SDK and SQL receipt
path: old-validator failure, interrupted-save retry with the same provider
message ID, durable button replay, paid/open nested actions, return navigation,
expiry, changed records, forged IDs, foreign workspace, accounting and currency
guards, unchanged invoice/payment/reversal/audit data during menu clicks,
validator shape/ACL restrictions and the rollback hazard. A paid invoice then
follows the real consolidated tool route to an audited amount correction with
explicit overpayment and unchanged payment history.

The complete migration chain also passes on isolated PostgreSQL 17.6 with two
independent sessions proving the preceding source-duplicate serialization guard.
No live invoice mutation or reminder delivery is used for these checks. Fresh
WhatsApp acceptance remains separate after approval and deployment.
