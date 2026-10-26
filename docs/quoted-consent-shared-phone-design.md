# Quoted consent and shared recipient numbers

Implementation scope for this PR: keep `UNIQUE(workspace_id, phone)` on `whatsapp_consents`.
This describes routing scope, not an owner consent grant. Legitimate cases where one
contact represents multiple business customers remain an open product/model gap.
An explanation of the collision does **not** make Customer A send eligible.

## Independent fixes included

Printed invoice-number extraction uses explicit label/value positions, including
column-ordered selectable text. It rejects labels, placeholders, calendar dates
and conflicting candidates. Alpha invoice identifiers remain valid. A PDF with
an invoice-number label but no verified candidate stays unknown, including on
provider fallback. Existing saved invoices are never repaired automatically.

Authenticated Meta ingress retains a bounded `context.id` as `reply_context_id`.
The durable inbox's insert-ignore semantics preserve the original ID, text and
provider timestamp across duplicate deliveries and worker retries. A reply ID
is only a lookup hint. It is never a customer identifier or authorization.

The verified `whatsapp_owner_save_phone` result emits an `ownerReceiptRef` with
source inbound ID, owner ID, customer ID/version/phone and optional invoice
ID/version. The existing owner reply store persists it on the outbound receipt,
without changing the owner recipient columns. Both phone-recovery and pending
invoice-phone paths retain it. Resolution requires a uniquely matched accepted,
sent, delivered or read bot reply in the current workspace and owner phone;
the original inbound source; current verified owner authorization; unchanged
customer/phone and invoice/customer binding; and a maximum receipt age of 24
hours measured from the current message's source time. A one-second ordering
tolerance accommodates Meta's whole-second timestamps. Pending/failed, user,
unrelated, unbound, foreign, deleted, changed and expired references cannot bind.
Old receipts are not backfilled by parsing prose or guessing from history.
The owner receives one customer-and-invoice clarification when binding fails.
The native regression uses the actual outbound preparation/recipient-scope and
receipt-completion path with a fully intercepted Graph transport; no real send
is used to establish the test receipt's accepted status.

Consent is a dedicated deterministic operation, independent of the planner.
The database verifies exact original source text. It separates a narrowly
specified `send them/him/her/the customer a reminder` clause and optional
`(the invoice is due tomorrow/tommrow)` from the affirmative clause. Present
`they approve` / `he approves` / `she approves` / `the customer approves` requires
both a verified quote and that explicit reminder request. Existing explicit
agreed/consented instructions remain supported with an exact subject and whole
affirmative clause. Bare approval/yes, questions,
negations, conditions, historical reports and quoted external words do not
grant consent. The write keeps the complete original message as evidence;
it never manufactures an “agreed to reminders” statement.

The current shared-phone collision names the scoped customer holding consent
and the requested customer. It explains that the grant covers only the former,
that repeating clear consent cannot resolve the model limitation, and that a
genuinely different recipient number (if one exists) or future separate grants
are the available paths. No phone changes, transfers or rebindings occur.

Mixed due-date statements are preserved. “Tomorrow” is resolved as the next
calendar date in the workspace owner's timezone using the **original provider
timestamp**, including DST and month/year boundaries. Missing timestamp or
invoice binding requires an exact-date/target clarification. The reply displays
the computed date and a precise instruction for the existing date-update flow;
it makes no date write. Stored null dates remain null and ineligible for
reminders. This PR does not add a new automatic date-update/approval protocol.

No current consent text dispatches, previews, approves, activates or queues a
reminder. After target/date/consent eligibility is resolved, the owner still
requests the existing exact reminder preview and approves it in a later turn.
Financial, accounting, STOP, template, customer-window, contact-hour and test
recipient gates remain in their existing paths.

## Reader/writer inventory and why a uniqueness-only change is unsafe

