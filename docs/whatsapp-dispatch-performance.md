# Dispatch privacy index and recoverable replies

The PR changes computation, not admission policy. Apply its migrations through
the normal operator process before expecting production delivery to recover.
Repository verification uses disposable databases and intercepted transports;
it does not send real WhatsApp messages or change production.

## Populated first build

The initial migration uses independent bulk SQL stages, rather than calling a
single nested rebuild function over every row. Already canonical keys are copied
as canonical arrays without a parser invocation per row. Both bulk inserts use
primary-key order; secondary indexes are built after population. Deferred source
FK checks finish in their own stage before index creation. A projection-specific
revision invalidates previously built indexes independently of grammar changes.
Migration rebuilds clear only private derived tables in bulk. Readiness is published
last, in the same transaction, so rollback cannot expose a partial index.

`pr213-populated-index` seeds 100,000 rows BEFORE applying the performance
migration. It executes the original migration commands with a stricter one-second
SQL budget on every command, requires complete source/key cardinalities, and
checks every forbidden key after the build. The production five-second statement
limit is unchanged. This complements the original steady-state scale test.

Explicit `origin:` rows use a distinct pure-cache provenance role. Their parser
is never gated by a free-text classifier. `pr213-tagged-origin` compares the exact
main snapshot set before/after migration and each tagged row's exact canonical
set, including when free-text classification rejects the declaration. Fixture
sibling terms are removed so duplicate canonical rows cannot mask under-retention.

Approved reminder fields also establish review provenance. Their party projection
uses the same unconditional origin-parser role as main and explicit `origin:`
rows, rather than classifying already approved text again. Independent stored
customer identities and other-source witnesses still prevent a review from
certifying somebody else's name. `pr213-approved-reminder-parity` compares the
entire main allowed/forbidden snapshot and the assignment of **every** parser
key, for both approval fields, cold/warm cache and migration replay. It includes
independent-party and embedded-amount negative controls. The final-byte scanner
and its rules are unchanged.

## Global source projection

The original snapshot reparsed retained terms globally for each send. Workspace
memoization reduced repeated expansion but still paid per-global-source projection
and witness costs. The repair maintains a private canonical index transactionally:

- Source-scoped rows store each term's exact projection. Statement transition-table
  triggers maintain inserts, updates and deletes; TRUNCATE invalidates the index.
- Hash-and-text indexed alias edges implement the same all-aliases-owned exemption.
  Indexed party witnesses preserve independent-review validation. Hash matches
  always include exact text checks; collisions do not authorize values.
- Source-scoped canonical rows avoid a shared global reference-count hot row.
  The read deduplicates their union and subtracts the current recipient's live
  owned set. **All global forbidden keys remain in the output**. Output itself
  necessarily scales with its cardinality; expensive parsing no longer repeats.
- Pure alias memoization remains keyed by workspace, exact input, semantic role
  and canonicalizer revision. Typed keys, integer/UUID scalars, encoded JSON and
  sources without an origin use their existing unambiguous interpretations.
  Literal CREATE OR REPLACE definitions replace the previous runtime function
  source-text rewrite. No deployed function-body search/replacement remains.

Index/memo tables have RLS and no API-role table privileges. Ownership, binding,
readiness, active private membership, reviewed facts and file authority remain
live reads. A revision change rebuilds the index; rollback restores its updates.
No ownership decision is cached. Final assembled payload screening is unchanged.

`pr213-global-index.test.mjs` seeds 100,000 foreign keys, executes actual snapshots
under `statement_timeout='1s'`, checks **every** key, tests rollback, then replays
all three PR migrations. A query timeout fails the test; a wall-clock assertion
is not a substitute for completion. `dispatch-snapshot-performance` compares full
old/new admission sets for own/foreign/owner/unbound recipients and exact aliases,
then tests 1,001 invoices and live source/ownership/revision changes. Existing
privacy tests continue to check foreign blocking and own-value admission.

