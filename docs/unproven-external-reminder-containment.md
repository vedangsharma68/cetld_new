# Unproven external reminder containment — independent review packet

This is containment, not provenance capture. The invoice model does not persist
an authoritative immutable original provider-account binding for legacy **or
newly imported/exported** linked invoices. Current connection identity, metadata,
verified flags, token refresh, exact external ID and matching financial facts do
not supply that proof. All externally linked reminders are intentionally
unavailable until a separately reviewed binding implementation exists.

The source risk is conditional: a current-account read with matching ID/facts
could satisfy the old evidence checker after an organization change. No real ID
collision or wrong-organization send is known. The previously observed test6774
local sent/USD versus remote draft/INR mismatch was a different case, already
rejected financially; it is not evidence of that conditional risk occurring.

## Reviewed behavior and authority map

- `externalReminderRead` refuses linked records before token/provider work or
  evidence generation. The integration's `reminderInvoiceState` also refuses
  directly before even reading the connection. There is no refresh workaround.
- `reminderPaymentRpc` refuses before its pre-RPC callback or any reminder RPC.
  Local-only records keep their original unwrapped RPC and callback behavior.
- WhatsApp owner preparation loads canonical external linkage before contact
  recovery or approval; saved-row prepare/confirm also use the shared refusal.
- Owner dashboard/chat review rejects linked rows before reminder preview,
  proposal and approval calls. The authenticated owner store gives the existing
  conversation adapter bounded, owner/workspace-scoped saved-proposal and invoice
  reads; pending reminder confirmation is rejected before `owner_assistant_decide`.
  Missing bound resolvers fail closed; both web and WhatsApp owner transports
  supply them from authoritative saved rows, never caller account metadata.
  Ordinary context/history reads and cancellation/replay semantics remain; those
  reads do not establish authority. No customer/model/planner path is introduced.
- Approved and cloud reminder senders refuse saved linked invoices before review
  RPCs, gate reservation or HTTP dispatch. The local reminder payment checker
  routes linked saved rows through the same refusal.
- SQL `reminder_external_read_matches` always returns false, independent of role,
  GUC evidence, account metadata, financial equality or diagnostic output.
- SQL `reminder_local_status_payable` accepts only local-only sent/overdue rows.
  Existing `whatsapp_owner_reminder`, `app.owner_assistant_reminder` and its
  template-gate variant, first-party final authorization and signed-receipt
  continuation use that predicate and/or the local payment checker. Their
  protected bodies, signatures and ACLs are otherwise unchanged.
- Due-claim creation excludes linked candidates and rechecks the locked invoice
  in the approved-reminder variant. Generic delivery authorization independently
  rejects linked invoices, including existing crafted claims. Inline linkage
  checks preserve the base invoker variant without granting private helper access.

Unwrapped RPCs remain fail closed. `_with_external_read` compatibility wrappers
retain their signatures and service-only ACLs, but cannot grant linked authority.
No metadata, caller-selected account or diagnostic payload enables this path.

PR199's isolated `POST /api/accounting` action `invoice-diagnostic` is unchanged.
It remains a bounded current-account diagnostic with `provenance_unverified`,
never linkage ownership, original export-destination proof or reminder authority.
No new API function/package/config/gate/skip or billing change is included.
`vercel.json` and the 12-function Hobby budget are preserved.

## Exact migration artifact

File: `supabase/migrations/20261026090000_contain_unproven_external_reminders.sql`

- Encoding: UTF-8, LF; **7,774 bytes**.
- SHA256: **`434713cb5fcf70ed746e26492d403f8be41387c593660931e2f237f8501445c2`**.
- One transaction, one DO block, replacing only four existing function bodies.
- No table/column/trigger creation, new function, grants/revokes, business-row DML,
  provenance persistence/backfill, invoice/customer/snapshot/queue repair or edits.
  Existing claim functions retain their original business DML inside their
  definitions; the migration does not execute those function bodies.
