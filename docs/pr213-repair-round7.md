# PR #213 — repair round 7

Historical evidence for the named round. New publication and worker resume must
follow the current [four-migration readiness contract](signup-invites.md#required-deploy-order-and-mixed-versions), including retirement-progress admission.

Reviewed base: `5474e7fb95c75a9d82748616d19dcd1fbec04c99`.
No production action is performed by this repair.

## Verified causes and mechanism changes

These were gaps in the round-six queue and upgrade integration, rather than
changes to the shipped signup, bookkeeping or canonical privacy policies.

| Finding | Verified cause | Repair | Executable evidence |
| --- | --- | --- | --- |
| P1 E — progress retry stalls inbox | The queue predicate OR-ed the parent due date into the item's deadline; a seen phase broke the whole worker loop; release invented an immediate parent due date. | Each item must meet its own due time. A bounded run-local phase exclusion set prevents reclaiming attempted work. The worker alternates independent delivery work and ordinary inbox claims; a repeated phase is released without terminating the run. Release restores the previous parent deadline. | `pr213-delivery-fairness`: real progress timer, post-claim authority fault, yielded owner work, reconstructed workers, unrelated ready event, unchanged future ack deadline, then exactly one saved ack and both final replies. A second real-worker case deliberately returns a repeated lease and proves other queue and inbox work still completes. |
| P1 D — legacy acknowledgments stranded at cutover | Migration four created a queue only for new producers; old unfenced receipts had no independent scheduler after final-event completion. | The same fourth migration reconciles legacy pending ack receipts before publishing readiness. It preserves stored bytes, recipient, scope and original service timestamp. Registered known-unsent and not-yet-claimed receipts become queue work; ambiguous or fenced handoffs are quarantined. Existing queue rows win on replay. Ordinary answer receipts keep their established inbox/reply-store recovery. | `pr213-delivery-upgrade`: actual frozen round-five worker on the three-migration schema creates the faulted ack, completes its final answer, then the new migration/worker delivers the saved ack once without regenerating the answer. `pr213-delivery-upgrade-native`: 1,010 populated legacy receipts, quarantine matrix, original markers, answer claimability, populated round-six replay and one-second statement limits. |
| P2 D — inconsistent readiness contract | The production build checked only signup/index/reservation capabilities; its runbook still allowed resume after three migrations. | Signup admission stays independently compatible. Publication additionally calls `assertDispatchServerReady`; worker startup checks the same versioned queue capability before claims. Both current runbooks require draining old workers and all four migrations before new code resumes. Historical repair reports explicitly defer to the current contract. | `pr213-dispatch-readiness`: real three/four-schema RPCs, actual production build against intercepted local RPCs, new-worker startup, false/incomplete capability controls, and old-worker/four-schema compatibility control. |

A normal inbox lease resumes its immutable saved answer before current binding
routing can reinterpret it. This preserves existing parent-owned answer recovery,
including LINK, while independently scheduled acks never borrow a parent's due
time. Saved-body execution uses the same shared dispatch routine; it does not
regenerate model work or substitute fallback text. The independent queue and
ordinary inbox retain their own retry ownership.

## Reconciliation safety

The migration uses an indexed pending-ack candidate path and canonical receipt
keys. It does not infer safety from an absent receipt alone. A receipt/event
transport marker, orphan dispatch nonce, provider message ID, unregistered
historical claim, conflicting receipt or unsupported receipt shape prevents
retry. Expired/future service timestamps are blocked. No marker or nonce is reset.
Conflicting receipts retain the earliest stored receipt for audit, ordered by
created_at and ID; chronology never authorizes sending either conflicting body.
Pending conflicting receipts become unknown; accepted receipts remain untouched.

Legacy requests carry explicit `legacy_receipt` provenance. Receipts did not
store business display metadata, so recovery resolves that missing input through
the original business-name helper, then runs the unchanged sender's admission.
The body is never rewritten. Existing round-six requests retain their original
metadata and are never overwritten during migration replay.

The public `whatsapp_service_delivery_status()` exposes only data-free schema
capabilities: version 1, queueRevision 2, ready true and
legacyAcknowledgmentsReconciled true. It is installed atomically after successful
reconciliation. The new uniquely named claim RPC accepts at most ten attempted
phase keys, remains service-role-only, and retains the no-argument round-six
claim RPC as a compatible wrapper. Table RLS/ACLs and all original send guards,
consent checks, privacy projection, claim/fence and final clock checks remain.

## Preservation and rollout

All 430 tests-directory files present at the reviewed head remain byte-identical,
including the owner's 427-file preservation floor and all round-five/round-six
regressions. Added legacy fixtures contain exact reviewed round-five worker and
round-six migration bytes; only the test loader resolves their import URLs.
The initial new fairness and populated-upgrade tests both fail on the reviewed
head. The final upgrade selection passed 6/6 and the actual publication matrix
passed 1/1. A first full gate exposed an ordinary-inbox deduplication regression
introduced during scheduler work: a custom inbox repeats a completed event. Its
original termination contract was restored without changing the independent
queue-phase fairness rule. The regression selection then passed 4/4. The failed
gate and development logs are retained as provenance, not final pass claims.

No original assertion is removed, no skip is added, and statement/process/memory
budgets and CI timeouts remain unchanged. The three earlier PR migrations and
all historical migrations, especially `20261028030825`, remain byte-identical.
Only the explicitly authorized, unapplied fourth migration is repaired in place.

Current operator contract: fence/drain old workers; apply the four migrations in
order (20261120125758, 20261120132445, 20261120181032, 20261121095622); keep workers
stopped through reconciliation and both capability checks; publish matching
frontend/worker code; resume only the new worker. Old-worker/four-schema success
is a compatibility control, not permission to resume old workers. See the
[current signup contract](signup-invites.md#required-deploy-order-and-mixed-versions)
and [dispatch contract](whatsapp-dispatch-performance.md#queue-scheduling-and-populated-cutover-repair-round-7).

## Final clean verification

Actual clean child command: `npm run check:release -- --shards=4`. Its environment
contains only PATH, TMPDIR and npm_config_cache; exact argv/environment records
and real exits are in the archive. The unchanged four shards run sequentially
locally; the existing parallel CI and 30-minute per-job timeouts are unchanged.

| Shard | Total | Pass | Fail | Existing skip |
| --- | ---: | ---: | ---: | ---: |
| 0 | 997 | 996 | 0 | 1 |
| 1 | 1980 | 1980 | 0 | 0 |
| 2 | 1834 | 1833 | 0 | 1 |
| 3 | 1617 | 1616 | 0 | 1 |
| Total | **6428** | **6425** | **0** | **3** |

Real exit **0**, duration **2664.499 seconds**. The 43-scenario production battery,
typecheck, offline-route child **2/2**, and frontend build/postcheck passed.
All eight added cases and all preserved batteries ran in this final gate,
including the nine round-five cases and the round-six lifecycle/phase matrix.
The earlier failed gate is separately labeled pre-inbox-guard and is not counted
as a passing run. The generated frontend version stamp was captured and restored.

Fresh native measurements (local observations, not a production SLA):

| Profile | Measured | Enforced SQL statement budget |
| --- | --- | --- |
| 1,010 legacy acknowledgments, populated fourth-migration upgrade | 41.305 ms total; slowest statement 26.951 ms | 1000 ms per statement |
| Populated 100,000-row canonical build | 1778.508 ms total across separate statements; slowest 602.700 ms | 1000 ms per statement |
| 100,000-key snapshot cold / warm | 148.772 / 117.192 ms | 1000 ms |
| 1001-invoice snapshot cold / warm | 210.710 / 66.157 ms | 1000 ms |

All **430 existing tests-directory files** remain byte-identical (exceeding the
427-file floor); **116 protected files** including the original migrations,
admission/matcher, bookkeeping, dependency and CI files remain unchanged. The
original signup-readiness function is byte-preserved as a prefix; a separate
queue readiness check adds the required publication contract. The frozen legacy
worker and migration fixtures match their reviewed Git blob bytes exactly.
No assertion weakening, new skip, timeout or budget increase, or production effect.

[Changed-file pins and full results](evidence/pr213-round7-pins.json) ·
[Executable evidence archive](evidence/pr213-round7.zip) ·
[Archive SHA-256](evidence/pr213-round7.zip.sha256).
