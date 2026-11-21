# PR #213 — repair round 5

Reviewed head: `df251c1888f320f6241696535d1807574df2bf33`.

## P1 E — confirmation delivery is part of event completion

The round-4 sender correctly returned pending for an unavailable pre-fence
authority read, but STOP, START and verification worker routes discarded that
result. Processing the consent or linking side effect was mistaken for completing
its confirmation delivery. A scoped pending receipt could therefore coexist with
a done event and no Graph request. This was a gap in this PR's worker recovery
integration; the sender's authorization and admission checks were working.

All confirmation routes now use one result contract: pending means known-unsent
delivery and propagates to durable deferral, never a successful event completion
or a substitute fallback. This includes scoped/unbound STOP, START/UNSTOP, owner
link verification, unmatched-sender verification and failure confirmations.
Ordinary accepted, terminally blocked and uncertain results retain their existing
handling. No transport authorization or final-byte screening is relaxed.

Confirmation completion also reloads durable delivery state. A pending scoped
confirmation receipt
with no dispatch marker keeps its event claimable even if a route loses a result.
Reconstruction resumes the saved body before model/fallback routing through the
existing admission, claim and nonce fence. STOP revocation remains committed;
confirmation retry never restores consent. For unbound confirmations the existing
inbox claim/rearm/fence is reused, with pending deferral before generic fallback.
Normal replies retain their established accepted-result contract; their review
drafts are not treated as confirmation receipts.

A committed LINK changes the current owner binding. Its known-unsent unbound
confirmation therefore finishes the original idempotent linking protocol on retry,
rather than being reinterpreted as a new owner/model message. This condition
excludes every saved scoped reply, so a normal owner reply whose input happens
to resemble a linking command cannot be taken over by confirmation routing.

## Executable evidence

`tests/pr213-confirmation-recovery.test.mjs` exercises real disposable SQL stores,
SDK queries, inbound worker, sender, admission, reservation and fence. Only the
authority read fault and Graph transport are injected:

- STOP/START/unmatched verification/LINK verification: transient and terminal
  pre-fence reads, eight cases. The claim is committed and the fence has not run.
- Transient failures: zero initial confirmation requests, zero completed events,
  pending event with an error; reconstruct, deliver once, complete, then a third
  worker claims nothing. The scoped STOP receipt retains exactly the first saved
  body and reaches delivered through the real status callback store.
- STOP consent, workspace suppression and global suppression are snapshotted
  after revocation and remain exactly equal through retry and delivery.
- Terminal denials remain done/blocked with zero Graph confirmation requests.
- A saved ordinary owner reply cannot become an unbound LINK confirmation;
  committed-claim acknowledgement recovery sends its original body exactly once.

On the reviewed source, the first six-case baseline reported **3 pass / 3 fail /
0 skip**, exit **1**: each transient confirmation was prematurely completed,
while the paired terminal controls passed. No assertion in that baseline was
removed. The final expanded regression adds the LINK and normal-owner controls.

The targeted selection also includes all previously repaired reply losses,
pre-fence normal replies, both cutoff races, lost fence acknowledgement,
uncertain/historical quarantine and the native STOP → START/UNSTOP suite.

The first full verification attempt caught an overly broad draft of the new
completion guard: normal owner review drafts were treated as unsent even when
the existing injected transport returned accepted. The guard was corrected at
the intent-role boundary to apply to confirmations, preserving normal reply
contracts. No existing fixture, transport assertion or test was changed. The
failed full run is retained as development evidence; only the final recorded
exit-zero full run is the release claim.

All **426 pre-existing tests-directory files are byte-identical** to the reviewed
head. Signup, bookkeeping, outbound sender, admission/matcher and every migration
are unchanged. The three ordered migrations and existing drain/cutover contract
remain intact. No budget, timeout, assertion or skip is changed. No production
query, migration, backfill, deployment, merge or live Auth/AI/WhatsApp call occurs.

## Final verification

The final clean unset `npm run check:release -- --shards=4` reached real exit
**0** on the frozen repaired source: **6,379 tests / 6,376 passed / 0 failed /
3 pre-existing skips**. The production battery (43 scenarios), typecheck,
offline-route 2/2 and frontend postcheck also passed. The unchanged four shards
ran sequentially locally in **2,484.107 seconds**; parallel CI and its timeout
remain unchanged.

The expanded confirmation/recovery selection passed **32/32**. After correcting
the completion-role boundary, the focused confirmation plus unchanged attachment
suite passed **21/21**; every one of those tests also ran in the final full gate.
Normal reply recovery, both cutoff races, uncertain/historical quarantine,
approved-reminder exact parity, tagged-origin parity, populated build, signup,
bookkeeping and migration replay all passed in the full gate.

Fresh native measurements (local, not a production SLA):

| Profile | Measurement | Enforced SQL statement limit |
| --- | --- | --- |
| Populated build, 100,000 rows present before installation, all stages total | 1,338.090 ms | Separate statements; total is not a single statement |
| Slowest build statement | 437.816 ms | 1,000 ms in test; production migration remains 5,000 ms |
| 100,000-key snapshot cold / warm, every key asserted | 147.252 / 84.262 ms | 1,000 ms |
| 1,001-invoice snapshot cold / warm | 148.350 / 35.779 ms | 1,000 ms |

No existing assertion, skip, statement limit or resource budget changed. All
migrations remain byte-identical, including the three ordered PR migrations and
historical 20261028030825. No production work was performed.

Commands/environments, baseline and development runs, final full log/exit,
executable regression, call-site audit, preservation audit and source SHA-256
pins are in `docs/evidence/pr213-round5.zip`. Its `.sha256` sidecar pins the
archive; `pr213-round5-pins.json` records all changed files and actual results.
