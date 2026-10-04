# Disabled reminder durability implementation proposal

Local review only, based on candidate `d9030ab2`. Preserves ready reminder commits
`dab8aaa6` and `83109b05`. No production apply, sender selection, template
installation, credentials, scheduler, recipient sends or publication occurred.

Exact proposed DDL lives in `20261004_disabled_first_party_reminder_durability.sql`,
outside `supabase/migrations`. It adds three private tables (immutable reviewed
template revisions, one dispatch reservation per core claim, append-only receipt
events), four service-only RPCs and guarded STOP/consent hooks. It also replaces
the existing claim/authorization function bodies, retaining their signatures and
service-only grants, to coordinate phone -> invoice -> claim locking with STOP.
It changes no invoice/payment schema or financial records. If applied later,
STOP cancellation affects matching approved receivable schedules and claims.

The template registry accepts separately reviewed database-admin inserts only;
service-role/API/model code cannot add approvals. Each approval binds actual
owner/workspace, WABA, sender phone ID, name, language, immutable revision and
body. Approval-reference and approval time are required. An approved revision
can be disabled but cannot be changed or reenabled. A new approved revision
requires a new reviewed insert. Fixture approval references are not Meta approval.

Final dispatch authorization takes the existing consent/STOP phone advisory lock
and invoice/claim locks, then rechecks actual ownership, customer and current
phone, recipient opt-in/category, global/workspace suppression, claim token/lease,
invoice version/update timestamp, preferences/review version, receivable direction,
sent status, unpaid amount, local window, maximum reminders, registry revision/
account/body and factual parameters. It independently rerenders owner-reviewed
copy and verifies the canonical JSON SHA256 fingerprint in PostgreSQL. It reserves
exactly one opaque callback token per claim; even confirmed failures do not
automatically reuse that intent. There are no credentials in snapshots or audits.

The local payment RPC/checker locks the actual scoped invoice, requires receivable
direction, computes payments minus exact immutable reversal allocations, and
requires the result to equal amount_paid. It changes no payments or balances.
Externally linked ledgers fail closed with external-accounting-required; this
proposal does not replace existing remote accounting verification. The production
runtime has not been wired to select this checker or the durable provider.

Existing STOP RPCs retain their consent/confirmation/replay behavior. Added
suppression/consent hooks pause only matching active unpaid receivables and clear
future schedules; pending claims cancel, already-authorized sending claims
quarantine because HTTP might be in flight. They retain financial facts. Matching
already-reserved old recipient phones are included even after customer contact
changes. Current customer phone is authoritative in CoreAutomationStore; null
cannot recover an old invoice or original metadata phone. Owner resume never
restores consent or clears suppression.

`reminder-receipts.mjs` exposes an optional explicit disabled receipt store and
durable provider wrapper. Its flags are `WHATSAPP_REMINDERS_ENABLED` AND
`WHATSAPP_REMINDER_RECEIPTS_ENABLED`, neither configured here. The existing signed
Meta webhook filters WABA/phone IDs before the optional inbound receipt store.
Opaque correlation resolves tenant/claim on the server, then validates account,
recipient and provider ID. Wrong signatures, accounts, recipients and tokens
cannot reconcile. Duplicate/out-of-order success receipts remain monotonic; a
failed receipt after accepted HTTP is recorded as failed, while conclusive
delivered/read receipts win over later stale failures. Accepted attempt counts
stay once, never undo payments or imply customer delivery from HTTP alone.

The optional engine finalization path runs only for an explicitly supplied
durable provider. Receipt/count/cadence commit atomically in SQL and the engine
does not repeat its normal separate count CAS. This handles signed delivery
arriving before the HTTP response. Lost committed responses remain quarantined
to the caller until verified; callbacks recover without resending. Payment,
pause, STOP, edited facts and changed preferences are preserved. Deleted invoices
are not updated by receipt reconciliation. Expired sending claims quarantine
both before and after reservation; neither state is blindly retried. The sweep
RPC is not scheduled or invoked by production runtime in this proposal.

Offline tests execute this exact proposal SQL with all candidate migrations,
real Supabase SDK, real CoreAutomationStore/engine and local checker, actual
signed webhook/inbound receipt path and mocked Graph HTTP. Privilege tests deny
anon/authenticated execution and private data access, deny service approval
writes, and exercise positive full engine execution as service_role. Other cases
cover tenant isolation, STOP, live changes before dispatch, fingerprint/registry
tampering, ledger/reversal consistency, cleared phones, lease interruption,
early callbacks and lost receipts. The earlier fixture-only gate is not used by
these tests. PGlite serializes SQL on one connection: concurrent promise calls
and injected interleavings prove reservation/state behavior but are not a
multi-session PostgreSQL contention stress test.

Before any activation: review/authorize the exact DDL hash; run multi-session
PostgreSQL lock-contention tests (no local native server was available here);
choose reviewed local versus external payment verification; wire the explicit
durable provider/checker/receipt store and lease sweep; extend build manifest
coverage; obtain actual account template/use-case approval; separately authorize
configuration, scheduler and a controlled QA send. HTTP and SQL cannot be one
transaction: a STOP committed after reservation can block future sends but
cannot recall an already-dispatched message. The existing factory, sender hold
and scheduler configuration remain unchanged.

The current Graph payload includes template name/language and ordered parameters;
the local approval revision and fingerprint are not a remote conditional version
in that request. Authorized live verification must confirm the actual account's
template content before activation. Operations must disable the local registry
before changing remote template content and review a new local revision. This
offline implementation does not prove provider-enforced template revision CAS.
