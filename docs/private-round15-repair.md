# Round 15: canonical admission at the serialized transport boundary

Reviewed base: `7a23ca02aae79ed4b61504c28c3532cf45862212`.

## Why the previous repairs escaped

R13/R14 required a positive grammatical classification before comparing some
retained values. An unrecognized collection predicate lost member provenance;
a missing personal verb frame let a noun exemption win; an unrecognized joined
suffix lost the registered name; and date scanning required independently
complete lexemes. Guarding earlier request fragments did not fix those missing
canonical interpretations or cover a later assembler's additions.

## Mechanism changed in R15

`private-payload-boundary.mjs` builds a workspace-scoped canonical value index.
`AIProvider` invokes a private constructor-supplied gate on the already serialized
JSON body inside `#fetch`, immediately before its transport call. The hook cannot
be disabled by generate-request data, is never serialized as provider metadata,
and runs for each attempted dispatch. The gate refreshes all retained workspace
keys, then checks assembled messages, history, decoded arguments/results, and
schemas. A denied payload makes zero HTTP requests; a failed snapshot fails
closed. Protocol constants and the exact immutable system policy have distinct
trusted provenance; a changed policy or dynamic system message is scanned.

Canonical Merkle fingerprints preserve decoded/reordered composite field values as well as their typed leaf candidates. Decoding cannot discard the identity of a retained whole JSON field.

The same index owns history eligibility, current selection, response admission,
tool admission, ordinary-memory writes and replay. Response and memory admission
refresh their snapshots too. Tests introduce new retained values after history
assembly, mutate assembled messages/schemas, and create private values during a
mock response. These tests verify the final gate, rather than only re-testing
an earlier classifier. All provider HTTP boundaries are intercepted.

The canonical candidate lattice keeps alternative meanings unless an ordinary
interpretation is established. Unknown numeric composition no longer means a
single scalar. Explicit scalar field types, singular agreement, genuine
placement operands and quantitative-dative valency remain scalar certificates;
positive collection phrase coverage is unnecessary. Unknown words or a possible
finite predicate cannot certify a common-noun phrase around a registered person.
Bare count-name and prepositional mentions remain personal candidates without a
verb-frame allowlist. Clear determiners, mass nouns, ordinary verbs/modals,
calendar months and instrumental grammar retain their ordinary readings.

## Compositional values and durable capture

SQL capture uses the same ambiguity-preserving numeric semantics before writing
completion markers. The five source sinks retain members independently of the
provider wrapper, audience and process lifetime. Explicit monetary fields keep
their scalar type; this does not change invoice amounts or commit payments.

Tamil postnominal focus/emphasis uses inverse phonological transitions (vowel
replacement, glide joining, virama restoration and focus linking), composed with
the existing case/oblique model. The worklist is memoized and consumes focus
features; it does not enumerate names or sentences. Korean contraction and
Hindi honorific protections remain unchanged.

Calendar canonicalization now resolves connected month/day/year constraints.
A month/year written once binds its incomplete coordinated endpoints. Compact
`date-range:` keys preserve inferred interval membership without enumerating
arbitrary numbers of dates. Independently complete date lexemes retain the
previous endpoint semantics and explicit-year distinctions. JS and generated SQL
project the same keys; raw field, declaration and long-field projections share
this model. Positive tests assert complete keys and later restatements, rather
than accepting equally incomplete parity results.

## Cold UPDATE budget

The old row trigger projected old/new documents separately for every updated
invoice, repeatedly walking shared fields and checking their capture state.
UPDATE transition images are now grouped by workspace, with all changed OLD and
NEW documents retained and typed fields deduplicated before canonicalization.
Linked identities are resolved first. This keeps atomicity, ownership, alias
failure rollback, generation invalidation and marker-last behavior. DELETE keeps
the lifecycle path. No statement timeout or RSS ceiling changes.

## Verification and preservation

The new baseline has 137 tests: 28 pass, 109 fail, including parent summaries.
It reproduces all four classes and the post-assembly dispatch hole. Preliminary
failures and their commands are preserved in the evidence, not presented as
release results. New tests add current requests, five durable sinks, both
audiences, all wrapper surfaces and replay, post-assembly mutation/freshness,
unknown-composition variations, and SQL/JS complete-key comparisons.

The clean unset gate runs the preserved batteries and every pre-existing test,
including the unchanged 100 MiB probe, five-second native INSERT/UPDATE proofs,
amount integrity, fail-closed behavior, Korean/Hindi/repeated-date controls,
owner/outsider deletion and rollback. Git blob identity audits preserve every
pre-existing tests-directory file. The pinned older migration remains immutable.
Fresh source pins are checked against exact-head codeload bytes before closeout.
No production migration, backfill, deployment, live provider request or merge is
performed. The referenced independent reviewer archive was unavailable here;
author-created executable probes are labelled accordingly.

The complete clean gate exposed a mixed-rational ownership regression: the new shared-calendar graph split `whole numerator/denominator` into adjacent calendar components, even though the ordinary date scanner already excluded intrinsic rational operands. Both graph tokenizers now consume mixed rationals atomically before calendar coordination. The added projection proof checks atomic quantity fields, declared sentence origins, complete SQL/JS aliases, final matching, and the preserved ordinary two-part-date negative control. The failed full run is retained with its actual exit and is superseded only after completing verification of the corrected commit.