## Claim acknowledgements, retries and the final cutoff

A durable reservation is registered before the original authorization/claim RPC.
Registered events reject legacy workers' claims, permitting safe mixed-worker
rollout without two competing protocols. The new wrapper delegates to the same
owner/customer/transactional claim functions: it does not grant new authority.

A saved customer intent takes precedence over model routing and every fallback.
Recovery reloads the post-intent event/receipt state before dead-letter or failure
notice decisions; accepted/uncertain/blocked intents never become verification
messages. Cross-scope reservation/rearm/fence calls are denied by SQL, including
unbound fallbacks targeting an event that already owns a scoped intent. The
global intent lookup has its own partial index.

If the claim commits but its response is lost, a reconstructed worker can re-arm
only the pending, registered intent for which no HTTP handoff has started. It
repeats admission and original authorization, then uses one durable invocation
nonce to fence the transport. A lost fence acknowledgement can be reconciled
with that **same invocation nonce**, never a different worker's nonce. Concurrent
workers cannot start a second handoff. Stored body reuse is intentional; changed
recipient, audience, kind, business, files or private membership still fail closed.

A transient authorization read after nonce reservation still precedes HTTP.
The caller may release only its own nonce while the receipt is pending and has no
provider ID. Successful release keeps the original intent retryable; the original
claim and privacy checks run again. No exception after HTTP starts invokes this
release. Unreconciled reservations remain quarantined. The final clock check
remains immediately before transport after all awaited reads.

That distinction also applies **before** nonce reservation: an explicitly
retryable/unavailable authority result is pending, never a terminal denial.
All pre-fence service reply paths (text, interactive text and invoice media)
preserve the saved intent and existing claim without finishing it as blocked or
abandoning it. The worker defers the known-unsent intent; reconstruction re-arms
it through the original admission/claim/fence protocol and sends its stored body.
An actual missing/mismatched binding, suppression or closed service window stays
a terminal denial. `pr213-prefence-recovery` injects a binding read failure after
the claim commits but before the fence, asserts zero initial sends and a pending
event/receipt, then proves exactly one stored-body send and a delivered callback.
Its paired terminal-denial test remains blocked across reconstruction.

The inbound worker applies the same pending-result contract to every confirmation
route, not only ordinary replies. STOP/START and verification processing does not
complete an event while its confirmation is known-unsent. A completion guard
reloads the saved confirmation receipt; pending without a handoff marker defers
the event. Normal review drafts retain their existing accepted-result contract.
Scoped STOP retries resume the exact stored confirmation through the original
authority/admission/fence checks, without changing committed suppression. Unbound
confirmations reuse the inbox's original idempotent protocol. A committed LINK's
pending confirmation stays in that protocol even after binding changes; it cannot
take over an existing scoped reply. Accepted/uncertain handoffs remain quarantined
against resend and actual terminal denials stay terminal.

`pr213-confirmation-recovery` proves transient/terminal cases for STOP, START,
verification and LINK; exact stored-body delivery once after reconstruction;
unchanged STOP suppression throughout; and normal-owner reply isolation.

## Durable phase queue (round 6)

Scoped receipts and reservation predicates are insufficient as the root intent
store. The private `app.whatsapp_service_deliveries` queue records every service
request before sender authority reads, keyed by event and `answer`/`ack` phase.
A route-changing protocol is staged before its side effect, then seals the first
concrete request. Unbound requests have the same durable 24-hour retry horizon;
ack due work is independent of the final inbox event's status. Typing indicators
and template sends stay outside this reply protocol.

A bounded row lease temporarily gives queued work the original processing context
so all existing authorization/claim/fence routines still run. Ack completion
restores a previously completed parent; it never reruns the final handler. Media
bytes are hash-checked from their immutable source or a private bucket, under the
existing file cap. The final payload scanner is unchanged. An uncertain phase
handoff remains quarantined; actual terminal denials do not re-arm.

