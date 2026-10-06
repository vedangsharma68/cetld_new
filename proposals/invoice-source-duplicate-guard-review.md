# Invoice source duplicate guard — installation review

Prepared for separate production approval; not applied. SQL SHA-256: `254c9ecfbc0d5b9ba9f909540bb9bd04591d84b0513b73da4d1feb3d5d5322db`.

Exact SQL: [20261006163837_invoice_source_duplicate_guard.sql](../supabase/migrations/20261006163837_invoice_source_duplicate_guard.sql).

The store checks an active source invoice within the verified workspace and resolved customer before saving a new upload. An already logged source is refused with a meaningful reply; its financial state is never reused or overwritten. Missing source numbers and `AUTO` remain supported. Provider-message replay continues to reconcile the original persisted receipt.

The migration installs one invoker trigger helper and one BEFORE INSERT / restore trigger. An explicit printed/source invoice number activates the guard. It acquires the existing invoice-numbering workspace advisory lock before looking for an active invoice with the same source identity and customer. A conflicting restored invoice is also refused. The same assistant save key remains eligible for normal idempotency handling. The helper has no callable application-role privileges; tenant access remains governed by existing roles and policies.

Installation changes no existing invoices, files, payments, numbering, grants or customer messages. Historical duplicates remain untouched. The guard is not a fuzzy content matcher: invoices lacking a source number remain outside its scope, and source number comparison is exact. Rollback consists of dropping the new trigger and helper; it permits future source duplicates and does not reconcile existing rows.

Six store/SDK/SQL regressions cover new-message reuploads, customer/workspace boundaries, source-number audit, AUTO/missing numbers, historical duplicates, stale application checks and delete/restore conflicts. A full default owner-handler regression confirms a second provider upload yields no second invoice or file. Lifecycle errors identify a duplicate restore safely.

`node scripts/verify-invoice-source-concurrency.mjs` additionally passed the complete migration chain on pinned PostgreSQL 17.6 and two independent SQL sessions: the second source insert waited on the advisory lock, then refused the duplicate after the first committed; exactly one invoice and zero payments remained. This explicit verification needs the pinned Docker image already cached, exposes no host ports and removes its private container.
