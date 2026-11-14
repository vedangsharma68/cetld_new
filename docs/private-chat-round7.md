# Round 7 containment repair

The reviewed baseline is 61fea77c7c1bbfcf82a21bcc98bb6f8d28d7e2c7. Its
unmodified fresh reviewer battery reproduced 75 total, 14 pass and 61 fail.
The native diagnostic exited zero but recorded a missing alias and a completed
input; the gate wrapper now asserts that the replay actually rebuilds the alias.

## Shared parsing and provenance

* Enumeration frames accept a colon after a plural label or linking verb. The
  rule follows syntactic position; no literal invoice amount or noun is special.
  A singular shopping-list decimal keeps its whole-number interpretation.
* A grammatical formal-name component receives a `party-ref:` key instead of
  being discarded. Personal target slots, name-particle subjects and bare decoded
  values protect it. Articles, prepositions and ordinary vehicle uses keep their
  grammatical roles; whole formal names remain protected. SQL and JS emit the
  same component keys. Native marks and existing false-positive controls remain.
* Unicode dash punctuation and minus signs share the ASCII dash canonical form.
  SQL and JS use the generated code-point map at every boundary. Complete dates
  retain their explicit year, including typographic named and numeric forms.
* One origin grammar recognizes record identifiers and data-bearing relational
  invoice prose before routing or clause separation. A compact heading's next
  record field carries party provenance; amount-first and party-first prose
  derive typed amounts, parties and complete trailing dates. Nested declarations
  in notes use the same grammar and decoder. SQL guards, terms, audit and memory
  writers retain those fields before returning or suppressing ordinary memory.
* Long numeric runs have bounded ambiguity windows rather than a privacy wall.
  Known members and grouped spans are compared with retained keys; unrelated
  33/65/100-member lists stay ordinary. Match-time window size accounts for the
  retained numeric key length; no blanket overflow marker is used. Atomic complete
  numeric interpretations remain available. SQL/JS alias parity is tested.

Two old long-run fixture setups now explicitly retain member 600. Their original
containment assertions are unchanged: the case is actually private. The fresh
reviewer controls require unrelated long lists to pass. No assertion was weakened
and no test or skip predicate was removed.

## Privileged maintenance and completion generations

This is privileged maintenance invalidation, not a new API privilege. Existing
API roles still cannot delete or truncate retained aliases.

The unapplied 20261101120327 migration is edited in place. It adds internal
RLS-protected `app.private_invoice_capture_epochs` (workspace generations) and
`app.private_invoice_capture_state` (one global generation). Every API role,
including service_role, has all privileges explicitly revoked. No ledger or
reminder fields are changed.

The restricted stable invoker `private_invoice_capture_revision(uuid)` hashes
canonicalizer revision plus workspace/global maintenance generations. Retention
captures this stamp once, before alias work. A concurrent DELETE advances the
workspace generation and clears existing markers atomically; an in-flight writer
can finish with its old stamp, which cannot suppress later rebuilding. It does
not need to block the diagnostic's pause/delete/release interleaving. Marker
invisibility and normal same-input commit serialization remain tested.

A restricted security-definer AFTER TRUNCATE trigger advances the global
generation and clears completions in that same maintenance transaction. Existing
DELETE invalidation advances only affected workspace generations. Rollback
restores aliases, markers and generations together. The four-column completion
key shape stays intact; no API grant is expanded. Helpers keep empty search_path.
All source statement, migration and backfill timeouts are unchanged.

The older 20261028030825 migration and its ledger remain untouched. All production
effects are held. The external fence/drain in `private-chat-rollout.md` remains
mandatory for any later operator cutover; old application code ignores readiness.

## Release evidence

The four imported reviewer test bodies and all assertions are byte-identical.
Only their filesystem evidence hooks create `work/` for clean CI. The complete
native audit is copied byte-for-byte and executed by a gate test that checks its
race result. Five SHA-256 integrity pins guard these sources. The earlier 66
reviewer regressions and their existing three pins are unchanged.

`private-round7-production` adds real SQL-backed provider-serialization checks for
sibling declaration forms, every durable sink and restart, reference-name
false-positive controls, the Unicode dash class, explicit different years, and
related/unrelated long lists. Native PostgreSQL adds realistic ACLs for new state
and transactional workspace DELETE/global TRUNCATE rollback checks. Existing
watermarks, concurrency, timeouts, source latency and resumption proofs remain.

Residuals retain their previous narrow scope: arithmetic-derived/scientific
restatements, hostile encodings beyond the generated fold, relative dates without
an explicit retained value, unsupported language translations and invented
semantic name aliases. Ordinary typographic dates, formal-name references,
invoice declarations and unrelated long lists are covered, not residuals.
