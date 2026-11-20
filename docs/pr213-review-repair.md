# PR #213 independent-review repair

This repair stays on `codex/signup-gate` and the existing PR. It makes no
production query, migration application, backfill, deployment or live send.
The two un-applied PR migrations are corrected in place for replay safety;
a third forward migration adds recoverable reply reservations. Historical
migrations, including `20261028030825_offline_invoice_review_corrections.sql`,
are unchanged.

## Findings, cause and resolution

| Finding | Origin | Root cause and repair | Executable evidence |
| --- | --- | --- | --- |
| R1 global snapshot cost | Pre-existing global traversal; the PR's memoization left this part unresolved | Global sources were still expanded/grouped per send. Maintain exact source-scoped canonical projections, indexed alias edges and party witnesses on writes. Read their deduplicated union against live recipient ownership. No forbidden-key reduction. | `pr213-global-index`: actual 100,000-row cold/warm snapshots complete under a one-second **SQL** timeout, every key checked, rollback and migration replay. `dispatch-snapshot-performance`: full old/new output equivalence and 1,001 invoices. |
| R2 lost reply claim / one-hour expiry | Pre-existing | A committed claim was indistinguishable from an HTTP handoff; errored pending intents inherited generic inbound age expiry. Register claims before acquisition, re-arm only known-unsent reservations, fence each handoff with a durable invocation nonce, and use the actual 24-hour inbound window for pending intents. Existing claim functions still authorize. | `whatsapp-dispatch-retry`: lose successful DB claim acknowledgement, reconstruct at age two hours, observe zero sends then one delivery; same-nonce fence-ack recovery, concurrent/repeated processing, stale reply rejection, historical ambiguous claim quarantine. |
| R3 cutoff race | Pre-existing | The clock was read before asynchronous authority lookups. Recheck after them and synchronously immediately before transport, after the fence and fresh binding/consent reads. | Binding-await and transport-fence-await cutoff races each produce zero Graph calls. |
| R4 tenant invite bypass | Pre-existing tenant RPC behavior, not closed by the PR's account gate | Authentication alone allowed another workspace. Enforce one consumed invite grant at the workspace INSERT boundary, covering wrappers, internal RPCs and direct writes. New Auth accounts atomically receive their first workspace; existing accounts redeem an email-bound code for one new business. | `pr213-auth-replay`: existing access preserved; both public/internal no-invite RPCs denied; one grant, rollback reuse, replay cannot create another. `signup-invite-native`: both Auth providers and atomic account/profile/workspace rollback/concurrency. |
| R5 identity plaintext credential | Introduced by the PR's metadata-based invitation credential | GoTrue independently builds identity metadata from its in-memory user. Strip code/ticket at both users and identities persistence boundaries, including updates and historical cleanup. New password clients send only an opaque short-lived ticket to Auth. | `pr213-auth-replay`: GoTrue-role user then identity insertion, updates, legacy cleanup, unrelated metadata preservation; wrong-email/expired/rotated/reused tickets rejected. Client tests assert original code is absent from Auth requests. |
| R6 quiet path erases failures / machine-code UI | Erasure introduced by PR; raw-code rendering pre-existing | Missing adapters and later NOT_CONNECTED results were treated as evidence of never-connected bookkeeping. Retain saved failure diagnostics, status, attempts and retry state; quiet only proven never-connected invoices. Humanize drawer and retry error copy. | `bookkeeping-unconfigured`: missing adapter and pre-dispatch refresh-failure preservation, visible humanized failures, quiet never-connected controls. Existing reconciliation/UI tests remain covered. |
| R7 replay / source rewrite / version matrix | Non-idempotent PR DDL and source-text rewrite introduced; open old signup and cached-client rollout pre-existing | Guard DDL and use literal CREATE OR REPLACE definitions. Add a versioned capability contract, dedicated compatible invitation entry, atomic initial tenant provisioning, and DB-first production-build enforcement. | Auth migration replay twice with consumed state intact, v1 consumed-grant upgrade and unused v2-grant preservation; global index test replays all three migrations after 100k rows; `pr213-signup-matrix` exercises unsupported old schema, v2 paths, independent entry and existing sessions. |

The admission policy remains unchanged: exact final bytes are screened, current
recipient/owner binding and owned facts are reread, foreign workspaces stay in
the forbidden set, and incomplete readiness fails closed. Pure computations may
be cached, never an authorization result. Public API privileges are not broadened
for the private index. The new reply RPCs are service-only and delegate claims to
the original policy functions.

