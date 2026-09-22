# WhatsApp provider contract

Reminder automation depends on `sendReminder(input)`, where the input includes `workspaceId`, `invoiceId`, `customerId`, `to`, `body`, and `idempotencyKey`. A provider returns the IDs and status (`accepted`, `failed`, or `unknown`). Idempotency is scoped to the workspace.

Inbound normalization accepts only the provider neutral `{ events: [{ id, from, to, type, body, timestamp, context }] }` shape. The webhook verifier must resolve and pass `verifiedWorkspaceId`; values in a provider payload cannot choose a tenant. Sender and recipient must be E.164 numbers, and event counts and fields are bounded. Malformed events are rejected.

`createWhatsAppProvider({ mode })` requires an explicit mode. `mock` is deterministic and in-memory for tests. `wapi`/`meta` currently fail closed until a credentialed adapter is added, so production cannot silently send through a mock.
