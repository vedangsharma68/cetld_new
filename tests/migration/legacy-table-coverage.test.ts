import { it, expect } from "vitest";
import { inspectLegacyTableCoverage } from "../../scripts/migration/inspect-legacy-table-coverage";
it("no table becomes import-ready from a partial planner or empty record count", () => {
  const rows = inspectLegacyTableCoverage([
    { schema: "public", table: "invoices", count: "65" },
    { schema: "public", table: "workspace_settings", count: "16" },
    { schema: "app", table: "unknown_future_table", count: "0" },
  ]);
  expect(rows.map((r) => r.blocking)).toEqual([true, true, true]);
  expect(rows.map((r) => r.disposition)).toEqual([
    "core-planner-only",
    "settings-planner-only",
    "unmapped-preservation-required",
  ]);
  expect(rows[2]!.reason).toContain("not permission");
});
it("handles exact counts and rejects malformed/duplicate inventory", () => {
  expect(
    inspectLegacyTableCoverage([
      { schema: "app", table: "journal", count: "9007199254740993" },
    ])[0]!.rowCount,
  ).toBe(9007199254740993n);
  expect(() =>
    inspectLegacyTableCoverage([
      { schema: "app", table: "journal", count: 9007199254740993 },
    ]),
  ).toThrow();
  expect(() =>
    inspectLegacyTableCoverage([
      { schema: "app", table: "journal", count: "1" },
      { schema: "app", table: "journal", count: "1" },
    ]),
  ).toThrow(/Duplicate/);
});
