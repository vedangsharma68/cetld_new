# Additional owner payment SQL approval packet

Status: draft for separate exact-file approval. Production application is not authorized by the code-fix/publication scope.

Exact proposed file: `supabase/migrations/20261009015001_owner_payment_factual_instruction.sql`

- UTF-8 bytes: **9,541**
- SHA-256: **`3dd5ce3a9cd02dc600a8a9b6074fef0fcab387acde8e72b1ad4b9c737462bb86`**
- Base application commit: `83b5374286b9f3ea3e0c193c3d4ecfc3f20bb8a2`
- Generated with Supabase CLI 2.79.0 `migration new owner_payment_factual_instruction`.

Approval must identify these exact bytes. If the file changes, this packet and the approval must be renewed. Review the complete linked SQL file; this description does not substitute for it.

## Actual impact

This is a transactional database routine change affecting future payment authorization and confirmation. It replaces three existing definitions: the private payment-instruction parser, the owner-invoice confirmation function, and the read-only partial-payment capability function. It broadens the bounded grammar for current explicit owner instructions and independently enforces an optional expected outstanding balance during confirmation. Capability version 4 proves the changed parser and confirmation together with the unchanged direct writer and amount-denial guard.

Installation contains no business-row insert, update or delete, no grants or revokes, and no ownership, security-definer or search-path changes. Routine security metadata is compared before and after replacement; unexpected changes abort the transaction. It does not replay event 252, create a proposal, record the USD 500 test payment, or send any owner/customer message.

Future recognized requests can prepare one scoped payment proposal through the ordinary runtime adapter. A later explicit confirmation remains necessary to record a payment. Confirmation still verifies the verified binding, source message, tenant, invoice reference, customer, currency, amount, invoice version, original payment history, external-accounting restrictions, and replay/idempotency constraints. Customer messages stay off and reminders are paused after confirmation. Amount requests cannot fall through to full settlement.

## Exact source guards

Only the verified predecessor or exact successor source is accepted for each replaced routine. Uniform LF and CRLF sources are supported; mixed endings and unknown sources are refused. All five final normalized fingerprints are asserted before commit, and any mismatch rolls back the complete installation.

| Routine | Verified predecessor MD5 | Successor MD5 |
| --- | --- | --- |
| `app.owner_payment_instruction(text)` | `fc9b0e7319181b59fd716de8f87acc0f` | `dd97384b7b854a80c68357b6afa68ca5` |
| `public.whatsapp_confirm_owner_invoice_action(...)` | `0bd5f0e6ca732a8cbe7ddedee64acb45` | `9a949d277cc600d6cb7f17964954465e` |
| `public.whatsapp_owner_partial_payment_capability()` | `c4ee04ea738de234c5d608fba0f5ef1e` | `1b3efde31f586c71bc03be4dc953cf43` |
| `public.whatsapp_apply_direct_owner_write(...)` | `2b66000528ea1d8a34dd483ce040b307` | unchanged |
| `app.owner_payment_amount_mentioned(text)` | `cdf7e0257ebe342c904acfb937935d73` | unchanged |

Fingerprints were derived from the repository migrations in isolated PGlite. No separate production routine-source or ACL inspection was used.

## Validation and deployment boundary

`node --test tests/owner-payment-factual-grammar-sql.test.mjs` passed all five tests: ordinary clause/reference composition and JavaScript/SQL parity, negative authority/ambiguity/directive corpus, version-4-only runtime availability, exact reapplication with row/security preservation, all-five-routine drift refusal, uniform CRLF predecessor/successor handling, mixed-ending refusal, and atomic rollback on an incorrect final pin.

The application requires capability 4 before amount proposals and typed/button confirmations. Missing, older or invalid capability fails closed. Publishing application code alone cannot enable the new payment path on capability 3. Applying this SQL requires separate approval and must not be coupled to a new live bookkeeping test.

The previously approved `20261008193550_invoice_review_inferred_currency_unpaid_correction.sql` remains exactly 22,759 bytes, SHA-256 `949b2e2eda5ac68e331b0b9f6e3b7322174b67d19c8e8c635eec617b3d3e5117`.
