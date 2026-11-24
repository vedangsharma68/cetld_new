import { it, expect } from "vitest";
import { confirmLifecyclePlan } from "@/server/modules/invoices/lifecycle-plan";
const now = new Date("2026-11-24T10:00:00Z");
const invoice = {
  id: "i",
  number: "INV-1",
  revision: "r1",
  deletedAt: null,
  amountPaid: "0.00",
  status: "draft",
};
const proposal = {
  invoiceId: "i",
  revision: "r1",
  state: "pending" as const,
  expiresAt: new Date(now.getTime() + 600000),
  hadPayment: false,
  hadSentReminder: false,
};
const risk = {
  hadPayment: false,
  hadSentReminder: false,
  activeDispatch: false,
};
it("plans reversible deletion with reminder cancellation", () =>
  expect(
    confirmLifecyclePlan(invoice, proposal, risk, " Yes ", now),
  ).toMatchObject({
    deletedAt: now,
    followupState: "cancelled",
    nextFollowUpAt: null,
  }));
it("requires exact case-sensitive invoice phrase after payment or reminder", () => {
  for (const flag of ["hadPayment", "hadSentReminder"] as const) {
    const p = { ...proposal, [flag]: true },
      r = { ...risk, [flag]: true };
    for (const phrase of [
      "yes",
      "delete INV-1",
      "DELETE inv-1",
      "DELETE INV-1 ",
    ])
      expect(() => confirmLifecyclePlan(invoice, p, r, phrase, now)).toThrow();
    expect(
      confirmLifecyclePlan(invoice, p, r, "DELETE INV-1", now).requiresExact,
    ).toBe(true);
  }
});
it("rejects stale revision or newly accepted payment/reminder", () => {
  expect(() =>
    confirmLifecyclePlan(
      { ...invoice, revision: "r2" },
      proposal,
      risk,
      "yes",
      now,
    ),
  ).toThrow();
  for (const flag of ["hadPayment", "hadSentReminder"] as const)
    expect(() =>
      confirmLifecyclePlan(
        invoice,
        proposal,
        { ...risk, [flag]: true },
        "DELETE INV-1",
        now,
      ),
    ).toThrow();
});
it("denies exact expiry boundary and active dispatch", () => {
  expect(() =>
    confirmLifecyclePlan(
      invoice,
      { ...proposal, expiresAt: now },
      risk,
      "yes",
      now,
    ),
  ).toThrow();
  expect(() =>
    confirmLifecyclePlan(
      invoice,
      proposal,
      { ...risk, activeDispatch: true },
      "yes",
      now,
    ),
  ).toThrow();
});
it("rejects different invoice and already-deleted or nonpending proposal", () => {
  expect(() =>
    confirmLifecyclePlan(
      { ...invoice, id: "other" },
      proposal,
      risk,
      "yes",
      now,
    ),
  ).toThrow();
  expect(() =>
    confirmLifecyclePlan(
      { ...invoice, deletedAt: now },
      proposal,
      risk,
      "yes",
      now,
    ),
  ).toThrow();
  expect(() =>
    confirmLifecyclePlan(
      invoice,
      { ...proposal, state: "cancelled" },
      risk,
      "yes",
      now,
    ),
  ).toThrow();
});
