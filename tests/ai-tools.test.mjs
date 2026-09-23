import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantTools } from "../ai/tools.mjs";

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUSTOMER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INV_1 = "11111111-1111-4111-8111-111111111111";
const INV_2 = "22222222-2222-4222-8222-222222222222";

const invoice = (id, overrides = {}) => ({
  id, workspace_id: WS_A, invoice_number: `INV-${id.slice(0, 4)}`, customer_id: CUSTOMER,
  issue_date: "2026-09-01", due_date: "2026-09-10", currency: "INR", total_amount: "1.00", amount_paid: "0.00",
  status: "sent", created_at: "2026-09-01T10:00:00.000Z", updated_at: "2026-09-01T10:00:00.000Z", metadata: {}, ...overrides,
});

function makeStore({ workspaceId = WS_A, invoices = [], customers = [], payments = [] } = {}) {
  const data = { invoices, customers, payments };
  const calls = [];
  return {
    calls,
    async query(table, options) {
      calls.push({ table, options: structuredClone(options) });
      assert.ok(["invoices", "customers", "payments"].includes(table), "table must come from the read-only whitelist");
      let rows = data[table].filter((row) => row.workspace_id === workspaceId);
      for (const [column, expression] of Object.entries(options.filters ?? {})) {
        const [operator, ...parts] = String(expression).split(".");
        const value = parts.join(".");
        rows = rows.filter((row) => {
          const actual = row[column];
          if (operator === "eq") return String(actual) === value;
          if (operator === "gte") return String(actual) >= value;
          if (operator === "lte") return String(actual) <= value;
          throw new Error(`Unsupported filter ${operator}`);
        });
      }
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (options.offset) rows = rows.slice(options.offset);
      if (options.limit !== undefined) rows = rows.slice(0, options.limit);
      const requested = options.select.split(",");
      return rows.map((row) => Object.fromEntries(requested.map((field) => [field, row[field]]).filter(([, value]) => value !== undefined)));
    },
  };
}

