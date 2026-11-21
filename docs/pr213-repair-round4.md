# PR #213 — repair round 4

Historical evidence for the named round. For any new publication or worker resume,
use the current [four-migration rollout and readiness contract](signup-invites.md#required-deploy-order-and-mixed-versions).

Reviewed base: `2fbe6260665503fc747760802819f319c91eccc5`.

| Finding | Root cause | Mechanism repair | Executable evidence |
| --- | --- | --- | --- |
| P1 C — approved-reminder parity | `review_parties` reused the free-text origin role, which can reject text before parsing. Main parses approved review text directly. The final scanner was unchanged but received different ownership sets. | Use the existing trusted-origin cache role for approved fields, calling the same parser unconditionally. Keep independent-party witnesses and all other ownership rules intact. No new phrase or scanner exception. | `pr213-approved-reminder-parity.test.mjs`: native main-before/repair-after equality of the entire snapshot and exact allowed/forbidden membership of every produced key. Both approval fields, cold/warm cache and replay; independent customer names and embedded amounts stay forbidden. |
| P1 E — pre-fence retryability | Final pre-fence authority checks discarded the existing `retryable` flag and sent unavailable reads to the same finisher as terminal denials. The saved intent was blocked despite no transport handoff. | Carry retryability through preflight, eligibility and prepared denial decisions. A retryable failure returns pending before abandon/finish, preserving the intent and claim. The existing worker defers and retries it through the same admission and fencing checks. Text, interactive and invoice-media paths share the distinction. Terminal denial and post-HTTP quarantine behavior are unchanged. | `pr213-prefence-recovery.test.mjs`: inject the transient read immediately after committed claim, assert no fence/send and pending event/receipt, reconstruct, deliver the stored body once, confirm delivery and no third send. Paired genuine denial remains blocked with zero sends. |

These are regressions in this PR's projection optimization and reply-recovery
implementation, not changes to main's intended admission or authorization policy.
Signup gate, bookkeeping code, old worker recovery tests, cutoff checks, matcher,
final-byte scanner, budgets and CI configuration are unchanged. Existing tests
are byte-identical; two new test files add coverage without replacing assertions.

The valid native parity baseline fails at exact snapshot equality on the reviewed
migration. The recovery baseline fails with `blocked` instead of `pending`;
the genuine terminal-denial control passes. An earlier parity fixture exposed
automatically retained independent name witnesses; the final fixture isolates
review-origin sources while retaining a real independent customer witness.
That fixture adjustment leaves the exact parity assertions intact.

The repaired targeted selection passed **14/14**, including both new files, all
three previously repaired reply-loss cases, uncertain HTTP quarantine, both
cutoff races and lost-fence acknowledgement recovery. The full clean gate and
fresh populated-build/snapshot measurements are recorded below after completion.

## Migration and cutover contract

Keep all three PR migrations, ordered exactly as follows:

1. `20261120125758_signup_invites.sql` — account and tenant grants.
2. `20261120132445_dispatch_privacy_performance.sql` — canonical projection and
   populated atomic build, then publish readiness.
3. `20261120181032_recoverable_reply_reservations.sql` — durable reply claims,
   nonce fence and known-unsent release.

Fence/drain the old inbound worker before starting the schema/code switch. Keep
it stopped while migrations and capability checks complete; publish matching
frontend/worker code and resume only the new worker. Historical migrations remain
immutable. Migration replay, capability version and signup matrix remain enforced;
the number of PR migrations is not a reason to consolidate working steps.

Total populated-build elapsed time, slowest SQL command, snapshot elapsed time
and snapshot statement budget are distinct measurements. The full-gate evidence
records them separately. Production migration statements retain their five-second
limit, and native build and snapshot tests enforce one-second limits. Readiness
is atomic; no partial populated index is published on failure. Local timings are
not a production SLA.

No production query, migration, backfill, deployment, live Auth/AI/WhatsApp request,
merge or outreach is performed. The final evidence archive includes the actual
commands, logs, source pins, regressions and a hash-verified manifest.

## Final verification

The clean unset invocation `npm run check:release -- --shards=4` completed with
real exit **0** on the frozen repaired source: **6,370 tests / 6,367 passed /
0 failed / 3 pre-existing skips**. The production battery (43 scenarios),
typecheck, offline-route 2/2 and frontend postcheck also passed. All existing
424 tests-directory files are byte-identical to the reviewed head; no original
assertion, skip, budget or CI timeout changed. The four unchanged shards ran
sequentially locally, taking 2,456.997 seconds; CI's parallel layout is unchanged.

Fresh native measurements from this complete gate (disposable PostgreSQL):

| Measurement | Observed | Enforced statement budget |
| --- | --- | --- |
| Populated initial build, 100,000 rows seeded BEFORE installation, all stages total | 1,337.764 ms | Separate statements; total is not one statement |
| Slowest individual build statement | 443.968 ms | 1,000 ms in the test; production migration limit unchanged at 5,000 ms |
| 100,000-key snapshot, cold | 151.234 ms | 1,000 ms |
| 100,000-key snapshot, warm | 149.644 ms | 1,000 ms |
| 1,001-invoice snapshot, cold / warm | 124.864 / 32.827 ms | 1,000 ms |

Both 100,000-key snapshots assert every forbidden key. Tagged-origin parity,
all three prior reply-loss recoveries, both cutoff races, uncertain handoff
quarantine, signup matrix/grant gate, bookkeeping and migration replay passed
inside this full run. No production work was performed.

The exact commands/environments, baseline reproductions, final logs, executable
new regression sources, preservation audit and per-file pins are in
`docs/evidence/pr213-round4.zip`; its adjacent `.sha256` file pins the archive.
`pr213-round4-pins.json` records source digests and the complete run results.
