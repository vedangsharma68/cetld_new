import { describe, it, expect, vi, beforeEach } from "vitest";
const { repository, session } = vi.hoisted(() => ({
  repository: { withLockedInvoice: vi.fn() },
  session: { getSessionUser: vi.fn() },
}));
vi.mock("@/server/modules/invoices/payments.repository", () => ({
  paymentRepository: repository,
}));
vi.mock("@/server/lib/auth", () => session);
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
import type { PaymentTransaction } from "@/server/modules/invoices/payments.repository";
import { createPaymentService } from "@/server/modules/invoices/payments.service";
import { paymentController } from "@/server/modules/invoices/payments.controller";
import { withHandler } from "@/server/lib/handler";
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  amount: "1.01",
  settleRemaining: false,
  reference: null,
  idempotencyKey: "synthetic-test",
};
beforeEach(() => {
  vi.resetAllMocks();
  session.getSessionUser.mockResolvedValue({ id: "user" });
});
describe("payment service and endpoint", () => {
  it("records with authenticated identity and typed data", async () => {
    repository.withLockedInvoice.mockResolvedValue({
      id: "p",
      amount: "1.01",
      metadata: { private: "secret" },
      externalPaymentId: "provider-private",
      lastSyncError: "private-error",
    });
    const response = await withHandler(paymentController.record)(
      new Request("http://localhost:3000/api/v1/invoices/" + id + "/payments", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(repository.withLockedInvoice).toHaveBeenCalledWith(
      "user",
      id,
      input.idempotencyKey,
      expect.any(Function),
    );
    expect(await response.json()).toEqual({
      success: true,
      data: { id: "p", amount: "1.01" },
    });
  });
  it("hides foreign/missing invoice", async () => {
    repository.withLockedInvoice.mockResolvedValue(null);
    await expect(
      createPaymentService().record("user", id, input),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("invalid mixed settlement returns422 before repository", async () => {
    const response = await withHandler(paymentController.record)(
      new Request("http://localhost:3000/api/v1/invoices/" + id + "/payments", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...input, settleRemaining: true }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(422);
    expect(repository.withLockedInvoice).not.toHaveBeenCalled();
  });
});

describe("payment service owns locked financial decisions", () => {
  function context(status = "sent", amountPaid = "0") {
    return {
      invoice: {
        id,
        workspaceId: "business",
        amount: "10",
        amountPaid,
        financialStatus: status,
        deletedAt: null,
        currency: "INR",
        metadata: { private: "kept" },
      },
      existing: null,
      insertPayment: vi.fn().mockResolvedValue({ id: "p", amount: "1.01" }),
      updateInvoice: vi.fn().mockResolvedValue(undefined),
    } as unknown as PaymentTransaction;
  }
  function wire(tx: PaymentTransaction) {
    repository.withLockedInvoice.mockImplementation(
      async (_u, _id, _key, run) => run(tx),
    );
  }
  it("plans partial payment within the lock, preserving legacy nonterminal status", async () => {
    const tx = context();
    wire(tx);
    expect(await createPaymentService().record("user", id, input)).toEqual({
      id: "p",
      amount: "1.01",
    });
    expect(tx.insertPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "business",
        invoiceId: id,
        recordedBy: "user",
        amount: "1.01",
      }),
    );
    expect(tx.updateInvoice).toHaveBeenCalledWith({
      amountPaid: "1.01",
      financialStatus: "sent",
    });
  });
  it("full settlement atomically cancels future reminders while retaining unrelated private metadata", async () => {
    const tx = context("overdue", "8.99");
    wire(tx);
    await createPaymentService().record("user", id, input);
    expect(tx.updateInvoice).toHaveBeenCalledWith({
      amountPaid: "10.00",
      financialStatus: "paid",
      followupState: "cancelled",
      nextFollowUpAt: null,
      metadata: {
        private: "kept",
        followup_state: "cancelled",
        next_follow_up_at: null,
      },
    });
  });
  it("rejects terminal and deleted state without persistence", async () => {
    for (const status of ["paid", "void", "cancelled"]) {
      const tx = context(status);
      wire(tx);
      await expect(
        createPaymentService().record("user", id, input),
      ).rejects.toMatchObject({ code: "INVOICE_TERMINAL" });
      expect(tx.insertPayment).not.toHaveBeenCalled();
      expect(tx.updateInvoice).not.toHaveBeenCalled();
    }
    const tx = context();
    tx.invoice.deletedAt = new Date();
    wire(tx);
    await expect(
      createPaymentService().record("user", id, input),
    ).rejects.toMatchObject({ code: "INVOICE_DELETED" });
    expect(tx.insertPayment).not.toHaveBeenCalled();
  });
  it("empty insert aborts before invoice balance is changed", async () => {
    const tx = context();
    vi.mocked(tx.insertPayment).mockResolvedValue(null);
    wire(tx);
    await expect(
      createPaymentService().record("user", id, input),
    ).rejects.toThrow("Payment insert returned no row");
    expect(tx.updateInvoice).not.toHaveBeenCalled();
  });
  it("exact replay returns projected receipt without writing", async () => {
    const tx = context();
    tx.existing = {
      id: "prior",
      amount: "1.01",
      invoiceId: id,
      settleRemaining: false,
      reference: null,
    } as PaymentTransaction["existing"];
    wire(tx);
    expect(await createPaymentService().record("user", id, input)).toEqual({
      id: "prior",
      amount: "1.01",
    });
    expect(tx.insertPayment).not.toHaveBeenCalled();
    expect(tx.updateInvoice).not.toHaveBeenCalled();
  });
});