- All source/ACL preconditions are checked before replacement. OIDs, owners,
  invoker/definer mode, language, volatility, leakproof flag, function search paths
  and ACLs are preserved and checked after each replacement. Other installed
  functions are unchanged. Existing invoice/payment/consent/suppression/customer/
  phone/template/version/idempotency/time-window/receipt checks remain.
- Catalog hashes are calculated with transaction-local
  `search_path=pg_catalog,public`. Original function search paths remain empty.
- Private predicates permit only owner EXECUTE; the public core gates additionally
  permit service_role EXECUTE without grant option. ACL drift is rejected.

### Exact source predecessors

These are SHA256 hashes of UTF-8 `pg_get_functiondef` under that canonical catalog
search path, derived from offline source replay. They do **not** attest that a
live installation matches. A chronological replay of all main migrations matches
the approved-reminder hashes. The base invoker variants are separately audited
and exercised by executable tests.

| Function | Accepted predecessor SHA256 |
|---|---|
| `app.invoice_has_external_ledger(public.invoices)` (dependency only; unchanged) | `80321aeca14fc9c5f333f74ab938ff238a99869b7645edabb91235a4e6dfecde` |
| `app.reminder_external_read_matches(public.invoices,uuid)` | `73dafbdb036ae4dc03431dc547f2f63fbc40e4f7536c23437e1f982450883ce9` |
| `app.reminder_local_status_payable(public.invoices)` | `e36d0a1f718bf10ae9005f9ed2cb628199e54a50610803f69c7a4c696be4b57a` |
| `public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)` — approved | `ed0ea611b1367778031fe4c6d4e9b8e086e7eb3659a0764a1afaffa9a880ee23` |
| Same — base invoker | `70bc302dc086e6da8321a16439591669e97856e876fd5db1427d65901b279464` |
| Same — audited approved CRLF body (31 CRLFs) | `1f8e4b305c3442b429f273f165ee15abf4286e6c3cf10e39f616b466621dfd88` |
| `public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)` — approved | `c579a14174d421dc6ac71452ef0ac7502ffebed1e5a2f18b6b1e08812849e1a1` |
| Same — base invoker | `7e648b333362bd3fb554c6c81cace69f897797c479c264b010cc4fb18ae628a0` |
| Same — audited approved CRLF body (31 CRLFs) | `dc81b47567de1b6ed3a437c48317eee93f61aa31162b23e199fd17db8494d889` |

Missing/unknown/modified source, unaudited line-ending changes, an unexpected patch-point count or ACL drift
aborts atomically. There is no fallback, silent normalization or unguarded
replacement. The migration is intentionally not a general-purpose reapplication
script: already-contained function sources do not match its predecessors.
Review unexpected live drift separately rather than changing the allowlist to
make an application pass.

### Audited CRLF compatibility, without source normalization

Independent production **read-only** review reported the two exact approved CRLF
hashes above; the three private predicate hashes matched the existing allowlist.
The coding agent reproduced both public definitions from main's approved-reminder
migration in an isolated DB, converting only their bodies to CRLF. Each has exactly
31 CRLFs, no bare LF/CR in its body, and CRLF→LF conversion yields byte-for-byte the
accepted approved LF definition/hash. No live access was used for this reproduction.

Acceptance requires the **original raw hash first**, then checks that a temporary
normalized audit copy matches the corresponding exact LF predecessor and has the
audited CRLF count. That copy is never executed. Replacements use the original
function definition; postconditions enforce the same 31 CRLF body endings. Owner,
security-definer/private-invoker mode, empty function search paths and ACLs remain
unchanged. No arbitrary normalization, base-invoker CRLF alias, mixed endings,
extra newline or content drift is accepted.

