import assert from "node:assert/strict";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { getEnv } from "../../src/env";
import {
  businessCustomFieldsSchema as schema,
  businessFieldsJsonbBytes,
} from "../../src/shared/schemas/business-custom-fields.schema";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const source = JSON.parse(
  readFileSync(
    "migration-evidence/live-business-fields-validator.json",
    "utf8",
  ),
)[0].definition as string;
const sentinel = new Error("Rollback customfields reference");
try {
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`create schema if not exists app`;
      await tx.unsafe(source);
      const cases: unknown[] = [
        ...Array.from({ length: 32 }, (_, i) => ({
          label: String.fromCodePoint(128 + i),
        })),
        {},
        null,
        [],
        { label: "0011", enabled: true },
        { a: "😀".repeat(1000) },
        { a: "😀".repeat(1001) },
        { a: "😀".repeat(1000), b: "😀".repeat(1000), c: "x".repeat(160) },
        { a: "😀".repeat(1000), b: "😀".repeat(1000), c: "x".repeat(170) },
        { name: "reserved" },
        { access_token: "x" },
        { good: { nested: true } },
        { good: [1] },
        { good: "a\nb" },
        { good: 1e21 },
        { good: 1e-7 },
        { good: 1e100 },
        { good: 1e-100 },
        Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => ["field_" + i, i]),
        ),
      ];
      const [locale] =
        await tx`select datctype locale from pg_database where datname=current_database()`;
      console.log("Synthetic customfields proof locale:" + locale!.locale);
      for (const [i, value] of cases.entries()) {
        const [result] =
          await tx`select app.business_custom_fields_valid(${tx.json(value as never)}::jsonb) allowed,octet_length((${tx.json(value as never)}::jsonb)::text) bytes`;
        assert.equal(
          schema.safeParse(value).success,
          result!.allowed,
          `validator differential case${i}`,
        );
        if (schema.safeParse(value).success)
          assert.equal(
            businessFieldsJsonbBytes(
              value as Record<string, string | number | boolean | null>,
            ),
            result!.bytes,
            `byte differential case${i}`,
          );
      }
      throw sentinel;
    }),
    (e) => e === sentinel,
  );
  console.log(
    "Native custom-field server/installed legacy differential50cases passed: Unicode/exactjsonbbytes/exponents/reserved/scalar limits",
  );
} finally {
  await sql.end();
}
