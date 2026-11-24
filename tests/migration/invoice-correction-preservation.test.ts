import { it, expect } from "vitest";
import { planLegacyInvoiceCorrectionAudits as plan } from "../../scripts/migration/plan-legacy-invoice-correction-audits";
const user = "11111111-1111-4111-8111-111111111111",
  business = "22222222-2222-4222-8222-222222222222",
  invoice = "33333333-3333-4333-8333-333333333333",
  id = "44444444-4444-4444-8444-444444444444",
  at = "2026-11-20T00:00:00Z";
const source = () => ({
  invoice_correction_audits: [
    {
      id,
      workspace_id: business,
      owner_id: user,
      invoice_id: invoice,
      source_kind: "whatsapp",
      source_event_id: "original:event",
      values: { amount: "9007199254740993.01" },
      before_snapshot: { private: { nested: true } },
      after_snapshot: null,
      created_at: at,
    },
  ],
});
const run = (s: unknown) =>
  plan(s, new Map([[business, user]]), new Map([[invoice, business]]));
it("retains exact historical values/snapshots/source/time without action replay", () => {
  expect(run(source())[0]).toMatchObject({
    sourceEventId: "original:event",
    sourceKind: "whatsapp",
    values: { amount: "9007199254740993.01" },
    beforeSnapshot: { private: { nested: true } },
    afterSnapshot: null,
    createdAt: new Date(at),
  });
});
it.each([
  "missing-table",
  "missing-json",
  "duplicate-id",
  "duplicate-event",
  "wrong-owner",
  "wrong-business",
  "wrong-invoice",
  "unknown-column",
  "wrong-source",
])("rejects audit %s", (kind) => {
  const s: Record<string, unknown> = source(),
    r = (
      s.invoice_correction_audits as ReturnType<
        typeof source
      >["invoice_correction_audits"]
    )[0]!;
  if (kind === "missing-table") delete s.invoice_correction_audits;
  if (kind === "missing-json")
    delete (r as unknown as Record<string, unknown>).values;
  if (kind === "duplicate-id") s.invoice_correction_audits = [r, r];
  if (kind === "duplicate-event")
    s.invoice_correction_audits = [r, { ...r, id: user }];
  if (kind === "wrong-owner") r.owner_id = id;
  if (kind === "wrong-business") r.workspace_id = id;
  if (kind === "wrong-invoice") r.invoice_id = id;
  if (kind === "unknown-column") Object.assign(r, { ignored: "lost" });
  if (kind === "wrong-source") r.source_kind = "external";
  expect(() => run(s)).toThrow();
});
