import { describe, it, expect } from "vitest";
import {
  planPayment,
  type PaymentState,
} from "@/server/modules/invoices/payment-plan";
import { moneyUnits, moneyString } from "@/shared/schemas/exact-money";
const state: PaymentState = {
  amount: "9999999999999999.99",
  amountPaid: "0.00",
  financialStatus: "open",
  deletedAt: null,
  currency: "INR",
};
const input = {
  amount: "0.01",
  settleRemaining: false,
  reference: null,
  idempotencyKey: "synthetic-key",
};
describe("exact financial settlement plan", () => {
  it("keeps high values exact without floating point", () => {
    expect(moneyString(moneyUnits(state.amount))).toBe(state.amount);
    expect(planPayment("i", state, input, null)).toMatchObject({
      amountPaid: "0.01",
      financialStatus: "open",
    });
  });
  it("settles exactly the current remaining balance", () =>
    expect(
      planPayment(
        "i",
        { ...state, amount: "12.34", amountPaid: "10.01" },
        { ...input, amount: undefined, settleRemaining: true },
        null,
      ),
    ).toMatchObject({
      amount: "2.33",
      amountPaid: "12.34",
      financialStatus: "paid",
    }));
  it("replays identical bound request before terminal-state rejection", () =>
    expect(
      planPayment("i", { ...state, financialStatus: "paid" }, input, {
        invoiceId: "i",
        amount: "0.01",
        settleRemaining: false,
        reference: null,
      }),
    ).toMatchObject({ replayed: true }));
  it("rejects changed invoice reference amount or mode on key reuse", () => {
    for (const payment of [
      {
        invoiceId: "other",
        amount: "0.01",
        settleRemaining: false,
        reference: null,
      },
      {
        invoiceId: "i",
        amount: "0.02",
        settleRemaining: false,
        reference: null,
      },
      {
        invoiceId: "i",
        amount: "0.01",
        settleRemaining: true,
        reference: null,
      },
      {
        invoiceId: "i",
        amount: "0.01",
        settleRemaining: false,
        reference: "changed",
      },
    ])
      expect(() => planPayment("i", state, input, payment)).toThrow();
  });
  it("rejects deleted terminal zero overpayment and unsupported precision", () => {
    for (const s of [
      { ...state, deletedAt: new Date() },
      { ...state, financialStatus: "void" as const },
      { ...state, financialStatus: "cancelled" as const },
      { ...state, financialStatus: "paid" as const },
    ])
      expect(() => planPayment("i", s, input, null)).toThrow();
    for (const amount of ["0", "1.001", "10000000000000000", "-1"])
      expect(() =>
        planPayment(
          "i",
          { ...state, amount: "1.00" },
          { ...input, amount },
          null,
        ),
      ).toThrow();
    expect(() =>
      planPayment("i", state, { ...input, settleRemaining: true }, null),
    ).toThrow();
  });
});

it("denies deleted invoice replay before returning ledger data", () => {
  expect(() =>
    planPayment("i", { ...state, deletedAt: new Date() }, input, {
      invoiceId: "i",
      amount: "0.01",
      settleRemaining: false,
      reference: null,
    }),
  ).toThrow(/Restore/);
});
it("allows draft payment as legacy RPC does", () => {
  expect(
    planPayment("i", { ...state, financialStatus: "draft" }, input, null),
  ).toMatchObject({ amountPaid: "0.01" });
});

it.each(["draft", "open", "partially_paid"] as const)(
  "partial payment preserves prior %s financial status",
  (financialStatus) =>
    expect(
      planPayment("i", { ...state, financialStatus }, input, null)
        .financialStatus,
    ).toBe(financialStatus),
);
