# Round 9: complete private facts and shared linguistic roles

The unchanged baseline is commit `19cf8208eb580fc6c592f19452da11621a458d31`.
The fresh eight-file review suite reproduced 324 tests: 127 pass, 197 fail, no skips, exit 1.
The focused baseline passed 1473/1473. Both clean release modes ran twice; each recorded
4159 total, 4156 pass, zero failures, three existing skips and exit 0. All 748 baseline
tracked-file SHA-256 pins were checked before implementation. Logs and command records
are in `work/r9-baseline-*`; the earlier accidental work-glob invocation is excluded.

## Semantic changes

| Finding | Origin of the defect | Shared repair invariant |
| --- | --- | --- |
| R8.1 | A narrow left prefix chose comma semantics. | Whole-clause agreement, quantification and locally tagged nominal roles choose collection versus scalar; noun modifiers and units do not change the value. |
| R8.2 | A fixed complement/predicate window decided whether registered names existed. | Registered identity is independent of the POS model; nominal, possessive, object and appositive roles distinguish grammatical uses. |
| R8.3 | Embedded names were handled only for Han. | Exact uncased spellings use grapheme identity and morphology independently of script. |
| R8.4 | Party projection stopped after one event/argument. | Every independent frame and coordinated party/quantity argument reaches the same projector. Later frames are bounded, avoiding repeated suffix expansion. |
| R8.5 | SQL scanned different numeric spans. | Both implementations consume the same content/glue span grammar; glue never extends a span. Field capture is independent of origin-watermark length. |
| R8.6 | A row-size guard became an input-size guard. | Complete inputs are parsed before completion. Large numeric graphs use bounded rows with full-run SHA-256, index and cardinality; matching verifies complete reconstruction. |
| R8.7 | Only source rows taught retention. | Verified computed measures are typed and retained through the existing scoped RPC before deterministic disclosure, for both audiences and owner tools. Capture failure prevents disclosure. |
| R8.8 | Fractions and magnitude abbreviations used separate paths. | Rational operators, native numeral terminals and magnitude aliases compose in one number grammar. Magnitude coefficients do not become dates. |
| R8.9 | Domain vocabulary and incomplete participant roles implied data provenance. | Complete finite actors and data-bearing arguments establish origin; pronouns do not become party names. Inferred parties never produce unscoped literal phrase keys. |
| R8.10 | Single-character names matched arbitrary substrings. | Single-grapheme names require lexical word boundaries; multi-grapheme registered spellings support attached native morphology. |
| R8.11 | Financial homographs triggered unconditional routing. | Both handlers share financial word-role resolution. Record presentation needs a record payload, rather than a bare person presentation. |

The English POS model is `wink-pos-tagger@2.2.2`, pinned with its transitive data in
package-lock.json. It runs locally, retains no transcript cache, and makes no network
requests. The canonicalizer revision covers its adapter and the dependency lockfile.
It supplies grammatical categories; it never supplies invoice facts or authorizes access.
Its complete 77,262-word membership/category inventory is compiled into sorted text
and typed offsets. The same unigram and contextual POS rules run without unused lemma
or sense object graphs. The compact adapter is checked against the upstream model
for every lexicon and WordNet entry; grammatical capabilities remain intact.
A fresh child-process probe enforces the unchanged 100 MB peak RSS limit after 1,000 matching cycles.

## Preservation and safety

The seven original round-5/6 batteries and all round-7 raw sources/executable assertions
remain unchanged. The existing two reviewed round-7 fixture corrections are unchanged.
The eight new review sources and harness are pinned separately; executable copies change
only relative imports and harness directory creation. Release integrity tests compare
the complete copies to those transformations. No supplied assertion, skip or timeout changes.

The owner-next-actions simulator now implements the required existing retention RPC via
its strict fixture store. That store acknowledges derived monetary documents only after
storing canonical keys. Its original assertions and business-operation rejection remain.

The older 20261028030825 migration remains byte-identical with SHA-256
`841034b20e9faee511248ed8ee2ebd7becab6c082003abee5489889f027c118d`.
Only the permitted 20261101120327 migration is edited. Lock order, workspace deletion
parent checks, cache generations, rollback, ownership and API grants are preserved.
New SQL helpers remain immutable with pinned search_path and explicit execution revocations.
The unchanged five-second source statement and 100 MB resource budgets remain in the gates.

All database mutation proofs use disposable local databases. Production remains held:
no merge, manual deployment, production migration/backfill, activation, outreach, account
changes or PR comments. Existing cutover fence/drain and coordinated-switch requirements
in private-chat-rollout.md still apply; a green preview does not authorize cutover.

## Verification records

Final commands, verbatim tails, actual exits, assertion preservation, source/migration
pins and exact-commit preview observations are recorded in `work/r9-closeout.md` and the
corresponding JSON/log/exit files. The final release gates run twice in each mode from
clean committed checkouts, with environments built from PATH, TMPDIR and npm cache only
(and EXTRACTION_ROUTE=offline for that mode). Generated frontend stamps are restored and
tracked hashes checked after each child exits. No gate result from another head counts.
