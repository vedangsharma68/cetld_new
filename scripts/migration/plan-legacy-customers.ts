import { z } from "zod";
const instant = z.string().datetime({ offset: true });
const fields = z.record(z.string(), z.unknown());
const customer = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    name: z.string().min(1),
    company_name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    metadata: fields,
    created_at: instant,
    updated_at: instant,
    external_provider: z.string().nullable(),
    external_customer_id: z.string().nullable(),
    last_synced_at: instant.nullable(),
    sync_status: z.string(),
    last_sync_error: z.string().nullable(),
    custom_fields: fields,
    reminder_tone: z.string().nullable(),
  })
  .strict();
// Pure, lossless planning only. No database or external service is contacted.
export function planLegacyCustomers(
  snapshot: unknown,
  businesses: Set<string>,
) {
  const source = z.object({ customers: z.array(customer) }).parse(snapshot);
  const ids = new Set<string>();
  return source.customers.map((c) => {
    if (ids.has(c.id) || !businesses.has(c.workspace_id))
      throw Error("Duplicate or orphan customer");
    ids.add(c.id);
    return {
      id: c.id,
      workspaceId: c.workspace_id,
      name: c.name,
      companyName: c.company_name,
      email: c.email,
      phone: c.phone,
      metadata: c.metadata,
      customFields: c.custom_fields,
      createdAt: new Date(c.created_at),
      updatedAt: new Date(c.updated_at),
      externalProvider: c.external_provider,
      externalCustomerId: c.external_customer_id,
      lastSyncedAt:
        c.last_synced_at === null ? null : new Date(c.last_synced_at),
      syncStatus: c.sync_status,
      lastSyncError: c.last_sync_error,
      reminderTone: c.reminder_tone,
    };
  });
}
