# Round 10: shared quantity, participant and identity roles

Base: `7680678c4252465b1fb91fc5eea4a44461f653a1`.

The independent verdict identifies nine findings in four underlying classes. The
repair keeps source roles through durable projection and uses the same roles at
all existing provider and memory boundaries. No provider transport, capability,
statement budget, memory budget or existing assertion was removed or relaxed.

| Class | Findings | Defect and resulting change |
| --- | --- | --- |
| Supplied-fact capture | R10.1, R10.4, R10.5 | Collection cardinality was discarded when fields became retention keys; participant traversal depended on a conjunction; transfer events accepted one argument ordering. Shared quantity-role metadata now survives JS and generated SQL projection, including bounded graph rows. Participant/quantity tuples traverse comma, semicolon, newline and conjunction boundaries. Payment and receipt events accept participant-before-quantity and quantity-before-participant forms. |
| Reference and quantity grammar | R10.2, R10.3, R10.6 | Positive context requirements rejected registered nominal references; single-grapheme names could not carry personal morphology; ASCII mixed numbers were split into date-like components. Registered identity, grammatical use and lexical boundaries are evaluated separately. Personal honorifics/case morphology use the same Unicode normalization as names. Rational operands compose with magnitude operators before date projection. Soft clause separators cannot detach a private nominal constituent as an ordinary clause. |
| Ordinary lexical uses | R10.7, R10.8 | Uncased matching permitted word-internal substrings; redundant literal aliases bypassed identity grammar; noun/verb handling missed finite lexical uses. Native matching requires a lexical onset or a licensed personal clitic. Attested-party aliases share the identity classifier; contextual nominal and finite-verb roles preserve ordinary word uses. |
| Financial routing | R10.9 | Capitalized first-name references to Bill were treated as financial nouns. The shared intent resolver now uses nominal role, proper-name status and financial specification for both first and compound names. Known-private containment remains independent of routing. |

`ai/private-number-role.mjs` supplies quantity cardinality to screening and field
projection. The SQL generator renders its closed operators and pinned lexical
categories into the migration. Explicit collection graphs use a distinct typed
key so reconstruction cannot restore decimal-comma interpretations discarded by
the source role. Existing ambiguous numeric graphs retain their interpretations.
Graph integrity, full-field capture, completion ordering and cache invalidation
remain enforced. Migration `20261028030825` is unchanged.

The new executable tests use the existing disposable SQL fixture and actual
`AIProvider` HTTP boundary with a local transport interceptor. They cover every
reported example for both audiences, all five wrapper surfaces and subsequent
memory replay, five declaration sinks, scoped payment reports, scalar/list
negative controls, SQL/JS key parity and native/English ordinary-word controls.
The scoped payment test asserts capture of supplied facts; it does not assert a
committed ledger payment.

Before the production changes, the author-derived reproduction suite produced
135 tests: 18 pass, 117 fail, zero skip, exit 1. After repair, the expanded author
suite produces 137/137, the preserved batteries produce 66/66 + 75/75 + 267/267 +
324/324, and the existing round-9 semantic suite produces 8/8. The preservation
audit compares against the base commit and finds 14,598 unchanged assertion sites
across 316 existing test files, plus nine pinned supplied source files. The local
catalog audit checks 43 restricted helpers and six RLS tables.

These author-derived tests are not the independent reviewer’s four-file 201-test
suite. The referenced round-10 archive and recovered exact R8 parity script were
not supplied as an accessible file or URL at implementation time. Their execution
must be reported separately if those artifacts become available; the local parity
checks must not be described as that recovered script.

Only one clean unset release gate is required for this round. Its commands, real
exit status, exact commit/tree/file pins and complete output are recorded under
`work/` and included in the local review handoff. The repair is committed locally;
it is not pushed because the standing constraint prohibits deployment effects.
