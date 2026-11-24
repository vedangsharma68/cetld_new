import { planLegacyInvoiceCorrectionAudits } from "./plan-legacy-invoice-correction-audits";
import { planLegacyBusinessRecords } from "./plan-legacy-business-records";
import { planLegacyProfiles } from "./plan-legacy-profiles";
import { planLegacySettings } from "./plan-legacy-settings";
import { planLegacyImport } from "./plan-legacy-import";
import { planLegacyCustomers } from "./plan-legacy-customers";
import { planLegacyFinancial } from "./plan-legacy-financial";
import { planLegacyFiles } from "./plan-legacy-files";
// Composes the reviewed pure slices. This is not a complete product snapshot:
// settings, integrations, reminder state/effects and original file bytes remain
// mandatory external reconciliation gates before any real import operator.
export function planLegacyCoreSnapshot(snapshot: unknown) {
  const allowed = new Set([
    "invoice_correction_audits",
    "business_records",
    "users",
    "profiles",
    "workspace_settings",
    "workspace_ai_settings",
    "identities",
    "workspaces",
    "members",
    "customers",
    "invoices",
    "payments",
    "payment_reversals",
    "invoice_reopening_proposals",
    "invoice_number_sequences",
    "invoice_files",
  ]);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    throw Error("Snapshot object required");
  const extras = Object.keys(snapshot).filter((key) => !allowed.has(key));
  if (extras.length)
    throw Error(
      "Unmapped snapshot tables block planning: " + extras.sort().join(","),
    );
  const core = planLegacyImport(snapshot);
  const profiles = planLegacyProfiles(
    snapshot,
    new Set(core.users.map((u) => u.id)),
  );
  const settings = planLegacySettings(
    snapshot,
    new Set(core.workspaces.map((w) => w.id)),
    new Set(core.users.map((u) => u.id)),
  );
  const businesses = new Map(core.workspaces.map((w) => [w.id, w.ownerId]));
  const customers = planLegacyCustomers(snapshot, new Set(businesses.keys()));
  const financial = planLegacyFinancial(snapshot, {
    users: new Set(core.users.map((u) => u.id)),
    businesses,
    customers: new Map(customers.map((c) => [c.id, c.workspaceId])),
  });
  const files = planLegacyFiles(
    snapshot,
    new Map(
      financial.invoices.map((i) => [
        i.id,
        { workspaceId: i.workspaceId, ownerId: i.ownerId },
      ]),
    ),
  );
  const businessRecords = planLegacyBusinessRecords(
    snapshot,
    new Set(businesses.keys()),
    new Set(core.users.map((u) => u.id)),
  );
  const invoiceCorrectionAudits = planLegacyInvoiceCorrectionAudits(
    snapshot,
    businesses,
    new Map(financial.invoices.map((i) => [i.id, i.workspaceId])),
  );
  return {
    invoiceCorrectionAudits,
    businessRecords,
    ...core,
    customers,
    profiles,
    ...settings,
    ...financial,
    files,
    realImportAllowed: false as const,
    remainingGates: [
      "settings-and-integrations",
      "reminder-effects-and-queues",
      "original-file-bytes",
      "real-source-inventory",
      "cutover-review",
    ] as const,
  };
}
