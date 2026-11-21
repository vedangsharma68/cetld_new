# PR #213 — repair round 8

Reviewed base: `70b756dd970a92d439a8983fede9a3216bec0992`.
Areas A/B/C and the previously verified fairness/populated-upgrade behavior remain
unchanged. No production operation is performed.

## Verified findings and mechanism repair

| Finding | Verified cause | Repair | Regression evidence |
| --- | --- | --- | --- |
| P1 E — retirement strands eligible deliveries | The ready-claim routine returned SQL null both after retiring a locked candidate and when the queue was empty. With no ordinary inbox work, the worker could exit before a later eligible delivery. | The ready-claim API returns explicit retirement progress separately from a lease and an empty queue. Retirement acquires no delivery lease and does not consume the ten-claim quota. The worker gives the ordinary inbox its turn, then continues independent queue work within the unchanged deadline. | `pr213-delivery-retirement` runs the actual `processPending`: sendable control, expired predecessor, fenced predecessor, a mixed retired prefix and a ten-row retired prefix that must not exhaust the actual claim quota. The sendable ack has only five seconds left. It sends exactly once before cutoff; a reconstructed worker after the exact cutoff sends nothing further. Retired rows and transport markers are checked. |
| P2 D — frontend/worker version mismatch | Frontend admission required version 1, while the worker checked features without checking the version. | Both import the same pure `hasDispatchReadiness` predicate. It requires exact version/queue revision and all required booleans. | Future version 99, missing/string versions, future queue revision and false readiness are rejected by both consumers; the worker reaches neither claim RPC. Supported real schema remains accepted. |

The old zero-argument claim RPC intentionally preserves its historical nullable
compatibility result. It calls the ready-claim API once through a materialized
result and converts retirement progress to the old null shape. The new worker
uses the ready-claim API directly and therefore never confuses retirement with
queue exhaustion. No expired/fenced row is made retryable, no nonce/marker is
cleared, and no transport or current authority/privacy check is bypassed.

The retirement signal preserves the original actual-claim accounting: retiring
a row is cleanup, not a lease. The ten-claim cap and wall-clock deadline are
unchanged, and each cleanup operation is a bounded single-candidate SQL call. Ordinary inbox event
deduplication, per-item backoff, attempted-phase exclusions, fairness alternation,
legacy reconciliation and populated queue replay retain their prior contracts.

## Readiness and cutover

Both publication and startup use `dispatch-readiness.mjs`: version 1,
queueRevision 2, ready true, legacyAcknowledgmentsReconciled true and
retirementProgress true. Unknown versions and incomplete features fail before
worker claims. The additional feature also prevents new code accepting an older
fourth-migration schema with the previous null-only ready-claim behavior.

Keep the four migrations ordered, drain old workers, apply/replay the revised
fourth while drained, verify both capability contracts, publish matching code,
and resume only the new worker. The current [signup contract](signup-invites.md#required-deploy-order-and-mixed-versions)
and [dispatch contract](whatsapp-dispatch-performance.md#retirement-progress-and-shared-version-admission-repair-round-8)
agree on this requirement. No fifth migration is introduced. The first three and
all historical migrations, especially `20261028030825`, remain immutable.

## Evidence and preservation

The initial five-case baseline on the reviewed implementation passed its
sendable control and failed all three retirement-prefix cases plus the future
version case: **1 pass / 4 fail / 0 skip**. These are two findings, not four defects.
The initial focused recovery/readiness/native selection passed **18/18**. A
broader quota audit then reproduced the residual failure with ten retired rows
ahead of the target: counting retirement as claims could still exhaust the quota.
The in-progress gate was intentionally stopped before source changes; its log
and -15 exit are retained as provenance, not a pass. The regression now asserts
only one actual claim/completion for every prefix, including ten retired rows. The final
retirement/version selection passed **6/6**, using exact server timestamp
milliseconds and a real wait through the service cutoff, rather than only a
SQL claim or a wall-clock performance guess.

All 436 existing tests-directory files are preserved byte-for-byte, including the
owner's 430-file requirement and 427-file floor. Only new regression coverage is
added. No existing assertion, skip, timeout, memory ceiling or work budget changes.
Signup admission, bookkeeping, canonical projection and final-byte screening are
unchanged; the prior signup-readiness function body remains unchanged. All
verification uses disposable SQL databases and intercepted transports.

## Final full clean verification

Actual clean command: `npm run check:release -- --shards=4`; child environment
contains only PATH, TMPDIR and npm_config_cache (complete record in the archive).
The unchanged shards ran sequentially locally; existing parallel CI and its
30-minute per-job timeouts are unchanged.

| Shard | Total | Pass | Fail | Existing skip |
| --- | ---: | ---: | ---: | ---: |
| 0 | 1746 | 1745 | 0 | 1 |
| 1 | 1106 | 1106 | 0 | 0 |
| 2 | 2036 | 2035 | 0 | 1 |
| 3 | 1546 | 1545 | 0 | 1 |
| Total | **6434** | **6431** | **0** | **3** |

Real exit **0**, duration **2654.061 seconds**. The 43-scenario production battery,
typecheck, offline-route child **2/2**, and frontend build/postcheck also passed.
All six added cases and every preserved battery ran on this frozen source.
The complete interrupted draft gate and quota regression failure are retained
as development provenance, not passing results. The generated frontend version
stamp was recorded and restored.

Fresh preserved native measurements (local observations, not a production SLA):

| Profile | Measured | SQL statement budget |
| --- | --- | --- |
| 1,010 legacy acknowledgment upgrade | 345.676 ms total; slowest statement 223.056 ms | 1000 ms per statement |
| Populated 100,000-row canonical build | 1386.426 ms total across separate statements; slowest 400.514 ms | 1000 ms per statement |
| 100,000-key snapshot cold / warm | 111.768 / 87.047 ms | 1000 ms |
| 1001-invoice snapshot cold / warm | 146.318 / 51.988 ms | 1000 ms |

All **436 existing tests-directory files** remain byte-identical; all **116
protected files** retain their original hashes. The earlier three PR migrations,
all historical migrations, admission/matcher, bookkeeping and original signup
readiness function body are unchanged. No assertion weakening, new skip, timeout,
claim cap, process deadline or memory ceiling increase. No production effects.

[Changed-file pins and full results](evidence/pr213-round8-pins.json) ·
[Executable evidence archive](evidence/pr213-round8.zip) ·
[Archive SHA-256](evidence/pr213-round8.zip.sha256).
