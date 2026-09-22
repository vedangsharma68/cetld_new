/**
 * Provider contract used by reminder automation.
 *
 * sendReminder({ workspaceId, invoiceId, customerId, to, body, idempotencyKey })
 * returns { workspaceId, invoiceId, customerId, to, providerMessageId,
 *           status: 'accepted'|'failed'|'unknown', idempotencyKey }.
 * Implementations must scope idempotency by workspace and must never send a
 * second provider message for the same (workspaceId, idempotencyKey).
 *
 * normalizeInboundEvents(payload, { verifiedWorkspaceId }) is deliberately
 * separate from the provider. The webhook verifier supplies the workspace;
 * provider supplied fields are data only and cannot select a tenant.
 */
export const REMINDER_STATUSES = Object.freeze(['accepted', 'failed', 'unknown']);
