import { it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
it("runtime never hard deletes users/businesses or updates/deletes receipt/reversal audit", () => {
  for (const file of files("src").filter((f) => /\.tsx?$/.test(f))) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(
      /\.delete\(\s*(users|workspaces|payments|paymentReversals)\s*\)/,
    );
    expect(source, file).not.toMatch(
      /\.update\(\s*(payments|paymentReversals)\s*\)/,
    );
    expect(source, file).not.toMatch(
      /\bdelete\s+from\s+(users|workspaces|payments|payment_reversals)\b/i,
    );
    expect(source, file).not.toMatch(
      /\bupdate\s+(payments|payment_reversals)\s+set\b/i,
    );
  }
});
it("hosted cleanup remains explicit fixture only and is not an app route", () => {
  const source = readFileSync(
    "scripts/migration/cleanup-hosted-fixture.ts",
    "utf8",
  );
  expect(source).toContain("hosted-fixture@example.invalid");
  expect(source).toContain("tgkpysathmrsngoavsqh");
  expect(source).toContain("syntheticFixtureRemoved");
});
