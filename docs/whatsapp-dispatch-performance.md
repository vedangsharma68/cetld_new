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
