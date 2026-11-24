import { z } from "zod";
// Arbitrary historical JSON is retained, including scalar/null values. No replay.
const row = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    owner_id: z.uuid(),
    invoice_id: z.uuid(),
    source_kind: z.enum(["whatsapp", "dashboard"]),
    source_event_id: z.string(),
    values: z.unknown(),
    before_snapshot: z.unknown(),
    after_snapshot: z.unknown(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export function planLegacyInvoiceCorrectionAudits(
  snapshot: unknown,
  businesses: Map<string, string>,
  invoices: Map<string, string>,
) {
  const rows = z
      .object({ invoice_correction_audits: z.array(row) })
      .parse(snapshot).invoice_correction_audits,
    ids = new Set<string>(),
    events = new Set<string>();
  return rows.map((r) => {
    for (const key of ["values", "before_snapshot", "after_snapshot"] as const)
      if (!Object.hasOwn(r, key)) throw Error("Missing audit snapshot column");
    const event = JSON.stringify([
      r.workspace_id,
      r.owner_id,
      r.source_kind,
      r.source_event_id,
    ]);
    if (ids.has(r.id) || events.has(event))
      throw Error("Duplicate invoice correction audit");
    if (
      businesses.get(r.workspace_id) !== r.owner_id ||
      invoices.get(r.invoice_id) !== r.workspace_id
    )
      throw Error("Orphan or mismatched invoice correction audit");
    ids.add(r.id);
    events.add(event);
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      invoiceId: r.invoice_id,
      sourceKind: r.source_kind,
      sourceEventId: r.source_event_id,
      values: r.values,
      beforeSnapshot: r.before_snapshot,
      afterSnapshot: r.after_snapshot,
      createdAt: new Date(r.created_at),
    };
  });
}
