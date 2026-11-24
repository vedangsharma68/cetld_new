import { it, expect } from "vitest";
import { planBusinessCreation } from "../../src/server/modules/workspaces/business-create-plan";
const entropy = "12345678-1234-4234-8234-123456789012";
it.each([
  [" My business ", "my-business-12345678"],
  ["A & B Ltd.", "a-b-ltd-12345678"],
  ["x".repeat(100), "x".repeat(55) + "-12345678"],
])("matches installed slug normalization %s", (name, slug) =>
  expect(planBusinessCreation(name, entropy)).toEqual({
    name: name.trim(),
    slug,
  }),
);
it.each(["", "   ", "x".repeat(161)])(
  "rejects names that violate installed shape or source length %s",
  (name) => expect(() => planBusinessCreation(name, entropy)).toThrow(),
);
it("keeps separate same-name businesses distinct using independent entropy", () =>
  expect(planBusinessCreation("Business", entropy).slug).not.toBe(
    planBusinessCreation("Business", "87654321-1234-4234-8234-123456789012")
      .slug,
  ));

it("keeps international names intact with an ASCII fallback slug prefix", () =>
  expect(planBusinessCreation("世界", entropy)).toEqual({
    name: "世界",
    slug: "business-12345678",
  }));
