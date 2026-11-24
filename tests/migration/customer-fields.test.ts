import { describe, it, expect } from "vitest";
import { customerCustomFieldsSchema as fields } from "@/shared/schemas/customer-custom-fields.schema";
import { updateCustomerSchema } from "@/shared/schemas/customers.schema";
describe("legacy custom field boundary", () => {
  it("accepts flat business values", () =>
    expect(
      fields.parse({
        school: "Example",
        year: 2026,
        active: true,
        other: null,
      }),
    ).toEqual({ school: "Example", year: 2026, active: true, other: null }));
  it.each([
    "user_id",
    "password",
    "api_key",
    "storage_path",
    "role",
    "custom_fields",
    "owner",
  ])("rejects reserved or sensitive field %s", (key) =>
    expect(fields.safeParse({ [key]: "value" }).success).toBe(false),
  );
  it("rejects nesting, excessive counts, Unicode byte overflow and controls", () => {
    for (const x of [
      { nested: { x: 1 } },
      Object.fromEntries(
        Array.from({ length: 51 }, (_, n) => ["field" + n, n]),
      ),
      Object.fromEntries(
        Array.from({ length: 5 }, (_, n) => ["field" + n, "ह".repeat(900)]),
      ),
      { field: "bad\nvalue" },
    ])
      expect(fields.safeParse(x).success).toBe(false);
  });
  it("does not permit integration or reminder mutations via ordinary update", () => {
    for (const x of [
      { metadata: {} },
      { externalProvider: "zoho" },
      { reminderTone: "firm" },
      { syncStatus: "done" },
    ])
      expect(updateCustomerSchema.safeParse(x).success).toBe(false);
  });
});
