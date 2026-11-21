# PR #213 — repair round 6

Historical evidence for the named round. For any new publication or worker resume,
use the current [four-migration rollout and readiness contract](signup-invites.md#required-deploy-order-and-mixed-versions).

Reviewed base: `5815425d1b06a66bcce201d3fb40f6785596fe67`.

## Shared defect and architectural repair

The previous worker persisted scoped receipts too late and treated the inbox
event's lifetime as the delivery lifetime. That left no common identity before
the first authority read, no unbound receipt for retry age, and no independent
ack phase after the final event completed. Inferring intent from a reservation,
claim or nonce cannot repair missing intent.

This repair adds a private service delivery queue keyed by **event + phase**.
Every service reply/media producer stages its first request before sender
authority reads. A protocol whose committed side effect can change routing
stages its route before the side effect, then seals the first concrete reply.
The stored scope, kind, audience, options and body cannot be replaced by a retry.
Typing indicators and templates remain outside this protocol.

| Finding | Root cause | Mechanism fix | Regression |
| --- | --- | --- | --- |
| P1 LINK before reservation | Verification changed the binding before any saved confirmation existed; recovery inferred its route from claim/nonce state. | Stage protocol intent before verification, then seal the first reply before authority lookup. Reconstruction consumes that route/request, independent of claims. Staging or effect acknowledgement loss defers the same intent. | `pr213-delivery-lifecycle`: original pre-claim authority fault plus lost staging/effect acknowledgements; exactly one connected confirmation, no ordinary answer. |
| P2 aged unbound START | Unbound delivery had no scoped pending receipt, so the one-hour unproduced-event limit won. | Any pending queue phase contributes to the durable pending flag, including unbound requests. Recovery keeps the original 24-hour service timestamp and repeats the live cutoff checks. | Two-hour unbound START defers without dead-lettering, then delivers once. Native SQL proves the original timestamp cannot be replaced and 25-hour recovery is blocked. |
| P2 ack after final | The timer ignored pending and event completion removed its only recovery scheduler. | Ack is a separate durable phase with its own due time. A short delivery lease supplies the original processing context to unchanged authorization/claim/fence routines; completion restores the parent's final status without rerunning its handler. | Accelerated real progress timer: final answer delivers, ack stays pending, reconstruction delivers ack once, final answer and handler do not repeat. |

The queue stores data, not authorization. Recovery calls the original sender,
fresh owner/customer/consent and file checks, canonical post-assembly scanner,
original claim/rearm/nonce fence, and synchronous final clock check. A durable
handoff marker with uncertain outcome is quarantined, never resent. Terminal
denials stay terminal. The private phase lease does not create new send authority.
It preserves the original phone/event/window and restores the parent after ack
work, including when that parent was already done.

Queue requests are bounded to 64 KiB. Media uses a hash-checked immutable source
reference when available; otherwise bytes use a private bucket under the existing
10 MiB file limit. Binary data is not expanded into JSON arrays/base64 requests.
No private blob reference goes into a customer payload. Both the queue and bucket
are private; API clients cannot inspect/mutate queue rows or invoke its RPCs.
Scoped queue rows cascade with workspace deletion. No auth decision is cached.

Durability starts with a successful intent commit, before transport. Code/data
that never reached durable storage cannot be reconstructed after arbitrary
process loss. No Graph request starts when intent persistence fails. After HTTP
may have begun, the existing conservative quarantine rule remains; this does not
claim an impossible PostgreSQL/Graph distributed transaction.

## Complete caller inventory

| Producer | Durable placement and recovery |
| --- | --- |
| STOP, START/UNSTOP, unmatched verification | Shared producer before authority reads; scoped and unbound phases use the same queue. Consent side effects remain committed. |
| LINK verification | Stage route before verification side effect, seal reply before the first authority lookup. |
| Processing-error and final-attempt fallback | Shared producer; an existing intent prevents a substitute fallback. |
| Owner/customer and unreadable replies | First scoped request before preflight; existing accepted-result contract retained. |
| Interactive replies | Stored request/options; existing reference-aware owner receipt replay revalidates choices/fallbacks. |
| Media replies | Stored original metadata and checked bytes/reference; current sender/file admission runs again. |
| Progress ack timer | Same producer with phase `ack`; due work survives final-event completion. |
| Typing indicators, templates | Outside this inbox reply protocol; original paths unchanged. |

`work/r6/confirmation-callers.log` in the archive records source call sites.

## Fault and phase evidence

`pr213-delivery-phase-matrix` executes **28 cases**: owner text, customer text,
unreadable text, interactive, owner media, customer media and ack, each at
pre-claim, post-claim/pre-fence, post-fence and producer reconstruction. Actual
stores, sender and admission run; only faults and Graph are injected. Recovery
sends the first request once and does not invoke a model/handler to regenerate it.

`pr213-delivery-queue-native` runs actual PostgreSQL connections to prove one
concurrent lease, restoration of a terminal parent, exact first-request retention,
service-only ACLs/private storage, replay safety, uncertain-fence quarantine and
the unchanged service-window boundary. An additional native regression covers an
ack recovered from an expired processing lease: terminal parents stay terminal;
unfinished parent work returns to pending and is claimable by the ordinary inbox.
Restoring processing with a cleared lease would strand that work, so phase release
normalizes expired unfinished work rather than manufacturing a new active lease.

The initial three fresh cases fail against the old worker: wrong LINK reply,
inside-window START dead-letter and missing ack after final completion. The
broader focused selection passed **72/72**, and the final regression selection
passed **34/34**, including all nine round-5 cases, prior reply-loss recovery,
both cutoff races and quarantine. The full gate includes every matrix/native and
preserved test. Development failures (including adapting to the sender's frozen
interface and the stricter native storage denial) are retained as provenance;
only a recorded full exit 0 is the release claim. The first in-progress release
run was intentionally stopped after the lease audit exposed the unfinished-parent
edge case; its log and -15 exit are preserved as pre-lease-fix provenance. The new
native regression fails on that earlier release function and must pass on the
final function before the authoritative full gate restarts.

## Forward migration and cutover

The three already verified PR migrations remain byte-identical and in order.
The generic durable protocol requires one **additional forward migration**:
`20261121095622_durable_service_delivery_intents.sql`. It creates the private queue,
private blob bucket, bounded indexes and service-only phase-lease RPCs; it also
extends pending-intent tracking to both phases. It does not rewrite an applied
migration, change invitation/bookkeeping code, or alter privacy projection.

Fence/drain old workers, apply the original three migrations in timestamp order,
then this new migration, verify replay/queue RPC availability, publish the new
worker, and resume only new code. Existing frontend/sign-in behavior is unchanged.
This is a schema-first worker cutover; never start a new worker against a backend
without the phase queue. No migration is applied to production by this repair.

Statement, process and memory budgets, old tests and assertions, existing skips,
typing/template behavior and the historical migration are unchanged. All tests
use disposable databases and intercepted Graph. No production query, migration,
backfill, deployment, merge or live Auth/AI/WhatsApp request is performed.

## Final clean verification

Actual command: `npm run check:release -- --shards=4`, in a clean child environment
containing only PATH, TMPDIR and npm_config_cache (full record in the archive).
The four unchanged shards ran sequentially locally; CI parallelism and its
30-minute per-job timeout remain unchanged.

| Shard | Total | Pass | Fail | Existing skip |
| --- | ---: | ---: | ---: | ---: |
| 0 | 974 | 973 | 0 | 1 |
| 1 | 1974 | 1974 | 0 | 0 |
| 2 | 1835 | 1834 | 0 | 1 |
| 3 | 1637 | 1636 | 0 | 1 |
| Total | **6420** | **6417** | **0** | **3** |

Real exit **0**, 2649.634 seconds. The 43-scenario production battery, typecheck,
offline-route child **2/2**, and frontend build/postcheck also passed. All **41 new
cases** are included: lifecycle 7, format/phase matrix 28, native queue 6. The
post-audit lease/lifecycle selection passed **13/13**. All nine round-5 cases and
all previous recovery/cutoff/quarantine tests are included in the full gate.

All **427 pre-existing tests-directory files** remain byte-identical against the
reviewed Git blobs. All **117 protected files** retain their original SHA-256,
including every old migration, signup/bookkeeping, outbound sender, canonical
matcher/admission, dependency lockfile and CI. No assertion weakening, new skip,
statement/process/memory budget or timeout increase. The frontend version stamp
generated by the build was recorded and restored; it is not a source change.

Fresh preserved native measurements (local results, not a production SLA):

| Profile | Measured | SQL statement budget |
| --- | --- | --- |
| Populated 100,000-row index build, all stages total | 1292.488 ms | Separate statements, not one statement |
| Slowest build statement | 414.914 ms | 1000 ms test; unchanged migration budget 5000 ms |
| 100,000-key snapshot cold / warm | 150.880 / 117.764 ms | 1000 ms |
| 1001-invoice snapshot cold / warm | 285.063 / 99.266 ms | 1000 ms |

The archive preserves exact commands/environment, final and development logs,
source pins, complete new tests, both lease-function versions and hash manifest.
See [changed-file pins and full results](evidence/pr213-round6-pins.json),
[executable archive](evidence/pr213-round6.zip), and
[archive SHA-256](evidence/pr213-round6.zip.sha256).
