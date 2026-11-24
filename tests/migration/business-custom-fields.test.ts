import { it, expect } from "vitest";
import {
  businessCustomFieldsSchema as schema,
  businessFieldsJsonbBytes,
} from "@/shared/schemas/business-custom-fields.schema";
it("uses jsonb separator bytes rather than compact JSON size", () => {
  expect(businessFieldsJsonbBytes({ one: 1, two: null })).toBe(23);
});
it("counts Unicode scalar characters and UTF8 bytes independently", () => {
  expect(schema.safeParse({ label: "😀".repeat(1000) }).success).toBe(true);
  expect(schema.safeParse({ label: "😀".repeat(1001) }).success).toBe(false);
  expect(
    schema.safeParse({
      a: "😀".repeat(1000),
      b: "😀".repeat(1000),
      c: "x".repeat(160),
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      a: "😀".repeat(1000),
      b: "😀".repeat(1000),
      c: "x".repeat(170),
    }).success,
  ).toBe(false);
});
it.each([
  "id",
  "some_id",
  "token",
  "api_key",
  "private_key",
  "workspace",
  "owner",
  "name",
  "customer_id",
])("rejects reserved key %s", (key) => {
  expect(schema.safeParse({ [key]: "x" }).success).toBe(false);
});
it.each([
  { good: { nested: true } },
  { good: [1] },
  { good: "a\nb" },
  { good: Infinity },
  { Bad: "x" },
])("rejects unsafe custom values", (v) => {
  expect(schema.safeParse(v).success).toBe(false);
});
it("expands positive/negative exponents for jsonb numeric byte count", () => {
  expect(businessFieldsJsonbBytes({ a: 1e21 })).toBe(29);
  expect(businessFieldsJsonbBytes({ a: 1e-7 })).toBe(16);
});
it("rejects more than50keys", () => {
  expect(
    schema.safeParse(
      Object.fromEntries(
        Array.from({ length: 51 }, (_, i) => ["field_" + i, i]),
      ),
    ).success,
  ).toBe(false);
});
