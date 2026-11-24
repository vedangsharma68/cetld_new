import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("@/server/db/client", () => ({ db: {} }));
import { createLifecycleService } from "@/server/modules/invoices/lifecycle.service";
import { lifecycleRepository } from "@/server/modules/invoices/lifecycle.repository";
import type { invoices } from "@/server/db/schema";
type Context = Parameters<
  Parameters<typeof lifecycleRepository.withLockedInvoice>[2]
>[0];
function fixture() {
  const now = new Date("2026-11-24T10:00:00Z");
  const invoice = {
    id: "invoice",
    workspaceId: "business",
    invoiceNumber: "I-1",
    revision: 3,
    amount: "100.00",
    amountPaid: "1.00",
    financialStatus: "open",
    currency: "INR",
    lifecycleRiskVerified: true,
    deletedAt: null,
    metadata: {},
  } as typeof invoices.$inferSelect;
  const store = {
    payment: vi.fn().mockResolvedValue(null),
    byPrepareKey: vi.fn().mockResolvedValue(null),
    byRestoreKey: vi.fn().mockResolvedValue(null),
    expirePending: vi.fn(),
    pending: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async (v) => ({
      id: "proposal",
      state: "pending",
      ...v,
    })),
    deletedProposal: vi.fn(),
    proposal: vi.fn(),
    updateInvoice: vi.fn(),
    updateProposal: vi.fn(),
  } satisfies Context["store"];
  const repository = {
    ...lifecycleRepository,
    withLockedInvoice: vi.fn(
      async (_u: string, _i: string, run: (c: Context) => Promise<unknown>) =>
        run({ invoice, now, store }),
    ),
  } as typeof lifecycleRepository;
  return {
    invoice,
    store,
    now,
    repository,
    service: createLifecycleService(repository),
  };
}
it("service owns risk, snapshot, expiry and safe projection inside locked transaction", async () => {
  const f = fixture();
  const result = await f.service.act("owner", "invoice", {
    action: "prepare",
    key: "prepare-123",
  });
  expect(f.repository.withLockedInvoice).toHaveBeenCalledOnce();
  expect(f.store.create).toHaveBeenCalledWith(
    expect.objectContaining({
      hadPayment: true,
      revision: "3",
      expiresAt: new Date(f.now.getTime() + 600000),
      snapshot: {
        invoiceNumber: "I-1",
        amount: "100.00",
        currency: "INR",
        status: "open",
      },
    }),
  );
  expect(result).not.toHaveProperty("snapshot");
  expect(result).not.toHaveProperty("ownerId");
});
it("service refuses unknown delivery risk before mutation", async () => {
  const f = fixture();
  f.invoice.lifecycleRiskVerified = false;
  await expect(
    f.service.act("owner", "invoice", {
      action: "prepare",
      key: "prepare-123",
    }),
  ).rejects.toMatchObject({ code: "LIFECYCLE_RISK_UNKNOWN" });
  expect(f.store.payment).not.toHaveBeenCalled();
  expect(f.store.create).not.toHaveBeenCalled();
});
it("service blocks a pending action without replacing it", async () => {
  const f = fixture();
  f.store.pending.mockResolvedValue({ id: "existing" });
  await expect(
    f.service.act("owner", "invoice", {
      action: "prepare",
      key: "prepare-123",
    }),
  ).rejects.toMatchObject({ code: "ACTION_PENDING" });
  expect(f.store.create).not.toHaveBeenCalled();
});
it("service detects cross-invoice replay", async () => {
  const f = fixture();
  f.store.byPrepareKey.mockResolvedValue({ invoiceId: "other" });
  await expect(
    f.service.act("owner", "invoice", {
      action: "prepare",
      key: "prepare-123",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  expect(f.store.create).not.toHaveBeenCalled();
});
it("repositories expose no invoice hard delete, lifecycle rules or HTTP errors", () => {
  for (const name of ["invoices.repository.ts", "lifecycle.repository.ts"]) {
    const source = readFileSync(
      new URL("../../src/server/modules/invoices/" + name, import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\.delete\s*\(\s*invoices\s*\)/);
    expect(source).not.toMatch(/delete\s+from\s+["']?invoices/i);
  }
  const source = readFileSync(
    new URL(
      "../../src/server/modules/invoices/lifecycle.repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source).not.toMatch(
    /ConflictError|confirmLifecyclePlan|moneyUnits|async act\(/,
  );
  expect(source).toContain('for("update")');
});
