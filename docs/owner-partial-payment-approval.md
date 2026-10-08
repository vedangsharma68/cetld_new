# Partial owner payment: separate SQL approval artifact

Status: prepared for review only; not applied to production. Runtime may be deployed before this SQL: the capability proof fails closed and does not create an amount payment proposal on the old schema.

Exact SQL: `supabase/migrations/20261008031733_owner_partial_payment_confirmation.sql`

SHA-256: `6a9a1dafb29e8c7367fafe3d1444915a1e3297e6505ad1957151af5cff014c42`

The migration was created with Supabase CLI 2.79.0 (`/tmp/supabase migration new owner_partial_payment_confirmation`). It changes routine definitions only. It performs no invoice/payment/message/table data writes during application, creates no tables, changes no schema columns, and preserves the existing two public routine ACLs exactly. It creates one private parser with EXECUTE revoked from PUBLIC/anon/authenticated/service_role, plus one read-only SECURITY INVOKER capability RPC with EXECUTE granted only to service_role. No existing privilege is expanded.

| Existing routine | Allowed predecessor `md5(prosrc)` | Exact patched `md5(prosrc)` |
| --- | --- | --- |
| `public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)` | `abcea06cef9727248dba104703ca7268` | `4e91e1fc34a0b0e639673a4d39632fd7` |
| `public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)` | `2e817f4bb2dca966b03cbfc015720152` | `6ed00f9c4aaabdb7673272ccef3d1390` |

The exact patched pair is accepted as an idempotent reapplication. Any other installed source aborts the entire transaction; each replacement also checks that its exact insertion anchor occurs once. These are offline source-chain fingerprints, not a claim that production was queried.

New routines:

- `app.owner_payment_instruction(text)`: strict current inbound amount/currency/invoice/customer instruction parser. Patched source MD5 `39f1711c4d93b873013fedb9ce7cf54c`.
- `public.whatsapp_owner_partial_payment_capability()`: read-only capability proof requiring all three exact patched source hashes. Runtime checks it before preparing and confirming amount proposals, including button decisions.

The model may select `workspaceData` with `operation:create`, `table:payments`, one `invoice_number eq` filter, and exact `amount`/`currency` values. The current owner message must itself request that invoice, amount and currency; quoted, negated, historical, questioned and ambiguous requests do not grant authority. Payment operations are excluded from batches. Direct mode still prepares an amount proposal requiring later explicit confirmation. A requested partial amount cannot use the existing `status:paid` full-settlement route.

On a later confirmation, the existing verified owner binding, workspace, owner phone, pending identity/version/expiry and invoice version checks remain authoritative. The amount path additionally verifies the original inbound instruction, invoice/customer/currency/direction, preserved net payment history, remaining balance and external-ledger guard. It records exactly the amount using the existing atomic `record_invoice_payment(..., false)` RPC, appends the existing WhatsApp correction audit, preserves original payment/file/source facts, pauses reminders, and records the existing durable owner action receipt in the same transaction. It never refunds, transfers or reallocates money, and sends no customer messages. Success requires a receipt plus independent scoped payment/invoice readback; uncertainty never causes another write.

Offline evidence:

- Exact live instruction reconstructed through native Gemini wire, default handler/tools, Supabase SDK and PostgreSQL fixture. Baseline combined `356ba696321ab93adba3adb98ef17114a4440c5b`: seven-row workspace read, one-row target read, then tools disabled final, no proposal/payment. Candidate: seven-row workspace read, one-row target read, then one model-selected proposal; later yes records USD 500, amount paid USD 500, outstanding USD 451.52 on a USD 951.52 draft invoice. Source/file records and foreign workspace remain unchanged; no customer messages. Receipt replay does not write again.
- Old-schema runtime: missing capability refuses partial payment, creates no pending payment, and later yes/button creates no payment.
- Signed button path records USD 500; a later ordinary full settlement remains supported and records only the remaining USD 451.52.
- Currency/target/quoted/negated/question guards; original receipt preservation; tampered currency/source refusal; lost readback with exactly one write; source drift rollback; idempotence; unchanged ACLs; caps/checkpoint/native transcript regression.

Checks: `node --test tests/owner-payment-execution-loop.test.mjs tests/owner-date-execution-loop.test.mjs tests/whatsapp-owner-agent.test.mjs tests/direct-owner-write.test.mjs tests/workspace-data-security-review.test.mjs` (65 pass); `node --test tests/direct-owner-write-sql.test.mjs tests/whatsapp-owner-action-buttons.test.mjs` covered by the 44-pass combined SQL/button run; seven new native tests pass together. `npm run typecheck` and `git diff --check` pass.

Production application requires separate approval for this exact SQL hash. A live dummy test must start with a genuine new amount proposal produced after capability activation, then confirm that specific proposal in a later owner turn. Do not blindly retry the earlier failed live payment attempt.
