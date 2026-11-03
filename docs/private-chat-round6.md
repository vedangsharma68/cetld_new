# Round 6 containment repair

The unchanged independent reviewer specification is now in the release test glob:
`reviewer-round5-adversarial-production`, `reviewer-round5-origin-boundaries`, and
`reviewer-round5-party-and-magnitude`. Its 66 tests reproduced 11 pass / 55 fail
on 2accf46283a1957ff4c7c90081af289855052f92. Every test body and assertion is
preserved. Only import paths and the file-output hook changed. A separate gate
test pins the original bodies by SHA-256 (24 assertion call sites; zero changed).

## Canonical construction and provenance

`private-value-language.mjs` owns Unicode padding, grammar, scales, and the party
function-word set. The SQL generator emits the same character classes and data.
Key-set and decoded-document parity tests compare actual SQL and JavaScript
outputs, including supplementary-plane letters and nested serialized JSON.

* Decode JSON after stripping only leading/trailing Unicode White_Space/Cf.
  Decode serialized string values recursively, to the same depth bound of 32.
  Never normalize JSON syntax: compatibility quotes inside values remain values.
* A single SQL decoded-document traversal owns both origin predicates and durable
  retention. Routing, term writes, audit writes, memory writes/reads and the RPC
  therefore agree about nested documents and format-prefixed sources. The memory
  trigger retains their fields atomically and refuses ordinary provenance.
* Carry header party/numeric roles across empty comma-separated header fragments
  until a nonempty field consumes them, including nested role-bearing headers inside notes or correction declarations. Customer full names, formal components,
  amounts and dates persist through cancellation and handler reconstruction.
* Party components use Unicode L/M/N tokens and code-point lengths in both
  implementations. Single non-Latin letters remain identifying formal components;
  isolated Latin initials and grammatical articles/connectors do not become
  independent identifiers. Complete field/name keys remain protected. Native
  vowel marks distinguish native identities. Optional Devanagari-to-Latin
  reference aliases never collapse one native identity into another, or collapse
  double vowels in an already-Latin formal identity.
* A linguistic exception binds only a term in its own linguistic clause. A
  second etymology clause cannot exempt a private party reference elsewhere.
  Tools and model answers use strict screening without that exception.
* Numeric candidates use valid grouping first. Invalid multi-comma grouping is
  segmented into list members. An ambiguous two-part decimal is interpreted as a
  list only in an enumeration frame before the candidate (plural predication,
  between/among, pair/couple), never because a noun appears elsewhere. Thus
  `The figures are 1250,77` is a list while `Put 1250,77 on the shopping list`
  remains a decimal. Unrelated members never inherit another value's provenance.
* Consecutive-scale clusters and greatest-scale recursive number composition handle decimal/fraction heads and
  English/Indian scales, including lakh crore, million million, billion million, and trillion through quintillion.
  Descending remainders must fit their scale. Existing spoken lists, mixed
  digit/word numbers, grouping, locale decimals, native digits and dates remain
  under the same shared boundary.

`private-round6-production` exercises actual SQL-backed production memory and
real AIProvider HTTP serialization with intercepted fetch. It covers both
 audiences at current/restart, history, tool argument/result, model answer and
memory write boundaries. Native PostgreSQL repeats actual service-role writes,
Unicode party parity, inherited ACLs, bigint/UUID watermarks, concurrent locks,
timeouts, atomic rollback/resume, and the unchanged 59-update/five-second budget.

## Migration choice

Edit the unapplied `20261101120327_private_whatsapp_chat_memory.sql` in place.
The release owner verified that these privacy functions are absent in production;
this branch is not live. No claim is made about uninspected environments. The
older `20261028030825` file and migration ledger are untouched.

SQL changes in this round:

1. Generated party aliases now use code-point specificity, the shared function-
   word exclusion, digit-bearing tokens and native-only transliteration folding.
2. Generated word-number evaluation uses greatest-scale recursive composition and
   the expanded shared scale vocabulary.
3. Generated origin aliases carry the first field role over empty headers and
   use the shared JSON decoder to distinguish structured sources.
4. Add pure immutable invoker helpers `private_invoice_decode_json(text)` and
   `private_invoice_origin_documents(jsonb,integer)`, empty search_path, execution
   explicitly revoked from PUBLIC, anon, authenticated and service_role.
5. `private_invoice_is_document` and `private_invoice_has_origin` delegate to that
   traversal; `retain_private_origin_terms` consumes its decoded documents.
   Existing term/history/memory triggers consequently capture the same origins.

No tables, cursor ordering, role grants, source-table capture events, dispatcher,
Zoho provenance, dashboard, commercial-send policy or older migration change.
The migration filename is unchanged. Repin the final file before rollout.

## Test contact data

Generic owner/customer fixtures use NANPA-reserved +1 202 555-0101; the regulator
reserves 555-0100 through 555-0199 for fictional, non-working use:
https://www.nanpa.com/numbering/555-line-numbers

The Indian-default parser test keeps its existing synthetic sequential landline
pattern to cover national/trunk/country-code normalization. Operational QA policy
tests read the existing production policy constant instead of copying a personal
contact literal. Their transport remains mocked. No operational allowlist or
historical reminder migration changes. A gate regression scans test source for
the removed contact fingerprint without retaining its personal literal.

## Controls and scope

Ordinary chat still retains 20 positively tagged messages across reconstruction.
Unretained 100/2,500/77, shopping-list decimals, ordinary surname discussion,
capital-of-France questions and harmless answers remain provider-bound. Stored
formal references, including digit-bearing and one-character native components,
stay local. Existing different-year/nearby-date, Sharmila/Anuradha, and
किरण/करण, कमल/कोमल controls remain enabled.

Residuals retain their narrow prior scope: arithmetic-derived expressions,
scientific notation, hostile encodings/homoglyphs beyond the shared normalization,
relative dates without a stored restatement, arbitrary translations and invented
semantic name aliases. No ordinary large-magnitude wording or formal component
is waived. Ambiguous comma notation uses the grouping/enumeration rules above;
there is no claim that an unmarked decimal expresses a two-member list.

## Mandatory operator cutover (not executed)

Follow `private-chat-rollout.md`. Old code ignores readiness. Neither applying
first nor deploying first makes old provider traffic safe.

```text
1. Fence all API entrypoints, aliases and workers outside old/new application code.
2. Pause scheduled/manual callers and drain every old invocation; retain evidence.
3. Verify final SQL hash; apply the additive migration while the fence is active.
4. Commit/resume bounded backfill batches; reconcile truthful per-source completion.
5. Stage the new application only, verify every serving alias and synthetic controls.
6. Reopen traffic and retries only after completion, drain and containment checks pass.
Rollback: fence and drain again; preserve additive data; never reopen old provider chat.
```

No merge, manual deployment, production migration, backfill or external message is
part of this repair execution.
