import { z } from "zod";
import { expectedLegacyTables } from "./expected-legacy-tables";
export function inspectLegacyTableCoverage(inventory: unknown) {
  const rows = z
    .array(
      z
        .object({
          schema: z.enum(["public", "app", "auth"]),
          table: z.string().min(1),
          count: z.string().regex(/^(0|[1-9][0-9]*)$/),
        })
        .strict(),
    )
    .parse(inventory);
  const seen = new Set<string>();
  const actual = new Set(rows.map((r) => r.schema + "." + r.table));
  if (actual.size !== rows.length) throw Error("Duplicate inventory table");
  if (
    expectedLegacyTables.some((key) => !actual.has(key)) ||
    actual.size !== expectedLegacyTables.length
  )
    throw Error(
      "Inventory differs from expected baseline: missing or unexpected table",
    );
  const core = new Set([
    "auth.users",
    "auth.identities",
    "public.workspaces",
    "public.workspace_members",
    "public.customers",
    "public.invoices",
    "public.payments",
    "public.invoice_files",
    "public.business_records",
    "public.invoice_correction_audits",
    "public.profiles",
    "public.payment_reversals",
    "public.invoice_reopening_proposals",
    "public.invoice_number_sequences",
  ]);
  const preservedSettings = new Set([
    "public.workspace_settings",
    "public.workspace_ai_settings",
  ]);
  return rows.map((r) => {
    const key = r.schema + "." + r.table;
    if (seen.has(key)) throw Error("Duplicate inventory table");
    seen.add(key);
    return {
      table: key,
      rowCount: BigInt(r.count),
      blocking: true as const,
      disposition: core.has(key)
        ? "core-planner-only"
        : preservedSettings.has(key)
          ? "settings-planner-only"
          : "unmapped-preservation-required",
      reason:
        BigInt(r.count) > 0n
          ? "Existing state needs a reviewed lossless operator and behavior mapping"
          : "Empty now is not permission to omit schema or future state",
    };
  });
}
