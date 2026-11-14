# R16: recipient-scoped final dispatch and independent frontend builds

Base: 4a5a190804b90611b79575c21eb66c74ae9c4eca.

Every production WhatsApp POST now uses `private-dispatch.mjs`. It invokes the
same `createCanonicalPrivateValueIndex` as the model boundary, using a fresh
service-only SQL snapshot. No language, matcher, Tamil, Korean, Hindi, numeric,
or calendar grammar is changed.

The snapshot resolves the actual recipient and verified owner authority from
existing code-verification, membership and configured-phone proofs. Owners have
workspace-wide authority, matching existing owner reads; foreign workspaces
remain screened. Customer allowances come from their own rows and verified
business identity. Administrative approval prose is not a private-fact grant.
Canonical origin records are projected to their existing field keys before
ownership subtraction: every foreign field remains protected; unparseable
records remain fail-closed. A raw field is owned through aliases only if all its
canonical keys agree with owned facts. Whole opaque invoice/file identities can
consume their internal numeric fragments; they cannot authorize those numbers
elsewhere or conceal an enclosing foreign date/range. Unknown collection
interpretations must all be owned before their spans can be consumed.

Preparation occurs before the sender's existing final authorization. The final
scan is synchronous and sends the exact serialized bytes it admitted. There is
no new store read or serialization after authorization. Transport retries and
stored-reply replays prepare a new snapshot and screen the actual persisted
body. Synthetic platform proof IDs use compiler constants as whole identities,
like the immutable system policy; no user/message field receives that trust.

## Dispatch inventory

| Site | Uses | Final authority / boundary |
|---|---|---|
| cloud-reminders.sendReminder | candidate template reminder POST | snapshot before atomic reminder RPC; synchronous final scan |
| approved-reminders.sendReminder | scheduled, manually approved, freeform/template fallback, retries | same; final receipt/fallback payload scanned |
| reminder-proof.approvedReminderProof | fixed synthetic QA proof | snapshot before proof claim; final scan |
| cloud-outbound.postMessage | service text, buttons, template updates, owner test templates, media delivery, cached replies | snapshot after saved intent, before final claim/eligibility checks; final scan |
| cloud-outbound.sendTypingIndicator | read/typing status | same adapter, strict non-content schema; added content fields rejected |
| cloud-outbound.sendServiceMedia upload | Graph media staging | same adapter, filename screening; provider-only staging is distinct from client delivery |

Customer media delivery additionally binds the source invoice/file/recipient,
compares supplied bytes with the scoped storage object and binds the uploaded
Graph ID. Owner-generated media retains the existing verified owner authority.
Graph metadata/media GETs and template diagnostics are reads, not dispatches.
The mock provider performs no network send. Engine scheduling and receipt/retry
wrappers call the same providers above; they have no separate transport.

## Verification and fixtures

New checks exercise actual reminder providers and final serialization mutation
for collection numbers, lowercase personal references and shared dates, before
and after provider reconstruction; own reminder values remain byte-identical.
They also change STOP/invoice state during snapshot preparation, verify the
subsequent atomic gate denies dispatch, check cross-span identity/date handling,
media byte/upload binding, API-role ACLs and exact admitted-byte delivery.

Legacy sender-only doubles acquire the new dependency from disposable SQL, not
an empty mocked snapshot. Every such SQL store contains a foreign canary and
asserts that it remains protected. Real Supabase fixtures use the actual new
function. Existing test bodies and assertion sites are preserved; only sender
imports adapt those unit doubles, with additional tests appended separately.

Vercel builds only `npm run build:frontend`. CI runs every discovered test file
exactly once across four independent jobs (each retains the 30-minute timeout),
then the dependent verify job runs the production battery, typecheck, offline
route and frontend build. No timeout, memory ceiling, statement budget or test
assertion is relaxed. The full local gate can exercise the identical complete
partition with `npm run check:release -- --shards=4`; its normal unsharded mode
and injected command contract remain intact.

No production migration/backfill/deployment or live AI/WhatsApp request is part
of this work. The new snapshot migration is a required coordinated-cutover
prerequisite; absence or failure denies dispatch. The older immutable migration
is unchanged. The accepted Tamil pilot gap is untouched.
