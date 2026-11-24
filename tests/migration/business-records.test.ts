import { it, expect, vi } from "vitest";
vi.mock(
  "@/server/modules/business-records/business-records.repository",
  () => ({ businessRecordsRepository: {} }),
);
import { createBusinessRecordsService } from "@/server/modules/business-records/business-records.service";
import { planLegacyBusinessRecords } from "../../scripts/migration/plan-legacy-business-records";
const user = "11111111-1111-4111-8111-111111111111",
  workspace = "22222222-2222-4222-8222-222222222222",
  id = "33333333-3333-4333-8333-333333333333",
  at = "2026-11-20T00:00:00Z";
const source = () => ({
  business_records: [
    {
      id,
      workspace_id: workspace,
      record_type: "supplier",
      name: " Exact source ",
      custom_fields: { tax_label: "0011", credit_limit: 123.45 },
      created_at: at,
      updated_at: at,
      deleted_at: at,
      deleted_by: user,
    },
  ],
});
it("preserves exact record/custom data/history including deleted rows", () => {
  const p = planLegacyBusinessRecords(
    source(),
    new Set([workspace]),
    new Set([user]),
  );
  expect(p[0]).toMatchObject({
    id,
    name: " Exact source ",
    customFields: { tax_label: "0011", credit_limit: 123.45 },
    deletedBy: user,
    deletedAt: new Date(at),
    createdAt: new Date(at),
  });
});
it.each([
  "missing",
  "orphan-business",
  "orphan-actor",
  "duplicate",
  "half-delete",
  "invalid-name",
  "invalid-type",
  "extra-field",
])("rejects %s rather than dropping state", (kind) => {
  const s: Record<string, unknown> = source(),
    r = (
      s.business_records as ReturnType<typeof source>["business_records"]
    )[0]!;
  if (kind === "missing") delete s.business_records;
  if (kind === "orphan-business") r.workspace_id = id;
  if (kind === "orphan-actor") r.deleted_by = id;
  if (kind === "duplicate") s.business_records = [r, r];
  if (kind === "half-delete")
    (r as unknown as Record<string, unknown>).deleted_at = null;
  if (kind === "invalid-name") r.name = "\n";
  if (kind === "invalid-type") r.record_type = "Invalid";
  if (kind === "extra-field") Object.assign(r, { unknown: "lost" });
  expect(() =>
    planLegacyBusinessRecords(s, new Set([workspace]), new Set([user])),
  ).toThrow();
});
it("owner result is returned without widening to membership", async () => {
  const repo = { listOwned: vi.fn().mockResolvedValue([{ id }]) };
  expect(
    await createBusinessRecordsService(repo).list(user, workspace),
  ).toEqual({ records: [{ id }], nextCursor: null });
  expect(repo.listOwned).toHaveBeenCalledWith(
    user,
    workspace,
    false,
    undefined,
    25,
  );
});
it("non-owner result is non-disclosing404", async () => {
  await expect(
    createBusinessRecordsService({
      listOwned: vi.fn().mockResolvedValue(null),
    }).list(user, workspace, true),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it("uses limit+1 result to expose continuation without returning extra row", async () => {
  const repo = {
    listOwned: vi
      .fn()
      .mockResolvedValue([{ id: "one" }, { id: "two" }, { id: "three" }]),
  };
  const result = await createBusinessRecordsService(repo).list(
    user,
    workspace,
    false,
    undefined,
    2,
  );
  expect(result).toEqual({
    records: [{ id: "one" }, { id: "two" }],
    nextCursor: "two",
  });
});

it.each(Array.from({ length: 32 }, (_, i) => 128 + i))(
  "record name rejects source-locale control U+%i",
  (code) => {
    const s = source();
    s.business_records[0]!.name = "Name" + String.fromCodePoint(code);
    expect(() =>
      planLegacyBusinessRecords(s, new Set([workspace]), new Set([user])),
    ).toThrow();
  },
);
