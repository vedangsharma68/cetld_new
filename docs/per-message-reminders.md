# Per-message reminder approval

This extends merged #173 and the already-applied `20261023061702_shared_owner_assistant.sql`. The original RPC signatures, proposal types, single approval slot, consent/STOP gates, payment checks, contact hours, snapshot checks, immutable template catalog and durable dispatch/receipt rules stay in place.

## Review and approval

`POST /api/ai?action=preview-reminder` accepts `{workspaceId, invoiceId, text, tone, sendNow, approveFallback}`. Only an authenticated business owner can use it. `sendNow: false` means scheduled follow-up; `true` means one immediate, queued attempt. It reads invoice, settings, customer and current inbound-window facts from the database, checks the extended `owner_assistant_preview_reminder` gate, and returns:

- `eligible`, `approvalToken`, `expiresAt`, `reviewPayload` (the signed artifact), `sendNow`, `deliveryReason`.
- `delivery`: the exact outgoing `text`, UI `form` (`service` or `template`), template name when applicable, window deadline and expiry policy. An explicitly selected fallback includes its own template name and exact rendered text.

The preview itself does not create, cancel or replace a pending approval. Existing owner proposals block the new approval flow. Changes to the editor invalidate its preview and acknowledgement.

`POST /api/ai?action=approve-reminder` accepts `{workspaceId, approvalToken, reviewPayload, confirmed: true}`. The HMAC binds the complete reviewed artifact to owner, business, proposal ID and expiry. The server rejects changed artifacts, then uses #173's `owner_assistant_propose` and `owner_assistant_decide` RPCs. All eligibility and snapshot gates run again. A failed confirmation retains its pending proposal for explicit review/cancellation in Assistant or WhatsApp. Retrying a successful confirmation replays its receipt without another approval.

Per-message tone selects the actual approved catalog template and supplies the editable starting words for a service message. The frozen approved artifact controls dispatch. Business/customer defaults are not changed by a per-message selection.

## Platform capability and product restriction

WhatsApp permits free-form service messages within 24 hours of the customer's last inbound message. The final dispatch gate derives that deadline from customer-audience inbound messages bound to the current customer/phone, using the provider timestamp when available. Owner messages, outbound messages and delayed worker processing cannot extend the window.

Cetld's stricter **product restriction** makes all scheduled reminders template-only, including inside that window. The UI states this restriction before approval. Moving an immediate service approval onto a different schedule holds it for review. Successful one-off sends do not create a recurring schedule.

If edited wording cannot send as-is, the owner sees the named approved template and its actual expanded words before choosing it. The custom wording remains in `metadata.reminder_draft_text`; its tone remains in `reminder_draft_tone`.

## Stored binding and dispatch

New version-2 receipts extend `metadata.approved_reminder_delivery`; existing version-1 template receipts retain their exact shape. New receipts point to a private `app.reminder_approvals` row containing `approved_form` (`template` or `freeform`), exact text, the template identity/parameters or optional fallback, approval time, window-deadline snapshot and the latest dispatch evaluation. Private evaluation rows retain each attempt and selected form. Browser roles cannot read or mutate these tables directly.

Template identity follows #173's actual schema: **name, language, revision and ordered parameters**. It does not invent a separate template UUID or named-parameter schema from the prose contract. `owner_assistant_preview_reminder` and `owner_assistant_decide` retain their existing signatures; the optional `reviewedDelivery` inside the existing template JSON activates the extension. Legacy calls follow the original template gate.

Preparation and every final SQL reservation evaluate the same immutable receipt:

| Approved artifact | Dispatch condition | Result |
| --- | --- | --- |
| Template | Fresh eligibility and facts match | Exact approved template/parameters |
| Free-form | Service window open; immediate queue unchanged | Exact approved text |
| Free-form, no fallback | Window closed/unknown | `undeliverable_window_expired`; visible paused re-review, no send |
| Free-form, explicit fallback | Window closed/unknown | Exact reviewed fallback; `deliveryForm: template_fallback` recorded |
| Words, form, parameters or immutable receipt differ | Any attempt | Fail closed and require re-review |

If the window closes between JS preparation and the final reservation, SQL selects only a previously approved fallback or holds the message. The provider verifies the returned final artifact and snapshot hash before building the Graph payload. A synchronous final deadline check prevents dispatching a service payload known to have expired after the reservation. Uncertain provider attempts retain the existing quarantine/no-automatic-retry behavior.

`GET /api/ai?action=reminder-approvals&workspaceId=...` reads owner-scoped evaluation status through `owner_assistant_reminder_status`. Conversations refresh these states with their history poll. Pending views show the approved body/form and optional fallback; expired approvals display the reason and retain the reviewed words.

## Existing approval mapping

The new additive migration does not delete proposals, approved text, delivery claims or receipt history.

| Existing data | Mapping |
| --- | --- |
| Valid #173 template receipt with current facts | Version-1 template approval; receipt, schedule, claim and automation version unchanged |
| Active legacy approval without a valid exact template receipt | Retained text/history; `paused`, no future schedule, `reminder_review_reason: delivery_form_review` visible to the owner |
| Pending web proposal | Same ID, action, expiry, state and shared approval slot; existing confirm/cancel semantics |
| Pending native WhatsApp proposal | Unchanged, including verified-channel confirmation requirements |
| Already dispatched/uncertain receipt | Existing immutable history and quarantine/reconciliation rules; never reissued by this migration |

## Rollout

1. Merge the reviewed branch and wait for Vercel's code deployment from `main`.
2. Apply the complete transaction in [the new additive migration](../supabase/migrations/20261023083356_per_message_reminder_review.sql) once through the Supabase SQL Editor. The #173 migration is already applied and remains untouched. Vercel does not apply SQL migrations.
3. During the code-before-migration interval, new custom review requests fail closed. Existing valid #173 template queues retain their sender path. The transaction aborts in full if an expected installed gate differs from its checked patch points.
4. Refresh tabs that predate the version checker once. Later deployments display the refresh prompt automatically.

The migration leaves all outbound flags, allowlists and consent unchanged. No production SQL, records or customer messages were modified during implementation.

## Verification

`tests/per-message-reminders.test.mjs` executes actual HTTP handlers, Supabase clients/stores and PostgreSQL functions. It covers template and exact-text delivery, expiry, explicit fallback, a window crossing at the final reservation, retry after expiry, unsigned/form/body/fallback tampering, replay, schedule repurposing, the full 4,000-character Unicode limit, consent loss, stale invoice facts, owner isolation, private-table/function privileges, and preservation of legacy queues/proposals.

`tests/browser/reminder-review.spec.mjs` exercises the real dashboard → HTTP API → Supabase SDK → isolated PostgreSQL → rendered receipt path at all seven viewport widths, then checks captured Graph payloads. Existing dashboard tests cover all pages, drawers, auth/forms, settings tokens, stale-tab refresh, keyboard and zoom. These are isolated integration tests, not live production authorization or Meta delivery certification.
