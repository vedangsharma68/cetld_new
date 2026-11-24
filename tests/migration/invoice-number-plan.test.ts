import { it, expect } from "vitest";
import {
  planInvoiceNumber,
  invoiceNumberPattern,
  type NumberHistory,
} from "../../src/server/modules/invoices/invoice-number-plan";
const history = (numbers: string[]): NumberHistory[] =>
  numbers.map((invoiceNumber, i) => ({
    id: String(i).padStart(4, "0"),
    invoiceNumber,
    createdAt: new Date(2026, 0, i + 1),
    metadata: {},
  }));
const input = {
  sourceNumber: "AUTO",
  idempotencyKey: null,
  preserveOwnerNumber: false,
  today: "2026-11-24",
};
it.each([
  [["0040", "0041"], "0042"],
  [["99", "100"], "101"],
  [["BILL/0041", "BILL/0042"], "BILL/0043"],
  [["AC-2025-0041", "AC-2025-0042"], "AC-2026-0043"],
  [["AC-2025/04/01-0041", "AC-2025/04/02-0042"], "AC-2026/11/24-0043"],
  [["AC-20250401-0041", "AC-20250402-0042"], "AC-20261124-0043"],
  [["unknown", "opaque"], "INV-2026-0001"],
  [["A-001", "B-001"], "INV-2026-0001"],
])("continues installed history convention %j", (numbers, expected) =>
  expect(planInvoiceNumber(history(numbers), input).invoiceNumber).toBe(
    expected,
  ),
);
it("excludes test labels from voting but retains all matching history for high-water mark", () => {
  const rows = history(["A-001", "A-002", "A-099"]);
  rows[2]!.metadata.test_invoice = true;
  expect(planInvoiceNumber(rows, input).invoiceNumber).toBe("A-100");
});
it("unknown rows count against a strict majority and current-year fallback cannot restart", () => {
  expect(
    planInvoiceNumber(
      history(["A-001", "opaque", "unknown", "INV-2026-9000"]),
      input,
    ).invoiceNumber,
  ).toBe("INV-2026-9001");
});
it("trusted owner explicit numbers and replay retain exact original numbers", () => {
  const rows = history(["OWNER-42"]);
  rows[0]!.metadata.assistant_idempotency_key = "key";
  expect(
    planInvoiceNumber(rows, {
      ...input,
      idempotencyKey: "key",
      sourceNumber: "changed",
    }),
  ).toMatchObject({ invoiceNumber: "OWNER-42", replayed: true });
  expect(
    planInvoiceNumber(rows, {
      ...input,
      preserveOwnerNumber: true,
      sourceNumber: "  Original-001  ",
    }).invoiceNumber,
  ).toBe("Original-001");
  expect(
    planInvoiceNumber(rows, { ...input, sourceNumber: "printed-original" }),
  ).toMatchObject({
    invoiceNumber: "OWNER-43",
    sourceInvoiceNumber: "printed-original",
  });
});
it("uses exact bigint and rejects exhaustion instead of wrapping", () => {
  expect(
    planInvoiceNumber(history(["9007199254740993"]), input).invoiceNumber,
  ).toBe("9007199254740994");
  expect(() =>
    planInvoiceNumber(history(["9223372036854775807"]), input),
  ).toThrow(/exhausted/);
  expect(() => invoiceNumberPattern("9223372036854775808")).toThrow(/range/);
});

it("blank and whitespace inputs use automatic numbering, not an empty explicit number", () => {
  for (const sourceNumber of ["", "   "]) {
    expect(
      planInvoiceNumber(history(["A-009"]), {
        ...input,
        sourceNumber,
        preserveOwnerNumber: true,
      }).invoiceNumber,
    ).toBe("A-010");
  }
});
