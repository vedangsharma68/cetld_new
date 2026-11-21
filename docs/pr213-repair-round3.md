# PR #213 — repair round 3

Reviewed baseline: `fc393eebcad5f999efb92375cd8c9f91c88f8dd7`.
This repair does not apply migrations, query production, deploy, merge, or make a
live Auth/AI/WhatsApp request. Historical migrations remain unchanged. The three
un-applied migrations introduced by this PR are repaired in place.

| Finding | Root cause | General repair | Regression |
| --- | --- | --- | --- |
| P1 R1/R7 populated first build | The migration put all projection, inserts, alias/witness work and deferred FK checks inside one rebuild call; the existing scale test seeded after installation. | Independent bulk stages, canonical-key copying without per-row parser calls, primary-key-ordered inserts, bulk secondary-index creation and a separate FK-validation stage. Readiness is published only after completion in the migration transaction. A projection-specific revision invalidates older derived rows even when canonical grammar is unchanged. | `pr213-populated-index`: seed 100,000 first; run every migration command under a **one-second SQL timeout**; require full source/key counts and check every forbidden key. |
| P1 R1 tagged origins | A free-text classifier was applied again to explicitly tagged, already-established provenance. | Separate `origin-tagged` cache role calls the same origin parser without that classifier shortcut, in both projection and independent-party witnesses. | `pr213-tagged-origin`: exact main snapshot-set equality and exact per-row canonical-key equality before/after migration, even with classification rejecting the text. The frozen reviewed implementation reproduces the coverage loss; upgrading that populated index restores the exact main set. No subset oracle replaces equality. |
| P1 R2 customer recovery | Failure routing could replace a saved scoped intent with an unbound fallback; post-fence binding failures were treated like HTTP uncertainty; age decisions used the event object from before intent creation. | Reload durable intent/event state; replay the saved customer body before model/fallback routing; forbid SQL cross-scope handoff reuse. A caught pre-HTTP failure releases only its own pending nonce, then retries original admission/claims. Any accepted/uncertain intent suppresses fallback. Age checks use post-intent state. | `pr213-customer-recovery`: lost committed customer-claim acknowledgement, post-fence transient binding read, two-hour first-intent/snapshot timeout, and uncertain HTTP. First three recover the stored body once; the uncertain request is never resent or substituted. Original owner recovery and both cutoff races remain covered. |
| P2 R6 concurrent reminder edit | Recovery supplied the entire pre-claim metadata object to a finisher that correctly merged it onto current metadata, thereby restoring stale reminder fields. | Recovery passes only the bookkeeping sync namespace it owns. The existing scoped optimistic finisher merges those changes into current metadata. | `pr213-recovery-metadata`: a reminder approval and delivery body arrive during credential recovery and survive alongside the restored failure/retry state. |
| P2 R5 response credential copy | GoTrue returns its in-memory identity; trigger-sanitized database columns do not mutate that response object. | The supported code-input compatibility adapter exchanges the code for a short-lived ticket BEFORE Auth, and recursively removes credential fields from its returned data. Direct raw-code Auth requests are rejected before consumption. Existing sign-in is unaffected; cached clients use the existing invitation entry. | `pr213-recovery-metadata`: a GoTrue-style in-memory user/identity/session copy receives no original code and returns no credential. Native Auth tests also prove raw direct requests cannot create a user or consume the code, then admit the same invitation through the safe exchange. |

The response fix does not claim to patch hosted GoTrue. An unchanged client that
posts original codes directly to the Supabase hostname must use the compatible
entry/adapter; a repository database trigger cannot rewrite that remote HTTP
response. Email/code registration remains supported through that entry, and
existing password/Google sign-in, sessions and workspaces remain available.
Invalid credentials in the native fixture still reach Auth INSERT even when
preparation rejects, so the server-creation gate remains directly tested.

The original admission boundary/matcher, statement budgets, memory ceiling,
release workflow and test selection remain unchanged. No assertion is removed and
no skip is added. The new input role expresses trusted provenance; it is not a
phrase allowlist or a special case for a review input.

Deployment remains database-first. Fence/drain the old inbound worker for the
schema/code switch, apply all three PR migrations, verify v2 capabilities with
`privacyRepairRevision: 3` and both claim/release RPCs, publish the new code, then
resume the worker. The production build rejects an unrepaired backend. The
invitation entry remains independent of cached main-app code. No rollout action
is performed by this repair.

Known-unsent recovery does not promise atomicity across an arbitrary database /
Graph process crash. Once HTTP may have started, or a reservation cannot be
reconciled, it remains quarantined. The specified recoverable failures are proven
to deliver once without replacing the saved reply.

The first complete verification attempt exposed an event-accounting regression:
quarantined customer replies were completed in storage but not counted in the
worker result. Recovery now distinguishes completed from deferred intents. The
unchanged recipient-response-loss test and four new recovery scenarios passed in
a 16-test focused run before the final clean gate was restarted. The failed run
is retained as development provenance, not reported as a successful gate.

Final clean verification reached real exit **0** on the frozen repaired source:

- `env -i PATH="$PATH" TMPDIR=/tmp npm_config_cache=/tmp/cetld-npm-cache npm run check:release -- --shards=4`
- **6,367 total / 6,364 passed / 0 failed / 3 pre-existing skips** across all four shards; 43-scenario production battery, typecheck, offline-route 2/2 and frontend postcheck also passed.
- Populated first build: **100,000 rows seeded before installation**, **1,548.621 ms total** across statements; slowest statement **465.978 ms**. Every migration command ran under a one-second SQL limit, with complete source/key counts and all 100,000 keys asserted.
- Steady 100,000-key snapshots: **107.732 ms cold / 85.163 ms warm**, every key checked on each call. Native 1,001-invoice profile: **167.035 / 38.480 ms**. These are local measurements, not a production SLA.
- All new finding regressions and prior cutoff-race, tenant-grant, replay and mixed-version tests ran inside this complete gate. Modified existing tests have no assertion-count decrease and no new skips; the immutable historical migration, matcher and admission boundary remain byte-identical.
- Gate duration: **2,452.193 seconds**, with the four existing shards executed sequentially locally. CI's existing parallel layout and timeout are unchanged.

Source hashes, exact command/environment, logs, outputs, executable regression files and the manifest are retained in `docs/evidence/pr213-round3.zip`; its SHA-256 is in the adjacent `.sha256` file. `pr213-round3-pins.json` records every changed source file and the immutable migration pin.
