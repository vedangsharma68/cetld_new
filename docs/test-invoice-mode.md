# Supported reminder test invoice

As the workspace owner, open **New invoice → Create test invoice**. Review the fixed recipient **Pappa (+919818685252)** and **INR 1**, then create it. Exactly one existing contact must match that name and phone. Creation does not create consent or change suppression, settings, templates, or delivery permissions.

The server creates a receivable with `metadata.test_invoice=true`, source and visible invoice number `CETLD-TEST-<request UUID>-NO-PAYMENT-REQUIRED`, status `sent`, unpaid amount INR 1, and follow-up state `draft`. The nominal balance exists to exercise the ordinary unpaid-invoice checks; no money is owed. It appears in the local ledger until cleaned up. Both supported approved template formats render the invoice number variable, so the recipient sees **TEST** and **NO-PAYMENT-REQUIRED**, not merely a hidden note.

Open the invoice's usual **Review draft**, inspect the actual template delivery, and explicitly approve it. Normal scheduling and dispatch apply. A test flag grants no delivery permission. Clean up through the normal owner **Delete invoice** flow; do not invent a payment to clear the test. Delete and undo keep the marker and export exclusion, and undo retains the normal paused reminder state.

The owner-authenticated route is `POST /api/invoice-lifecycle` with exactly `{action:"createTestInvoice", workspaceId, idempotencyKey:<new UUID>}`. It forwards the owner's JWT to `create_test_invoice(p_workspace_id,p_request_id)`. Repeating a UUID returns the same invoice, including after deletion; it never resets reminders or resurrects a row. The consumed scheduled-owner-test key is unrelated and is never reused. The migration must be installed before this entry can create invoices.

## Permanent boundaries

Only the creation RPC can enroll a new invoice in a private server registry. Ordinary insertion, assistant updates, dashboard writes, owner corrections/reopening, service-role writes, and metadata triggers cannot retrofit the marker onto a real invoice or remove it from a test. The test number, INR amount, currency, recipient binding, and visible test naming are protected. Pappa's matching contact name/phone remain pinned while the test invoice exists, including after soft deletion; consent and suppression remain editable through their normal mechanisms.

`syncEligibility` returns `excluded` before synced/retry states. The reconciler query independently excludes the marker and reserved source/visible numbers. An explicit export, retry, or provider-link attempt refuses with `INVOICE_NOT_EXPORTABLE`. Database validation also rejects provider columns and accounting metadata links, so a future linkage writer cannot bypass the boundary. Existing real obligations are never marked or reset.

Test numbers are excluded from the history used to infer the next real invoice number; creating tests does not change that numbering convention or consume a real number.

## Export and linkage audit

| Path | Protection |
| --- | --- |
| Assistant and media saves (`ai/invoice-ops.mjs` → `syncInvoiceRow`) | Ordinary input cannot claim the reserved test number; saved-row marker check precedes inline export and idempotent synced exits. |
| Manual retry (`retryAssistantInvoiceSync`) | Refuses test rows before customer lookup, retry-budget reset, lease write, or provider work. |
| Daily sweep (`invoice-sync-reconciler.mjs`) | Null-safe SQL candidate exclusions plus the same retry/runtime refusal for stale candidates. |
| Direct accounting preparation and dispatch | Checks the durable saved row before connection preparation and again before provider dispatch. |
| Zoho create/update adapter and shared sync claim/finish persistence | Refuses test payloads/rows; runtime completion inherits the same persistence guard. |
| Connection sync/import and same-number provider matching | Connection sync remains pull-only. Existing-row patching and same-number matching refuse test linkage. |
| Future provider linkage writes | Invoice database triggers reject external-provider columns, accounting provider metadata, record IDs, synced timestamps, and synced state. |

## Reminder gates deliberately preserved

The reminder implementation and reminder SQL migrations are unchanged. Tests exercise the ordinary owner HTTP preview, exact signed approval, protected SQL snapshot, scheduler, final atomic gate, and captured first-party template request.

- Workspace ownership, pending-action arbitration, explicit approval, and exact reviewed payload identity.
- Current consent, allowed consent source/category/customer binding, workspace suppression, and global suppression.
- Configured recipient allowlist and the existing recipient eligibility checks.
- Approved template identity, catalog approval, parameters, and service-window/fallback rules.
- Fresh invoice/preferences/customer facts, local payment verification, and the final atomic snapshot check.
- Existing status, receivable direction, due-date and unpaid-balance requirements; paid, paused, disputed, deleted, STOP and other existing holds.
- Owner contact hours, timezone, cadence, maximum reminders, lease, idempotency, and durable receipt rules.

`automation/scheduled-owner-test.mjs` keeps its existing semantics. This mode never consumes or resets `scheduled-owner-test:20261017:v1`.
