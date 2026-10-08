# Owner payment proposals

An explicit current instruction can prepare one payment proposal for a matching invoice, amount and currency. The owner must confirm it in a later turn. Completion requires a durable receipt and independent ledger readback.

Payments are separate from ordinary batches. Unsupported or ambiguous requests, unavailable database support, and uncertain write results do not cause a full settlement or another write. Customer messages remain off.

The database migration requires separate approval before production application. The runtime refuses amount proposals until the corresponding database support is available.

Native runtime and database regressions cover both supported instruction forms, single-operation planning repair, confirmation, replay, readback failure, tenant isolation, existing payment history and older database schemas. The full release gate must pass on the final published commit before merge.
