# Round 14 consolidated repair

Reviewed base: `108f76e8e21a5e51f9b9ee5af71eb56f5bb3054d`.

The author baseline reproduced the four privacy classes (197 tests, 58 pass,
139 fail, including parents). One new fixture's forbidden invoice hard-delete
was then replaced by clearing notes before resetting retention; all assertions
remained. This exposes the complete sink matrix (239 tests).

## Shared role and boundary changes

* Numeric cardinality survives representation predicates. The WordNet pinned
  reading/display/signal/inclusion/equivalence verb closures, including all
  inflections, retain the represented subject's nominal spine. Valency still
  separates a scalar destination object from a collection or ordering operand.
  The same generated inventory drives SQL and JS; this is not a sentence list.
* A known person can occupy a ditransitive recipient slot or an object NP with
  adjectival/adverbial modifiers. Governors are found across those modifiers.
  Full WordNet argument frames and count/mass lexical roles distinguish a bare
  count-noun identity from ordinary mass nouns. Determiners, modal/month,
  imperative, vehicle and independent-name controls keep their existing roles.
* Korean zero-copula contraction checks the actual vowel-final nominal surface,
  including honorifics, before applying the full ending/pre-ending/focus model.
  Tamil case/focus composition uses decreasing inverse sandhi transitions for
  vowel elision, virama restoration, glides and focus linkers; stacked focus
  operations share the same model in SQL and JS. Existing Hindi morphology is
  preserved. No unrecognized lexical continuation licenses a name substring.
* Calendar scanning accepts fixed-arity lexemes at each lexical start, then
  resolves overlapping/crossing interpretations. A range/list separator after
  a complete date does not invalidate its endpoint. Invalid maximal lexemes
  suppress contained suffix interpretations. Full dates own their spans;
  collection ambiguity applies to yearless two-component numeric forms only.
  The scan uses bounded grammatical lookahead, not a source-length ceiling.

## Memory and source-write resources

The runtime previously materialized the complete Wink object graph, duplicate
entry arrays and POS strings, and a complete verb-root map. The replacement
retains every lexical row and ordered tag in indexed packed text; a bounded hot
lookup cache does not limit accepted vocabulary or input. Build-time generators
retain full dictionaries. Native segmentation and morphology regex compilation
are lazy, with shared segmenters. The unchanged seven-process RSS probe is
recorded in `work/r14-rss-before.json` and `work/r14-rss-after.json`.

The native scale INSERT previously performed document/path projection and
lock/generation lookup for every source row and field, initializing unrelated
alias branches. INSERT transition rows are now grouped by workspace and typed
fields deduplicated before capture. Linked parties are projected first, schema
status values removed per document, and every supplied field retained. Field
capture dispatches on the supplied role; completion markers remain last in the
same transaction. Updates/deletes retain the old/new row lifecycle path. Lock
order, workspace deletion guards, ownership/ACLs, rollback and generation
invalidation remain enforced. Numeric-only text avoids impossible origin work.
The five-second statement timeout and 100 MiB RSS ceiling are unchanged.

## Verification evidence

The new class suite covers current input for both audiences, all five wrapper
surfaces and replay, five durable sinks and reconstruction, SQL/JS full key-set
parity, ordinary inverse controls and additional grammatical variants. The new
model test compares every pinned lexical row/tag and the full numeric POS map.
The new batch test checks unchanged source amounts, enum exclusion, full member
retention, API denial and complete rollback on alias failure.

The evidence archive records actual commands, environments, exits, outputs,
retention snapshots and intercepted provider bodies. The clean gate executes
all preserved batteries and native budget/integrity proofs. All pre-existing
`tests/` file blobs are compared with the reviewed base. No prior assertion,
skip, timeout or resource ceiling is changed. External reviewer archives were
referenced but unavailable here; author-created probes are labelled as such.
No production database, live AI request, deployment or merge is performed.