test("only reads the bound workspace and rejects scope or injection arguments", async () => {
  const store = makeStore({ invoices: [invoice(INV_1), invoice(INV_2, { workspace_id: WS_B, invoice_number: "SECRET" })] });
  const tools = createAssistantTools({ store });
  const rows = await tools.execute("getInvoices", {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoiceNumber, `INV-${INV_1.slice(0, 4)}`);
  assert.ok(store.calls.every(({ table }) => ["invoices", "customers", "payments"].includes(table)));
  await assert.rejects(tools.execute("getInvoices", { workspace_id: WS_B }), /Unexpected argument/);
  await assert.rejects(tools.execute("getInvoices", { status: "sent&select=*" }), /Invalid status/);
  await assert.rejects(tools.execute("getCustomer", { customerId: "not-a-uuid" }), /UUID/);
  await assert.rejects(tools.execute("rpc/drop_tables", {}), /Unknown assistant tool/);
  assert.equal(store.calls.length, 1, "invalid tool arguments must not reach storage");
});

test("tool definitions are OpenAI function tools with no workspace or owner inputs", () => {
  const { definitions } = createAssistantTools({ store: makeStore() });
  assert.deepEqual(definitions.map((item) => item.function.name), ["getInvoices", "getCustomer", "getPayments", "getOutstandingSummary", "getOverdueInvoices", "getActivity"]);
  for (const item of definitions) {
    assert.equal(item.type, "function");
    assert.equal(item.function.parameters.additionalProperties, false);
    assert.ok(!JSON.stringify(item.function.parameters).match(/workspace|owner/i));
  }
});

test("outstanding math is decimal-exact and grouped by currency without summing payments", async () => {
  const store = makeStore({ invoices: [
    invoice(INV_1, { total_amount: "0.30", amount_paid: "0.10", currency: "USD" }),
    invoice(INV_2, { total_amount: "0.20", amount_paid: "0.20", currency: "USD", status: "paid" }),
    invoice("33333333-3333-4333-8333-333333333333", { total_amount: "100.00", amount_paid: "20.00", currency: "EUR" }),
    invoice("44444444-4444-4444-8444-444444444444", { status: "draft", total_amount: "900.00" }),
  ], payments: [{ id: "p1", workspace_id: WS_A, invoice_id: INV_1, amount: "7.77", paid_at: "2026-09-10T00:00:00.000Z" }] });
  const tools = createAssistantTools({ store });
  const summary = await tools.execute("getOutstandingSummary", {});
  assert.equal(summary.basis, "invoices.amount_paid");
  assert.deepEqual(summary.currencies.USD, { invoiceCount: 2, totalAmount: "0.50", amountPaid: "0.30", outstandingAmount: "0.20" });
  assert.deepEqual(summary.currencies.EUR, { invoiceCount: 1, totalAmount: "100.00", amountPaid: "20.00", outstandingAmount: "80.00" });
  assert.equal(summary.currencies.INR, undefined, "drafts do not count toward outstanding summary");
  const collected = await tools.execute("getPayments", {});
  assert.deepEqual(collected.totalsByCurrency, {USD: '7.77'});
  assert.equal(collected.payments[0].currency, 'USD');
});

test("overdue uses UTC calendar date, excludes due-today, paid, draft and zero balances", async () => {
  const store = makeStore({ invoices: [
    invoice(INV_1, { due_date: "2026-09-21", status: "overdue", total_amount: "10.00", amount_paid: "2.00" }),
    invoice(INV_2, { due_date: "2026-09-22", status: "sent" }),
    invoice("33333333-3333-4333-8333-333333333333", { due_date: "2026-09-20", status: "paid" }),
    invoice("44444444-4444-4444-8444-444444444444", { due_date: "2026-09-20", status: "sent", total_amount: "1.00", amount_paid: "1.00" }),
    invoice("55555555-5555-4555-8555-555555555555", { due_date: "2026-09-20", status: "draft" }),
  ] });
  const tools = createAssistantTools({ store, clock: () => new Date("2026-09-21T23:59:59-07:00") });
  const overdue = await tools.execute("getOverdueInvoices", {});
  assert.equal(overdue.asOfUtcDate, "2026-09-22");
  assert.equal(overdue.count, 1);
  assert.equal(overdue.invoices[0].id, INV_1);
  assert.deepEqual(overdue.balancesByCurrency.INR, { invoiceCount: 1, totalAmount: "10.00", amountPaid: "2.00", outstandingAmount: "8.00" });
});

test("date filters are validated, inclusive on UTC dates, and bounded before pagination", async () => {
  const store = makeStore({ invoices: [
    invoice(INV_1, { issue_date: "2026-09-01" }),
    invoice(INV_2, { issue_date: "2026-09-02" }),
    invoice("33333333-3333-4333-8333-333333333333", { issue_date: "2026-09-03" }),
  ], payments: [
    { id: "p1", workspace_id: WS_A, invoice_id: INV_1, amount: "1.00", paid_at: "2026-09-02T23:00:00Z" },
    { id: "p2", workspace_id: WS_A, invoice_id: INV_1, amount: "2.00", paid_at: "2026-09-03T01:00:00Z" },
  ] });
  const tools = createAssistantTools({ store });
  const invoices = await tools.execute("getInvoices", { issueDateFrom: "2026-09-02", issueDateTo: "2026-09-03", limit: 1, offset: 1 });
  assert.deepEqual(invoices.map((row) => row.issueDate), ["2026-09-03"]);
  const payments = await tools.execute("getPayments", { paidAtFrom: "2026-09-03", paidAtTo: "2026-09-03" });
  assert.deepEqual(payments.payments.map((row) => row.id), ["p2"]);
  assert.deepEqual(payments.totalsByCurrency, {INR: '2.00'});
  await assert.rejects(tools.execute("getInvoices", { issueDateFrom: "2026-02-30" }), /valid calendar date/);
  await assert.rejects(tools.execute("getPayments", { paidAtFrom: "2026-09-04", paidAtTo: "2026-09-01" }), /must not be before/);
  await assert.rejects(tools.execute("getInvoices", { limit: 101 }), /limit must be/);
});

test("activity only exposes invoice/payment events and a safe current follow-up metadata snapshot", async () => {
  const store = makeStore({ invoices: [invoice(INV_1, {
    updated_at: "2026-09-03T10:00:00.000Z",
    metadata: { followup_state: "paused", last_follow_up_at: "2026-09-02T00:00:00Z", reminder_count: 2, secret: "must-not-leak" },
    notes: "private notes",
  })], payments: [{ id: "pay1", workspace_id: WS_A, invoice_id: INV_1, amount: "0.25", paid_at: "2026-09-04T10:00:00.000Z", reference: "secret-ref" }] });
  const activity = await createAssistantTools({ store }).execute("getActivity", {});
  assert.equal(activity.verifiedFollowUpLogAvailable, false);
  assert.deepEqual(activity.events.map((event) => event.type), ["payment_recorded", "invoice_updated", "invoice_created"]);
  assert.deepEqual(activity.events[1].followUpMetadataSnapshot, { followup_state: "paused", last_follow_up_at: "2026-09-02T00:00:00Z", reminder_count: 2 });
  assert.ok(!JSON.stringify(activity).includes("must-not-leak"));
  assert.ok(!JSON.stringify(activity).includes("secret-ref"));
  assert.ok(!JSON.stringify(activity).includes("private notes"));
});

test("aggregate tools fail closed rather than returning partial results over 5000 rows", async () => {
  const tooMany = Array.from({ length: 5001 }, (_, index) => invoice(`${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`));
  const store = makeStore({ invoices: tooMany });
  await assert.rejects(createAssistantTools({ store }).execute("getOutstandingSummary", {}), /5000-row safety limit/);
});
