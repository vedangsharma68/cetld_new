import { it, expect } from "vitest";
import {
  reopeningLedger,
  reopeningUpdate,
} from "../../src/server/modules/invoices/reopening-plan";
const invoice = () => ({
  id: "i",
  amount: "100.00",
  amountPaid: "2.00",
  financialStatus: "sent",
  deletedAt: null,
  revision: 1,
  lifecycleRiskVerified: true,
  currency: "INR",
  dueDate: "2026-11-01",
  externalProvider: null,
  externalInvoiceId: null,
  metadata: { approved_reminder_text: "old", private: "retain" },
});
const payment = () => ({
  id: "p",
  amount: "2.00",
  externalProvider: null,
  externalPaymentId: null,
  metadata: {},
});
it("retains original receipts and excludes reversed allocations from active ledger", () => {
  expect(reopeningLedger(invoice(), [payment()], [])).toMatchObject({
    amount: "2.00",
    alreadyUnpaid: false,
  });
  expect(
    reopeningLedger({ ...invoice(), amountPaid: "0" }, [payment()], ["p"]),
  ).toMatchObject({ amount: "0.00", active: [], alreadyUnpaid: true });
  expect(payment().amount).toBe("2.00");
});
it.each([
  { lifecycleRiskVerified: false },
  { deletedAt: new Date() },
  { financialStatus: "void" },
  { financialStatus: "cancelled" },
  { currency: "JPY" },
  { amount: "0" },
  { amountPaid: "3" },
  { externalProvider: "zoho" },
  { metadata: { accounting_provider: "zoho" } },
  { metadata: { bookkeeping_record_id: "book-id" } },
])("rejects unsafe reopening %j", (change) =>
  expect(() =>
    reopeningLedger({ ...invoice(), ...change }, [payment()], []),
  ).toThrow(),
);
it("rejects externally bound receipts", () =>
  expect(() =>
    reopeningLedger(
      invoice(),
      [{ ...payment(), externalPaymentId: "external" }],
      [],
    ),
  ).toThrow(/ledger/));
it("pauses unpaid automation and clears approval without cash refund or history deletion", () => {
  expect(reopeningUpdate(invoice(), "2026-11-24")).toMatchObject({
    amountPaid: "0.00",
    financialStatus: "overdue",
    followupState: "paused",
    nextFollowUpAt: null,
    metadata: {
      private: "retain",
      approved_reminder_text: null,
      approved_preferences_updated_at: null,
    },
  });
  expect(
    reopeningUpdate({ ...invoice(), dueDate: null }, "2026-11-24")
      .financialStatus,
  ).toBe("sent");
});
