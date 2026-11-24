import { z } from "zod";
const at = z.string().datetime({ offset: true });
// Validate without coercing or normalizing source values.
const row = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    record_type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    name: z
      .string()
      .refine(
        (v) =>
          Array.from(v.replace(/^ +| +$/g, "")).length >= 1 &&
          Array.from(v.replace(/^ +| +$/g, "")).length <= 200 &&
          !/[\x00-\x1f\x7f-\x9f]/.test(v),
      ),
    custom_fields: z.record(z.string(), z.unknown()),
    created_at: at,
    updated_at: at,
    deleted_at: at.nullable(),
    deleted_by: z.uuid().nullable(),
  })
  .strict();
export function planLegacyBusinessRecords(
  snapshot: unknown,
  businesses: Set<string>,
  users: Set<string>,
) {
  const source = z.object({ business_records: z.array(row) }).parse(snapshot),
    seen = new Set<string>();
  return source.business_records.map((r) => {
    if (seen.has(r.id) || !businesses.has(r.workspace_id))
      throw Error("Duplicate or orphan business record");
    if (
      (r.deleted_at === null) !== (r.deleted_by === null) ||
      (r.deleted_by !== null && !users.has(r.deleted_by))
    )
      throw Error("Invalid business record deletion identity");
    seen.add(r.id);
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      recordType: r.record_type,
      name: r.name,
      customFields: r.custom_fields,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      deletedAt: r.deleted_at === null ? null : new Date(r.deleted_at),
      deletedBy: r.deleted_by,
    };
  });
}
