# External ledger owner guard: local approval proposal

Base: `78e3c23`. Published migrations remain unchanged. New forward migration:
`20261004217000_owner_external_ledger_guard.sql`. No production application,
provider mutation, credentials, OAuth scopes, activation or publication occurred.

Actual scoped row linkage uses `external_provider`, `external_invoice_id`,
`metadata.accounting_provider` or `metadata.bookkeeping_record_id`. Custom fields
are never authoritative linkage. Owner invoice number/customer/itemization,
subtotal/tax/discount/amount/currency/direction corrections and new local payments
are refused with `EXTERNAL_ACCOUNTING`. Dates/notes/custom business annotations
remain local. The catalog and refusal do not claim remote writeback or a pending
confirmation. Direct and native-button failures suppress pending reply/buttons.

The checked forward patch preserves installed function ACLs while guarding the
typed correction helper, public direct engine, private batch copy, payment RPC,
legacy owner confirmation and reopening. A separate authenticated invoice UPDATE
trigger prevents raw dashboard financial/linkage bypass. Service authoritative
invoice PATCH remains available; it is not globally blocked by the owner guard.
The existing settlement/history/math guards still apply to provider changes.

The global payment trigger permits an external receipt only when the actual
service SQL role supplies the actual invoice provider (`zoho_books`/`quickbooks`),
nonempty invoice and payment external IDs, and matching
`payment.metadata.external_invoice_id`. Explicit payable is always refused.
Historically unknown direction can accept this aligned incoming proof without
reclassifying any invoice or rewriting its source. Unaligned imports and local
new payments fail closed. The deployed exact historical local payment replay
branch precedes the new local-payment refusal. Existing external receipts are
preserved by the separate accounting-store integrity checks.

The source migration chain explicitly grants selected private helper EXECUTE to
the backend but lacks app schema USAGE for its invoker currency trigger. This
proposal grants **USAGE only** on schema app to service_role. It grants no CREATE,
private table access or blanket EXECUTE; new private helpers remain revoked.
This is a source-chain compatibility correction, not a claim that production
currently lacks the grant. The exact DDL grant requires migration approval.

Focused evidence: three actual all-migration SQL cases cover four linkage
signals, zero-payment repricing, dashboard raw/RPC denial, scoped benign saves
and replay, mixed batch rollback, direct/native legacy paid/financial rejection,
exact local receipt replay, unknown aligned imports, payable denial, bookkeeping
reopening refusal, helper EXECUTE and schema CREATE denial. The real accounting
store test runs every mocked HTTP request under `SET ROLE service_role` and
proves a first new receipt on historical unknown direction, source retention,
exact immutable replay and owner/conflicting-receipt rejection. Supabase public
table service defaults are represented by isolated fixture grants; app USAGE
comes from the actual migration. Runtime tests cover guarded preflight without
protected-field output or writes and native blocked confirmation without buttons.

No live provider end-to-end proof or native multi-session lock test is claimed.
Remote writeback remains unavailable through generic owner tools; supported Zoho
provider operations need a separately approved durable outbox/reconciliation
workflow. QBO remote owner writes remain unsupported. Existing 210 benign
corrections stamp an internal `bookkeeping_sync_status=pending` marker; that
marker is not proof of a durable queued remote task. An authoritative refresh may
replace locally annotated provider dates/notes. A future change should reconcile
that marker and annotation persistence explicitly.

Dependencies used for offline validation (root integrates separately): UI helper
`9bb09a49`, SQL portability `e51f361`, accounting store `0aef709`.

Final focused validation: 3/3 SQL cases, 41/41 runtime/store tests, typecheck,
and `git diff --check` passed. Logs in the task root are
`external-ledger-sql-focused-final.log`,
`external-ledger-runtime-store-final.log`, and `external-ledger-typecheck.log`.
Canonical LF SHA256 of `20261004217000_owner_external_ledger_guard.sql`:
`70ba16a91fe98a877c2cdcdef1166be03db9848764836d69515544fbba4a257b`.
No production migration, deployment, provider call, or business-data mutation
was performed. The combined candidate aggregate gate belongs to the parent.
