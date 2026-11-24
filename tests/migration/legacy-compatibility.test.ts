import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
it("retains original legacy gates separately from Next deployment config", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const original = JSON.parse(readFileSync("legacy/package.json", "utf8"));
  for (const script of [
    "test:owner-chat",
    "test:offline-route",
    "build:frontend",
    "test:ui",
  ]) {
    expect(root.scripts[script]).toBe(
      "node scripts/migration/run-legacy-gate.mjs " + script,
    );
    expect(original.scripts[script]).toBeTruthy();
  }
  expect(root.scripts.typecheck).toContain("typecheck:legacy");
  expect(root.devDependencies["embedded-postgres"]).toBe(
    original.devDependencies["embedded-postgres"],
  );
  const deployment = JSON.parse(readFileSync("vercel.json", "utf8"));
  expect(deployment.crons).toEqual([]);
  expect(deployment.git.deploymentEnabled).toBe(false);
  expect(
    JSON.parse(readFileSync("legacy/vercel.json", "utf8")).crons.length,
  ).toBeGreaterThan(0);
  const harness = readFileSync("scripts/migration/run-legacy-gate.mjs", "utf8");
  expect(harness).toContain("releaseTestEnvironment");
  expect(harness).toContain(".startsWith('.env')");
  expect(harness).not.toMatch(/\.skip\(|test\.only\(/);
});