`tests/fixtures/external-reminder-containment-lf-only-predecessor.sql` preserves the
published `3eb9b2ad` migration (6,228 bytes; SHA256
`1beb8ed28d0e6f255dc210dc1f3d515f72ccb3da16ec8e5879228ede55eba6ee`)
for an executable rejection regression. It is a test fixture, **not** an additional
migration. The test first proves that artifact refuses the production-shaped CRLF
predecessors atomically, then proves revised acceptance changes exactly four bodies
with business rows/security/ACLs intact. Unknown CRLF/content changes still fail.

The Supabase CLI was absent in the coding environment. In accordance with the
instruction not to install packages, the timestamped file follows the repository
migration convention without installing a CLI. No remote SQL was applied.

### Independent operator review (read-only)

First verify the exact bytes/hash above. A trusted operator can inspect the five
catalog definitions, UTF-8 hashes, owners, ACLs and security modes in a read-only
transaction; no customer/provider data is needed:

```sql
begin read only;
set local search_path=pg_catalog,public;
select p.oid::regprocedure as signature,
       encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') as sha256,
       pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, p.proacl,
       (length(p.prosrc)-length(replace(p.prosrc,E'\r\n','')))/2 as body_crlf_count,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
where p.oid in (
 'app.invoice_has_external_ledger(public.invoices)'::regprocedure,
 'app.reminder_external_read_matches(public.invoices,uuid)'::regprocedure,
 'app.reminder_local_status_payable(public.invoices)'::regprocedure,
 'public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)'::regprocedure,
 'public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'::regprocedure
);
rollback;
```

Independent migration approval/application and code deployment remain required.
Applying the SQL containment first prevents older workers' crafted/old evidence
from authorizing linked reminders. JS deployment then removes the unnecessary
external reads entirely. Already saved approvals/claims are not cleaned up;
future claim/approval/dispatch and receipt-continuation checks refuse linkage.
No automatic rollback to the old permissive evidence predicate is proposed.

## Executable verification

All DBs, credentials, recipients, invoices and provider/Graph transports are
isolated fixtures. Provider callbacks are sentinels: the containment tests require
zero invocation even for same-ID/matching facts, organization switches, a possible
switch during read and expired credentials. Forged/malformed account bindings,
legacy evidence, diagnostic output and direct privileged SQL calls cannot grant
authority. Tests compare existing business rows and all installed function
security/ACLs before/after migration and prove atomic source/security/ACL drift
refusal. Local-only sent/overdue queue, approval, dispatch, receipt continuation,
invalid-state, consent, deletion, scope and payment protections remain executable.

Historical fixtures that deliberately omit a prerequisite migration now defer
containment until prerequisites are installed. The contact-hours LF/CRLF source
fixture explicitly excludes later containment while testing its historical
predecessors; its assertions are unchanged. Containment has independent current
source/drift tests. No tests or CI gates are skipped or weakened.

Commands used (full results are recorded in the PR):

```sh
node tests/external-reminder-containment.test.mjs
node tests/external-reminder-containment-sql.test.mjs
node tests/external-reminder-verification-sql.test.mjs
node --import tsx --test --test-concurrency=2 tests/external-reminder-containment.test.mjs tests/external-reminder-containment-sql.test.mjs tests/external-reminder-verification-sql.test.mjs tests/accounting-invoice-diagnostic.test.mjs
node --import tsx --test --test-concurrency=2 tests/test-invoice-reminders.test.mjs tests/business-name-reminders-sql.test.mjs tests/shared-owner-assistant.test.mjs tests/reminder-review.test.mjs
node tests/contact-hours-sql.test.mjs
npm run typecheck
npm run check:release
git diff --check
wc -c supabase/migrations/20261026090000_contain_unproven_external_reminders.sql
sha256sum supabase/migrations/20261026090000_contain_unproven_external_reminders.sql
```

No production SQL/provider/customer read, live UI/WhatsApp/provider QA, dispatch,
merge or intentional deployment was performed. Offline tests and CI are not live
end-to-end proof, production containment proof or linked-reminder readiness.
