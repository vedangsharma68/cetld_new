# WhatsApp provider contract

Reminder automation depends on `sendReminder(input)`, where the input includes `workspaceId`, `invoiceId`, `customerId`, `to`, `body`, and `idempotencyKey`. A provider returns the IDs and status (`accepted`, `failed`, or `unknown`). Idempotency is scoped to the workspace.

Inbound normalization accepts only the provider neutral `{ events: [{ id, from, to, type, body, timestamp, context }] }` shape. The webhook verifier must resolve and pass `verifiedWorkspaceId`; values in a provider payload cannot choose a tenant. Sender and recipient must be E.164 numbers, and event counts and fields are bounded. Malformed events are rejected.

`createWhatsAppProvider({ mode })` requires an explicit mode. `mock` is deterministic and in-memory for tests. `wapi`/`meta` currently fail closed until a credentialed adapter is added, so production cannot silently send through a mock.

The Meta Cloud API integration in `cloud-outbound.mjs` is separate from the
reminder automation provider. It permits only allowlisted neutral invoice
update tests after all consent, invoice-state, business-name, and durable claim
checks. The approved reminder adapter uses the four registered utility
templates and remains limited to QA recipients behind consent, pause,
suppression, and durable dispatch checks. See
[approved reminders](../../docs/approved-whatsapp-reminders.md) for the live
proof and delivery requirements. The signed webhook in `api/whatsapp.js` records
events before acknowledgment and routes all responses through the same
allowlist and feature-flag checks.
