import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { invoiceRepository } from "../../src/server/modules/invoices/invoices.repository";
import { getEnv } from "../../src/env";
import { planInvoiceNumber } from "../../src/server/modules/invoices/invoice-number-plan";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const source = JSON.parse(
  await readFile(
    new URL(
      "../../migration-evidence/live-financial-numbering.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { proname: string; definition: string }[];
const sentinel = new Error("Rollback reference functions and every fixture");
try {
  await assert.rejects(
    sql.begin(async (tx) => {
      // Differential reference only: never installed by a candidate migration.
      await tx.unsafe(
        "create schema if not exists auth; create function auth.role() returns text language sql as $$ select 'authenticated'::text $$",
      );
      for (const name of [
        "invoice_number_pattern",
        "assign_consistent_invoice_number",
      ]) {
        const fn = source.find((f) => f.proname === name);
        assert.ok(fn);
        await tx.unsafe(fn.definition);
      }
      const [clock] = await tx`select current_date::text today`;
      const cases = [
        [],
        ["0040", "0041"],
        ["99", "100"],
        ["BILL/0041", "BILL/0042"],
        ["AC-2025-0041", "AC-2025-0042"],
        ["AC-2025/04/01-0041", "AC-2025/04/02-0042"],
        ["AC-20250401-0041", "AC-20250402-0042"],
        ["unknown", "opaque"],
        ["A-001", "B-001"],
        ["9007199254740993"],
        [
          "A-001",
          "opaque",
          "unknown",
          "INV-" + clock!.today.slice(0, 4) + "-9000",
        ],
      ];
      for (const numbers of cases) {
        const wid = randomUUID();
        await tx`insert into workspaces(id,name,owner_id) values(${wid},'Number parity','11111111-1111-4111-8111-111111111111')`;
        for (const [i, n] of numbers.entries())
          await tx`insert into invoices(id,workspace_id,owner_id,invoice_number,amount,currency,created_at) values(${randomUUID()},${wid},'11111111-1111-4111-8111-111111111111',${n},'1.00','INR',${new Date(Date.UTC(2026, 0, i + 1))})`;
        const history =
          await tx`select id,invoice_number,created_at,metadata from invoices where workspace_id=${wid}`;
        const prediction = planInvoiceNumber(
          history.map((h) => ({
            id: h.id,
            invoiceNumber: h.invoice_number,
            createdAt: h.created_at,
            metadata: h.metadata,
          })),
          {
            sourceNumber: "AUTO",
            idempotencyKey: null,
            preserveOwnerNumber: false,
            today: clock!.today,
          },
        );
        await tx.unsafe(
          "create trigger differential_number_reference before insert on public.invoices for each row execute function public.assign_consistent_invoice_number()",
        );
        const [actual] =
          await tx`insert into invoices(workspace_id,owner_id,invoice_number,amount,currency) values(${wid},'11111111-1111-4111-8111-111111111111','AUTO','1.00','INR') returning invoice_number`;
        assert.equal(
          actual!.invoice_number,
          prediction.invoiceNumber,
          JSON.stringify(numbers),
        );
        await tx.unsafe(
          "drop trigger differential_number_reference on public.invoices",
        );
      }
      console.log(
        "Native differential numbering parity: 11 history families/tie/fallback/exact-bigint fixtures match actual installed legacy functions; reference changes rolled back",
      );
      throw sentinel;
    }),
    (e) => e === sentinel,
  );
  const wid = randomUUID(),
    owner = "11111111-1111-4111-8111-111111111111";
  await sql`insert into workspaces(id,name,owner_id) values(${wid},'Number allocation concurrency',${owner})`;
  await sql`insert into workspace_members(workspace_id,user_id,role) values(${wid},${owner},'owner')`;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      invoiceRepository.create(owner, {
        workspaceId: wid,
        invoiceNumber: "AUTO",
        amount: "1.00",
        currency: "INR",
      }),
    ),
  );
  assert.equal(new Set(results.map((r) => r?.invoiceNumber)).size, 8);
  const [clock] = await sql`select current_date::text today`;
  assert.deepEqual(
    results.map((r) => r!.invoiceNumber).sort(),
    Array.from(
      { length: 8 },
      (_, i) =>
        `INV-${clock!.today.slice(0, 4)}-${String(i + 1).padStart(4, "0")}`,
    ),
  );
  const explicit = await invoiceRepository.create(owner, {
    workspaceId: wid,
    invoiceNumber: "Owner original 42",
    amount: "1.00",
    currency: "INR",
  });
  assert.equal(explicit!.invoiceNumber, "Owner original 42");
  const [preserved] =
    await sql`select metadata from invoices where id=${explicit!.id}`;
  assert.equal(preserved!.metadata.source_invoice_number, "Owner original 42");
  console.log(
    "Native actual repository numbering: eight concurrent AUTO creates unique and sequential; explicit owner number retained",
  );
} finally {
  await sql.end();
}
