import { it, expect } from "vitest";
import { planLegacyFinancial } from "../../scripts/migration/plan-legacy-financial";
const owner = "11111111-1111-4111-8111-111111111111",
  business = "22222222-2222-4222-8222-222222222222",
  customer = "33333333-3333-4333-8333-333333333333",
  id = "44444444-4444-4444-8444-444444444444",
  pid = "55555555-5555-4555-8555-555555555555",
  at = "2026-11-24T00:00:00Z";
const scope = () => ({
  users: new Set([owner]),
  businesses: new Map([[business, owner]]),
  customers: new Map([[customer, business]]),
});
const fixture = () => ({
  invoices: [
    {
      id,
      workspace_id: business,
      customer_id: customer,
      invoice_number: "I-1",
      issue_date: "2026-11-01",
      due_date: null,
      currency: "INR",
      total_amount: "123.45",
      amount_paid: "1.23",
      status: "sent",
      notes: "note",
      metadata: { private: { nested: true } },
      created_at: at,
      updated_at: at,
      external_provider: null,
      external_invoice_id: null,
      last_synced_at: null,
      sync_status: "local",
      last_sync_error: null,
      followup_state: "paused",
      next_follow_up_at: null,
      last_follow_up_at: null,
      reminder_count: 7,
      customer_phone: null,
      follow_up_settings: { days: [1, 2] },
      automation_version: "9007199254740993",
      deleted_at: null,
      deleted_by: null,
      custom_fields: { po: "P-1" },
    },
  ],
  payments: [
    {
      id: pid,
      workspace_id: business,
      invoice_id: id,
      amount: "1.23",
      paid_at: at,
      method: "bank",
      reference: "ref",
      metadata: { legacy: true },
      created_at: at,
      updated_at: at,
      external_provider: null,
      external_payment_id: null,
      last_synced_at: null,
      sync_status: "local",
      last_sync_error: null,
      idempotency_key: null,
      settle_remaining: false,
    },
  ],
});
it("maps complete financial state exactly without granting reminder safety or invented attribution", () => {
  const f = fixture(),
    p = planLegacyFinancial(f, scope());
  expect(p.invoices[0]).toMatchObject({
    id,
    ownerId: owner,
    financialStatus: "sent",
    amount: "123.45",
    amountPaid: "1.23",
    automationVersion: 9007199254740993n,
    lifecycleRiskVerified: false,
    metadata: f.invoices[0]!.metadata,
    followUpSettings: { days: [1, 2] },
  });
  expect(p.payments[0]).toMatchObject({
    id: pid,
    recordedBy: null,
    idempotencyKey: null,
    method: "bank",
    paidAt: new Date(at),
    metadata: { legacy: true },
  });
});
it.each(["draft", "sent", "overdue", "paid", "void", "cancelled"])(
  "preserves legacy status %s",
  (status) => {
    const f = fixture();
    f.invoices[0]!.status = status;
    if (status === "paid") {
      f.invoices[0]!.amount_paid = "123.45";
      f.payments[0]!.amount = "123.45";
    }
    expect(planLegacyFinancial(f, scope()).invoices[0]!.financialStatus).toBe(
      status,
    );
  },
);
it("blocks unknown columns rather than silently dropping state", () => {
  const f = fixture();
  Object.assign(f.invoices[0]!, { unknown_field: "valuable" });
  expect(() => planLegacyFinancial(f, scope())).toThrow();
});
it("blocks unknown followup state pending explicit mapping", () => {
  const f = fixture();
  f.invoices[0]!.followup_state = "needs_review";
  expect(() => planLegacyFinancial(f, scope())).toThrow(/Unmapped/);
});
it("blocks orphan customer scope", () => {
  const s = scope();
  s.customers.clear();
  expect(() => planLegacyFinancial(fixture(), s)).toThrow(/orphan/);
});
it("blocks overpaid invoice and nonpositive ledger", () => {
  const f = fixture();
  f.invoices[0]!.amount_paid = "999";
  expect(() => planLegacyFinancial(f, scope())).toThrow(/balance/);
  const g = fixture();
  g.payments[0]!.amount = "0";
  expect(() => planLegacyFinancial(g, scope())).toThrow(/nonpositive/);
});
it("blocks duplicate payment keys but preserves null legacy keys", () => {
  const f = fixture();
  f.payments.push({
    ...f.payments[0]!,
    id: "66666666-6666-4666-8666-666666666666",
  });
  f.invoices[0]!.amount_paid = "2.46";
  expect(planLegacyFinancial(f, scope()).payments).toHaveLength(2);
  for (const p of f.payments) p.idempotency_key = "reused" as never;
  expect(() => planLegacyFinancial(f, scope())).toThrow(/Duplicate/);
});
it("rejects numeric automation bigint rather than accepting rounded data", () => {
  const f = fixture();
  Object.assign(f.invoices[0]!, { automation_version: 9007199254740993 });
  expect(() => planLegacyFinancial(f, scope())).toThrow();
});

it("blocks ledger mismatch, absent ledger, paid-status mismatch and false settlement", () => {
  const a = fixture();
  a.payments[0]!.amount = "1.22";
  expect(() => planLegacyFinancial(a, scope())).toThrow(/ledger/);
  const b = fixture();
  b.payments = [];
  expect(() => planLegacyFinancial(b, scope())).toThrow(/ledger/);
  const c = fixture();
  c.invoices[0]!.status = "paid";
  expect(() => planLegacyFinancial(c, scope())).toThrow(/status/);
  const d = fixture();
  d.payments[0]!.settle_remaining = true;
  expect(() => planLegacyFinancial(d, scope())).toThrow(/Settlement/);
  const e = fixture();
  e.invoices[0]!.amount_paid = "123.45";
  e.payments[0]!.amount = "123.45";
  expect(() => planLegacyFinancial(e, scope())).toThrow(/status/);
});
it("accepts exact full settlement and retains void/cancelled partial ledger history", () => {
  const f = fixture();
  f.invoices[0]!.status = "paid";
  f.invoices[0]!.amount_paid = "123.45";
  f.payments[0]!.amount = "123.45";
  f.payments[0]!.settle_remaining = true;
  expect(planLegacyFinancial(f, scope()).payments[0]!.settleRemaining).toBe(
    true,
  );
  for (const status of ["void", "cancelled"]) {
    const g = fixture();
    g.invoices[0]!.status = status;
    expect(planLegacyFinancial(g, scope()).invoices[0]!.financialStatus).toBe(
      status,
    );
  }
});
