# WhatsApp admission and legacy-answer hotfix

Base: `0f72c6c2dee253e1d3730f87cce84d088b88c0a2` (merged PR #213).
Branch: `codex/whatsapp-admission-hotfix`.

The failure was in admission, before Graph transport. Bare retained lexical words were compiled as context-free literals. Dispatch then extracted match spans and checked those spans as standalone values, discarding their sentence roles. Snapshot unavailability shared the terminal private-match path. The durable-delivery migration reconciled acknowledgments but omitted old answer receipts.

## Per-file changes

- `ai/private-value-matcher.mjs`: dispatch-selectable occurrence context. Dictionary/grammar roles distinguish ordinary lexical uses from field/reference uses, without a product-word allowlist. Standalone, quoted and field-assigned values retain their identity; punctuation-separated identifier representations retain the literal ID matcher. Numeric, date, native-name and unfamiliar-identifier matching remain in force. Default provider-side matching is unchanged.
- `ai/private-payload-boundary.mjs`: pass the occurrence-context option into the canonical matcher. It defaults off; dispatch opts in.
- `automation/whatsapp/private-dispatch.mjs`: validate/normalize unavailable snapshots; preserve sentence context when judging foreign spans; distinguish owned certification from ordinary usage; tag safe privacy categories. Exact admitted bytes, recipient binding and owned-file checks remain in force.
- `automation/whatsapp/cloud-outbound.mjs`: handle privacy verdicts consistently at all public content send methods and in the final POST catch. An unavailable snapshot returns pending, allowing the existing one-minute queue backoff and original 24-hour expiry. Genuine private matches remain terminal. Logs contain category, retryability and correlation identifiers only; no matched text, terms, payload or upstream error detail.
- `supabase/migrations/20261121212253_whatsapp_admission_recovery.sql`: a new forward migration reconciles legacy pending answer receipts. A recoverable scoped text answer with an authoritative inbound event enters the existing queue with its first saved body. Expired windows and receipts lacking an originating event become unsendable. Handoffs with a fence/nonce, ambiguous claims, duplicate receipts or structured media/action state stay quarantined. Existing intents win, and replay does not reset handoff markers.
- `tests/whatsapp-admission-hotfix.test.mjs`: ordinary canned prose; recipient-owned certificates; private amounts, dates, names and IDs; same-word field-position adversaries; punctuated IDs; retryable network/status/shape failures; exact admitted bytes and recipient mismatch.
- `scripts/generate-private-value-sql.mjs` and `scripts/private-capture-baseline.json`: verify the immutable historical migration, byte-identical generated capture SQL and all capture inputs. Admission changes are fingerprinted separately in the new forward migration, avoiding a canonical-index rebuild for unchanged capture semantics. Actual capture changes fail closed and require an explicit forward upgrade.
- `tests/whatsapp-admission-revision.test.mjs`: rejects capture-input drift and historical SQL edits; requires regeneration for admission drift; verifies regeneration changes only the new migration.
- `tests/whatsapp-admission-recovery.test.mjs`: real worker retry after a snapshot outage, no first send, pending unfenced receipt, stored-body delivery exactly once after reconstruction, safe diagnostics; populated legacy reconciliation, replay, expiry/orphan handling, quarantine, no model regeneration and exactly-one stored-body send.

## Rollout contract

No production action was performed. Drain workers before applying the new migration, publish the matching code, then resume workers. The migration does not reset previously blocked verdicts or uncertain handoffs. Reopening already terminal production receipts would require a separate audited decision; this migration only reconciles pending receipts. The old immutable migration and every existing migration remain unchanged. No credentials, paid services, live AI calls or live WhatsApp sends were used.

## Verification

The targeted admission suite executed 31 tests with 31 passes, 0 failures and 0 skips. The real-worker recovery/legacy suite executed 2 tests with 2 passes. The early restricted-sandbox outbound/privacy/recovery selection passed all 7 test-file executions; its IPC-limited reporter emitted file totals. The final permission-enabled release gate reports individual tests. The production-boundary/recovery/revision selection passed 62/62 with zero skips.

The supplemental real-worker observability proof also passes: a foreign-workspace amount is terminally blocked before transport, its category/correlation hash are emitted, no matched amount/body reaches logs, and both queue and receipt become blocked. Its first local setup used an owner-owned amount; the successful send was the correct ownership control, not a foreign leak. The proof was corrected to seed a separate owner/workspace.

Final release result and preservation pins are attached in the evidence package. The preliminary release run was deliberately stopped for the punctuation-identifier audit addition; it is provenance only and is not represented as a completed pass. An initial restricted sandbox invocation could not run an existing child-process OCR test (`EPERM`); the unchanged command was rerun with localhost/child-process permissions. The next run exposed an optional receipt column absent from a historical schema fixture; a same-branch follow-up commit made that lookup schema-compatible, and the original permissions test plus both recovery tests pass (3/3). Interrupted runs are retained as provenance, never as completed passes. No existing assertion or test file was changed.

The release artifact check initially detected the admission fingerprint change. Rather than editing an applied migration or invalidating its populated global index, the generator now enforces unchanged capture SQL and inputs and publishes a separate admission revision in the new migration. Original generator assertions remain intact, and adversarial generator tests cover both contracts. The interrupted fingerprint run is preserved as provenance only.

## Completed clean release gate

`npm run check:release -- --shards=4`, clean unset environment, exit 0.

| Shard | Tests | Pass | Fail | Existing skips |
|---|---:|---:|---:|---:|
| 0 | 1831 | 1830 | 0 | 1 |
| 1 | 1107 | 1107 | 0 | 0 |
| 2 | 2036 | 2035 | 0 | 1 |
| 3 | 1498 | 1497 | 0 | 1 |
| Total | 6472 | 6469 | 0 | 3 |

Typecheck, the 43-scenario production battery, offline-route child 2/2, and frontend build/postcheck passed. 437 pre-existing tests-directory files remain byte-identical. No new skips or timeout/budget changes.

Full logs, commands, regression source, per-file pins and historical interrupted-run provenance are in `docs/evidence/whatsapp-admission-hotfix.zip`; its SHA-256 sidecar is adjacent.
