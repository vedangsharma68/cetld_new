import { it, expect } from "vitest";
import { planLegacyFinancial } from "../../scripts/migration/plan-legacy-financial";
import {
  financialFixture as fixture,
  financialScope as scope,
} from "./financial-fixture";
const owner = "11111111-1111-4111-8111-111111111111",
  business = "22222222-2222-4222-8222-222222222222",
  customer = "33333333-3333-4333-8333-333333333333",
  id = "44444444-4444-4444-8444-444444444444",
  pid = "55555555-5555-4555-8555-555555555555",
  at = "2026-11-24T00:00:00Z";
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
it("preserves reversed receipts and exact sequence high-water marks without treating them as paid", () => {
  const f = fixture();
  const proposalId = "66666666-6666-4666-8666-666666666666";
  Object.assign(f, {
    invoice_reopening_proposals: [
      {
        id: proposalId,
        workspace_id: business,
        owner_id: owner,
        phone: "+12025550101",
        invoice_id: id,
        source_message_id: "original-source",
        invoice_number: "I-1",
        currency: "INR",
        amount: "1.23",
        expected_updated_at: at,
        ledger_fingerprint: "original-hash",
        payment_ids: [pid],
        state: "confirmed",
        created_at: at,
        expires_at: at,
        decision_message_id: "original-decision",
        result: { private: "original" },
      },
    ],
    payment_reversals: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        workspace_id: business,
        invoice_id: id,
        payment_id: pid,
        proposal_id: proposalId,
        amount: "1.23",
        actor_id: owner,
        reason: "owner_invoice_reopening",
        recorded_at: at,
      },
    ],
    invoice_number_sequences: [
      {
        workspace_id: business,
        invoice_year: 2026,
        last_value: "9007199254740993",
      },
    ],
  });
  f.payments[0]!.settle_remaining = true;
  f.invoices[0]!.amount_paid = "0";
  const p = planLegacyFinancial(f, scope());
  expect(p.payments).toHaveLength(1);
  expect(p.paymentReversals[0]!.amount).toBe("1.23");
  expect(p.invoiceNumberSequences[0]!.lastValue).toBe(9007199254740993n);
  expect(p.invoiceReopeningProposals[0]!.result).toEqual({
    private: "original",
  });
  const resettled = structuredClone(f);
  resettled.invoices[0]!.amount_paid = "123.45";
  resettled.invoices[0]!.status = "paid";
  resettled.payments.push({
    ...resettled.payments[0]!,
    id: "88888888-8888-4888-8888-888888888888",
    amount: "123.45",
    idempotency_key: null,
    settle_remaining: true,
  });
  expect(planLegacyFinancial(resettled, scope()).payments).toHaveLength(2);
  expect(planLegacyFinancial(resettled, scope()).invoices[0]!.amountPaid).toBe(
    "123.45",
  );
  for (const change of [
    { amount: "1.22" },
    { actor_id: customer },
    { workspace_id: customer },
    { invoice_id: customer },
    { payment_id: customer },
    { proposal_id: customer },
  ]) {
    const bad = structuredClone(f);
    Object.assign((bad.payment_reversals as object[])[0]!, change);
    expect(() => planLegacyFinancial(bad, scope())).toThrow();
  }
  const duplicate = structuredClone(f);
  duplicate.payment_reversals.push(duplicate.payment_reversals[0]!);
  expect(() => planLegacyFinancial(duplicate, scope())).toThrow(/Duplicate/);
  const omitted: Record<string, unknown> = structuredClone(f);
  delete omitted.payment_reversals;
  expect(() => planLegacyFinancial(omitted, scope())).toThrow();
});
it("requires all financial-history slices even when empty and checks sequence boundaries", () => {
  for (const table of [
    "payment_reversals",
    "invoice_reopening_proposals",
    "invoice_number_sequences",
  ]) {
    const f: Record<string, unknown> = fixture();
    delete f[table];
    expect(() => planLegacyFinancial(f, scope())).toThrow();
  }
  for (const sequence of [
    { workspace_id: business, invoice_year: 1999, last_value: "1" },
    { workspace_id: business, invoice_year: 2026, last_value: "0" },
    {
      workspace_id: business,
      invoice_year: 2026,
      last_value: "9223372036854775808",
    },
    { workspace_id: customer, invoice_year: 2026, last_value: "1" },
    {
      workspace_id: business,
      invoice_year: 2026,
      last_value: 9007199254740992,
    },
  ]) {
    const f = fixture();
    Object.assign(f, { invoice_number_sequences: [sequence] });
    expect(() => planLegacyFinancial(f, scope())).toThrow();
  }
  const f = fixture(),
    sequence = { workspace_id: business, invoice_year: 2026, last_value: "1" };
  Object.assign(f, { invoice_number_sequences: [sequence, sequence] });
  expect(() => planLegacyFinancial(f, scope())).toThrow(/Duplicate/);
});