## Semantics and rollout limits

One invite approves one new business. Existing workspaces, existing sessions,
existing password/Google sign-in, landing and demo remain available. A new account
and its first workspace commit atomically; a failed creation leaves the code
reusable. Existing accounts need another code to create another tenant. Deleting
a business does not restore its consumed grant.

Deploy the three PR migrations in timestamp order **before** the new frontend
and workers. Production frontend publication checks all v2 capabilities and
refuses an incomplete backend. Use the issued `/invite.html` link independently
of cached main-app code. Old invite-aware clients remain compatible. An untouched
pre-gate database is inherently open; old/old is unsupported, not a UI-secured
state. New UI with an old schema refuses account creation with an upgrade message.
See `signup-invites.md` for the exact matrix and operator instructions.

For R2, exactly one delivery is demonstrated for the specified committed-claim,
zero-handoff failure. Accepted/uncertain Graph handoffs are never resent. Arbitrary
process death between the database fence and a remote provider cannot have atomic
exactly-once delivery without provider idempotency. Historical claims without a
registered fence therefore remain quarantined. The original snapshot-outage
backlog, which failed before claim, is recoverable.

## Verification and fixture changes

The full clean release command is recorded in the evidence archive, including
its exact environment and real exit. The gate runs all test files, the existing
production battery, typecheck, offline-route child and frontend build. No timeout,
statement budget, memory ceiling, test selection or skip is relaxed.

Business fixtures (including the four self-contained legacy SQL loaders) seed
explicit operator-approved tenant grants; invite-security
regressions deliberately use native PostgreSQL without that fixture hook. Legacy
transport doubles bridge their injected approved claims into a real disposable
SQL reservation/fence rather than bypassing privacy. Old claim-race interceptors
follow the new reserved-claim endpoint. Existing drawer assertions that expected
raw codes now assert human-readable text and absence of the raw code. Existing
signup success assertions now require an automatically created workspace and
denial of an uninvited second workspace. These are contract updates, not dropped
assertions or new skips.

Two incomplete development gate attempts are retained as evidence: one exposed
missing grants in a legacy setup (42501), and one was stopped during the final
v1-upgrade audit before completion. Neither is reported as a passing gate. The
final complete run below tests the repaired source, including those corrections.

## Final recorded verification

`npm run check:release -- --shards=4` ran with the clean unset environment recorded
in `work/review-gate-command.json`. It completed in 2,276.1 seconds with real exit 0:

| Run | Total | Pass | Fail | Skip | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full suite, all four release shards | 6,358 | 6,355 | 0 | 3 existing | 0 |
| Offline-route child | 2 | 2 | 0 | 0 | 0 |
| Production containment battery | 43 scenarios | 43 | 0 | 0 | 0 |

Typecheck and frontend build both completed successfully as part of that command.
The saved reviewer batteries and all new regressions are included in the full
suite. No additional skip was introduced. The existing modified test files have
no reduction in raw assertion call sites; fixture and expected-output changes
are described above and recorded in the preservation audit.

| Fresh native profile | Cold | Warm | Enforced budget / completeness |
| --- | ---: | ---: | --- |
| 100,000 foreign global terms | 109.6 ms | 92.3 ms | 1-second SQL timeout; all 100,000 keys checked on each result |
| 1,001 invoices, ten customers | 145.1 ms | 36.5 ms | 1-second SQL timeout; complete admission sets checked |
| Cold 59-row Unicode update | 859.2 ms | — | Unchanged 5-second statement limit |
| Largest dense setup statement | 3,206.7 ms | — | Unchanged 5-second statement limit |

The independent review's 100,000-row baseline timed out unfinished at about one
second; that baseline is reviewer-supplied, not a new production measurement.
These fresh timings are from the final gate on disposable native PostgreSQL.
The full snapshot equivalence tests and the unchanged final admission/matcher
bytes establish preservation alongside the existing privacy negatives/own-value
controls. No statement timeout or other budget is raised.

The committed `docs/evidence/pr213-review-repair.zip` contains executable sources,
full logs, exact command/environment, the authoritative exit, individual source
SHA-256 pins and a manifest verified against every archived member. Its SHA-256
is in the adjacent `.zip.sha256` sidecar. The source pins exclude the archive and
the pin file themselves to avoid circular self-hashing. The generated frontend
stamp was captured as evidence and restored; application sources are unchanged
from the passing run. The public CI runs the same four test shards in parallel;
this local gate executed them sequentially.
