import { z } from "zod";
import {
  moneyUnits,
  exactMoneySchema,
} from "../../src/shared/schemas/exact-money";
const instant = z.string().datetime({ offset: true });
const fields = z.record(z.string(), z.unknown());
const invoice = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    customer_id: z.uuid(),
    invoice_number: z.string().min(1),
    issue_date: z.iso.date(),
    due_date: z.iso.date().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    total_amount: exactMoneySchema,
    amount_paid: exactMoneySchema,
    status: z.enum(["draft", "sent", "overdue", "paid", "void", "cancelled"]),
    notes: z.string().nullable(),
    metadata: fields,
    created_at: instant,
    updated_at: instant,
    external_provider: z.string().nullable(),
    external_invoice_id: z.string().nullable(),
    last_synced_at: instant.nullable(),
    sync_status: z.string(),
    last_sync_error: z.string().nullable(),
    followup_state: z.string(),
    next_follow_up_at: instant.nullable(),
    last_follow_up_at: instant.nullable(),
    reminder_count: z.number().int().nonnegative(),
    customer_phone: z.string().nullable(),
    follow_up_settings: fields,
    automation_version: z.string().regex(/^[0-9]+$/),
    deleted_at: instant.nullable(),
    deleted_by: z.uuid().nullable(),
    custom_fields: fields,
  })
  .strict();
const payment = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    invoice_id: z.uuid(),
    amount: exactMoneySchema,
    paid_at: instant,
    method: z.string().nullable(),
    reference: z.string().nullable(),
    metadata: fields,
    created_at: instant,
    updated_at: instant,
    external_provider: z.string().nullable(),
    external_payment_id: z.string().nullable(),
    last_synced_at: instant.nullable(),
    sync_status: z.string(),
    last_sync_error: z.string().nullable(),
    idempotency_key: z.string().nullable(),
    settle_remaining: z.boolean(),
  })
  .strict();
export function planLegacyFinancial(
  snapshot: unknown,
  scope: {
    users: Set<string>;
    businesses: Map<string, string>;
    customers: Map<string, string>;
  },
) {
  const source = z
    .object({ invoices: z.array(invoice), payments: z.array(payment) })
    .parse(snapshot);
  const ids = new Set<string>();
  const numbers = new Set<string>();
  const rows = source.invoices.map((i) => {
    if (
      ids.has(i.id) ||
      numbers.has(i.workspace_id + ":" + i.invoice_number) ||
      !scope.businesses.has(i.workspace_id) ||
      scope.customers.get(i.customer_id) !== i.workspace_id
    )
      throw Error("Duplicate or orphan invoice");
    ids.add(i.id);
    numbers.add(i.workspace_id + ":" + i.invoice_number);
    if (moneyUnits(i.amount_paid) > moneyUnits(i.total_amount))
      throw Error("Invoice balance exceeds total");
    if (i.deleted_by && !scope.users.has(i.deleted_by))
      throw Error("Orphan invoice deleting user");
    if (!["paused", "cancelled", "scheduled"].includes(i.followup_state))
      throw Error("Unmapped invoice followup state, preserve before import");
    return {
      id: i.id,
      workspaceId: i.workspace_id,
      ownerId: scope.businesses.get(i.workspace_id)!,
      customerId: i.customer_id,
      invoiceNumber: i.invoice_number,
      issueDate: i.issue_date,
      dueDate: i.due_date,
      currency: i.currency,
      amount: i.total_amount,
      amountPaid: i.amount_paid,
      financialStatus: i.status,
      notes: i.notes,
      metadata: i.metadata,
      createdAt: new Date(i.created_at),
      updatedAt: new Date(i.updated_at),
      externalProvider: i.external_provider,
      externalInvoiceId: i.external_invoice_id,
      lastSyncedAt: i.last_synced_at ? new Date(i.last_synced_at) : null,
      syncStatus: i.sync_status,
      lastSyncError: i.last_sync_error,
      followupState: i.followup_state,
      nextFollowUpAt: i.next_follow_up_at
        ? new Date(i.next_follow_up_at)
        : null,
      lastFollowUpAt: i.last_follow_up_at
        ? new Date(i.last_follow_up_at)
        : null,
      reminderCount: i.reminder_count,
      customerPhone: i.customer_phone,
      followUpSettings: i.follow_up_settings,
      automationVersion: BigInt(i.automation_version),
      deletedAt: i.deleted_at ? new Date(i.deleted_at) : null,
      deletedBy: i.deleted_by,
      customFields: i.custom_fields,
      lifecycleRiskVerified: false,
    };
  });
  const byId = new Map(rows.map((i) => [i.id, i]));
  const paymentIds = new Set<string>();
  const keys = new Set<string>();
  const payments = source.payments.map((p) => {
    const i = byId.get(p.invoice_id);
    const key = p.workspace_id + ":" + p.idempotency_key;
    if (
      !i ||
      i.workspaceId !== p.workspace_id ||
      paymentIds.has(p.id) ||
      (p.idempotency_key !== null && keys.has(key)) ||
      moneyUnits(p.amount) <= 0n
    )
      throw Error("Duplicate, nonpositive or orphan payment");
    paymentIds.add(p.id);
    if (p.idempotency_key !== null) keys.add(key);
    return {
      id: p.id,
      workspaceId: p.workspace_id,
      invoiceId: p.invoice_id,
      amount: p.amount,
      paidAt: new Date(p.paid_at),
      method: p.method,
      reference: p.reference,
      metadata: p.metadata,
      createdAt: new Date(p.created_at),
      updatedAt: new Date(p.updated_at),
      externalProvider: p.external_provider,
      externalPaymentId: p.external_payment_id,
      lastSyncedAt: p.last_synced_at ? new Date(p.last_synced_at) : null,
      syncStatus: p.sync_status,
      lastSyncError: p.last_sync_error,
      idempotencyKey: p.idempotency_key,
      settleRemaining: p.settle_remaining,
      recordedBy: null,
    };
  });
  return { invoices: rows, payments };
}
