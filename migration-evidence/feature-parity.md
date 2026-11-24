# Actual source to target migration inventory

Base: ff066b664d2750638e63adba8b64be1a8290c3b9, containing ceb899b; main remains9261380. Live schema metadata read November24, no data values.

| Existing capability | Target checkpoint | Remaining gate |
|---|---|---|
| Supabase password sessions | Auth.js Credentials/JWT, bcrypt compatible synthetic tests | Same-UUID existing-account import, bans/deleted/email-confirmed handling, forced sign-in at cutover |
| Supabase Google identity | Provider+subject links and verified open signup | Legacy identity import and actual Google callback configuration/roundtrip |
| Open signup (policy changed November24) | Credentials pending verification plus password proof; verified Google creates own business; no invite gate | Actual authorized SMTP delivery and external Google handshake; legacy verification-state import |
| Businesses/workspace_members | Server-scoped membership list; customer API uses memberships | Exact legacy role enum parity and settings/create-business module |
| Customers | Scoped list/detail/create/edit/delete, unit/route/native browser tests | Extension/integration/reminder columns preserved in target; API exposes validated customFields only, internal metadata not returned. UI custom-field editing, reminder approval side effects and import/deletion relationships still open |
| Invoice metadata and files | Reviewed metadata CRUD and guarded PDF upload/finalize/download, permanent cleanup tombstones | Legacy lifecycle/payment/reminder semantics, actual private bucket and file migration |
| Payments/balances/corrections | Not migrated | Accounting correctness/idempotency/parity tests |
| Zoho/QuickBooks/Tally | Not migrated | Provider secrets/OAuth/webhook protocol/tenant policy/parity |
| WhatsApp OCR/photo/PDF/chat/reminders | Not migrated | Repaired privacy and dispatch fences, real reply proof, callbacks and queue state |
| AI privacy projections and retained declarations | Existing source retained, not connected to new app | Translate server business functions without weakening exact privacy rules; no AI calls in this checkpoint |
| Branding/landing/dashboard settings | Minimal new preview shell | Existing feature/UI inventory, user accepted design direction not assumed |

No feature in the remaining column is silently discarded. No original RLS policy, DB function/trigger, key or stored file has been changed. New target policies in source are not proof that old permissions were mapped. Target baseline is for clean development DB only until exact live migration reviewed.