Apply the additional forward migration
`20261121095622_durable_service_delivery_intents.sql` after the three existing PR
migrations, while old workers are drained, before publishing/resuming the new
worker. No existing migration is edited or consolidated. Full caller inventory,
fault/phase matrix, lease/security/replay evidence and limitations are recorded in
`pr213-repair-round6.md`.

Pending intents remain eligible beyond the old one-hour error limit, only within
the actual inbound timestamp's 24-hour window. Other inbound work retains its
existing retry-age policy. After all awaited binding/consent checks and the fence,
the sender reads the clock synchronously immediately before `fetch`; no lookup
can move a service reply across the cutoff after that read.

Accepted or uncertain Graph handoffs are never automatically resent. Historical
claimed rows without a registered fence are ambiguous and stay quarantined.
Arbitrary crash atomicity between PostgreSQL and Graph is impossible without a
provider-side idempotency contract; this protocol deliberately prefers no duplicate
for an uncertain handoff. The specified committed-claim/no-handoff case recovers
to exactly one delivered send. The original snapshot-outage backlog had no claim
and remains recoverable. `whatsapp-dispatch-retry` proves these cases, delivered
callbacks, reconstructed workers, stale replies, cutoff races and concurrency.

Local before/after measurements and full release results are recorded in
`docs/pr213-review-repair.md` and the accompanying evidence archive. They are
measurements, not a production SLA. The reported >80-second production query was
not rerun on production. No timeout, admission safeguard or budget is raised.

### Queue scheduling and populated cutover (repair round 7)

The current worker and production publication require all four migrations, in
the order specified in [the signup rollout contract](signup-invites.md). Fence and
drain old workers before application, keep them stopped through reconciliation
and capability checks, then resume only the new worker.
`whatsapp_service_delivery_status()` must report version 1, queueRevision 2, ready
true, legacyAcknowledgmentsReconciled true and retirementProgress true. `signup_invite_status()` alone is
not dispatch readiness; the three-migration schema supports existing signup but
must not publish or start the new worker. Old-worker/four-migration compatibility
is a control, not an authorized resume path. An earlier candidate fourth schema
requires replaying the revised fourth under the same drain; existing table/queue
rows do not substitute for queueRevision 2, reconciliation and retirement-progress readiness.

The fourth migration reconciles pending legacy ack receipts before publishing
that capability. Exact stored body, recipient, workspace and original inbound
window survive. Registered known-unsent claims and not-yet-claimed receipts become
queue work; receipt/event fences, orphan dispatch nonces, provider IDs, historical
unregistered claims and conflicting receipts stay quarantined. Expired windows
stay blocked. Existing populated round-six queue rows win on replay; ordinary
answer receipts retain inbox/reply-store recovery. No transport marker is reset.

A queue claim always uses its own retry deadline. Parent dues cannot advance it.
Workers exclude phases already attempted in the run, alternate queue and ordinary
inbox work, and release a repeated phase without ending the whole run. Ack release
restores the prior parent deadline instead of inventing an immediate retry.

### Retirement progress and shared version admission (repair round 8)

The ready-claim API distinguishes a leased delivery, a retired terminal candidate,
and an empty queue. Retirement acquires no delivery lease and does not consume the existing
ten-claim quota; the worker continues within its unchanged deadline and alternates the ordinary
inbox before asking for more queue work. An empty inbox after retirement cannot
be mistaken for an empty delivery queue. Expired items stay blocked, fenced items
stay quarantined, and no marker is released or cleared by retirement.

The zero-argument historical claim API retains its nullable compatibility result.
Only the ready-claim API provides retirement progress to the new worker. The
shared dispatch-readiness predicate requires version 1, queueRevision 2, ready,
legacyAcknowledgmentsReconciled and retirementProgress. Both production builds
and worker startup reject unknown/missing versions or incomplete features. Drain
old workers and apply/replay the revised fourth migration before publishing or
resuming matching code; the migration count remains four.
