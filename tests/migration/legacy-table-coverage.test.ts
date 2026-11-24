import { it, expect } from "vitest";
import { inspectLegacyTableCoverage } from "../../scripts/migration/inspect-legacy-table-coverage";
import { expectedLegacyTables } from "../../scripts/migration/expected-legacy-tables";
const fixture = () =>
  expectedLegacyTables.map((key) => {
    const [schema, table] = key.split(".");
    return { schema, table, count: "0" };
  });
it("every expected table remains blocked even if empty or planned", () => {
  const rows = inspectLegacyTableCoverage(fixture());
  expect(rows.length).toBe(expectedLegacyTables.length);
  expect(rows.every((r) => r.blocking)).toBe(true);
  expect(rows.find((r) => r.table === "public.invoices")?.disposition).toBe(
    "core-planner-only",
  );
  expect(
    rows.find((r) => r.table === "public.workspace_settings")?.disposition,
  ).toBe("settings-planner-only");
  expect(
    rows.some((r) => r.disposition === "unmapped-preservation-required"),
  ).toBe(true);
  expect(rows.every((r) => r.reason.includes("not permission"))).toBe(true);
});
it("detects missing, added, renamed, duplicate and malformed inventory", () => {
  const f = fixture();
  expect(() => inspectLegacyTableCoverage(f.slice(1))).toThrow(/missing/);
  expect(() =>
    inspectLegacyTableCoverage([
      ...f,
      { schema: "app", table: "new_table", count: "0" },
    ]),
  ).toThrow(/unexpected/);
  expect(() =>
    inspectLegacyTableCoverage(
      f.map((r, i) => (i ? r : { ...r, table: "renamed" })),
    ),
  ).toThrow(/missing/);
  expect(() => inspectLegacyTableCoverage([...f, f[0]])).toThrow(/Duplicate/);
  expect(() =>
    inspectLegacyTableCoverage(f.map((r, i) => (i ? r : { ...r, count: 1 }))),
  ).toThrow();
});
it("preserves bigint counts without numeric coercion", () => {
  const f = fixture();
  f[0]!.count = "9007199254740993";
  expect(inspectLegacyTableCoverage(f)[0]!.rowCount).toBe(9007199254740993n);
});
