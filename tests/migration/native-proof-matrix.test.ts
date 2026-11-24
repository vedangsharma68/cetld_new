import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import matrix from "../../scripts/migration/native-proof-matrix.json";
it("local and CI runners use one complete native proof inventory", () => {
  for (const file of [
    "local-native-e2e.py",
    "ci-native-e2e.py",
    "run-native-proof.ts",
  ]) {
    expect(readFileSync(`scripts/migration/${file}`, "utf8")).toContain(
      "native-proof-matrix.json",
    );
  }
  expect(new Set(matrix).size).toBe(matrix.length);
  for (const proof of matrix)
    expect(
      readFileSync(`scripts/migration/verify-native-${proof}.ts`, "utf8"),
    ).toContain("127.0.0.1");
});