| Surface | Current semantics | Required for separate grants (not implemented) |
| --- | --- | --- |
| `consent.mjs`: `getSendEligibility` | One row by workspace/phone via `maybeSingle`; current phone/customer must match | Require exact customer ID for recipient sends and select by workspace/customer/phone; no fallback to an arbitrary grant |
| Outbound, approved/cloud reminders, commercial recipient wrapper, test sends and proof/owner tests | Call that phone-based eligibility API; many callers additionally compare returned customer ID | Thread the intended customer through every initial/final/post-claim eligibility check; retain owner identity-specific checks |
| `resolveActiveBindings`, inbound routing/history | Returns current active customer bindings; inbound refuses multiple identities | Preserve refusal when the same phone has multiple eligible customers, even within one workspace; require separate explicit recipient-side targeting before customer data access |
| `whatsapp_owner_record_consent` | Exact source-backed owner instruction; conflicts if phone grant belongs to another customer | Insert/update only the target customer's grant and evidence; no copying from the other customer; keep source receipt atomicity and replay mismatch checks |
| `whatsapp_record_verbal_consent` | Dashboard/member RPC uses `ON CONFLICT(workspace_id,phone)` and can replace active attribution | Change to exact customer key; remove customer transfer semantics; retain member/current-phone/STOP checks |
| `app.owner_contact_phone_consent` | Owner contact saves insert assumed consent if phone is unclaimed; never overwrite conflict/revocation | Decide explicitly whether assumed grants remain appropriate on shared contacts; do not create implicit A consent from B's existing grant |
| Owner verification, verified-owner resolver, unbind and owner consent repair | Rely on phone consent joined to the marked owner customer; several writers conflict on phone | Use the exact owner customer grant; prevent debtor grants affecting verification; decide scope of owner disconnect without weakening recipient STOP |
| SQL reminder preparation/authorization, invoice update claims | Usually join workspace/customer/phone and snapshot consent ID/version | Audit each installed function; ensure no phone-only scalar selects remain; stale consent changes must invalidate exact customer snapshots |
| STOP/refusal, global/workspace suppression, START/UNSTOP | Phone locks; suppressions keyed by phone (and workspace); revocation updates all matching rows; START restores eligible prior grants without reattribution | Keep phone-wide scope and stable phone locks; STOP must revoke/cancel **both** customers, including queued/in-flight sends; START must restore only prior eligible grants, never manufacture another customer's grant |

## Proposed future model (review required before implementation)

Replace `whatsapp_consents_workspace_id_phone_key` with
`UNIQUE(workspace_id, customer_id, phone)`; retain the existing consent primary
key and composite customer foreign key, categories, sources, provenance,
revocation fields, RLS and phone-format checks. Preserve phone-wide global and
workspace suppression keys unchanged. Do not backfill/copy consent from B to A.
Keep an index on `(workspace_id, phone)` for phone-wide suppression/owner lookups
and an active-phone index if query plans justify it. Change every conflicting
writer and phone-scalar reader above together, with an explicit recipient
customer parameter that is required in all send paths. Owner service messages
continue to use verified owner identity rather than debtor eligibility.

Future tests must cover independent explicit A/B evidence and revocation;
same-phone duplicate and concurrent grants; no ownership or consent transfer;
current/deleted/rebound customers and phone changes; no-guess inbound ambiguity;
all initial/final/claimed-send gates using the intended customer; exact consent
snapshot invalidation; phone-wide STOP before, during and after queued delivery;
START order/idempotency without new grants; owner verify/unbind/repair; member,
foreign-workspace and role ACL denials. This wider change is deliberately absent
from this PR.

## New migration review and rollout

`20261026045045_quoted_owner_consent_source.sql` is additive ingress/receipt
metadata plus service-only function changes. It does not change consent
uniqueness or run a data backfill. Existing applied migrations are untouched.
The Supabase CLI is unavailable in this workspace (including its offline npm
cache), so the new forward migration was authored directly and tested against
the complete migrated local PostgreSQL fixture.

Before applying, review the exact source ID, workspace, owner, customer and
invoice bindings; SQL null handling; phone/invoice/customer lock order; existing
RLS and table grants; explicit service-only EXECUTE grants and revoked PUBLIC,
anon and authenticated access; and the phone-save result drift assertion. The
migration is transactional and checks exact predecessor body hashes for both
phone-save and consent endpoints before changing either. The consent allowlist
contains only original `e5364b8b1a42d345d89c9a5e22c7f031` and audited production
`ac329ad4b7e87435228139dc77ad68bd` (whitespace-only difference); phone-save must
still match `7627fff07f418024d07dc0722b5cccc2` exactly. There is no runtime source
or comment normalization. The exact audited body is a byte-preserving fixture;
tests verify its MD5, whitespace-collapsed equality and unchanged line content
against the original, acceptance of both bodies, and atomic rejection of a
hotfix, a comment change and an unlisted whitespace variant. Local tests verify
atomic drift refusal, non-superuser installation, RLS and endpoint/private-helper
ACLs. Concurrent SDK retries are tested on the embedded database; that is not
proof of production multi-connection race behavior.
Apply it before the corresponding application rollout only after review. No
remote application, production data correction, new environment variable or
Meta-side configuration is performed or required by this code change.

The tests are isolated code/database evidence, not proof of a genuine customer
journey. No paid provider, accounting, Meta, live consent or production data
writes form part of this verification. Shared-contact multi-customer sending
remains unimplemented and must not be described as fully fixed or sellable.
