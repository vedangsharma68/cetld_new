import { describe, it, expect, vi, beforeEach } from "vitest";
const { repository, session } = vi.hoisted(() => ({
  repository: { record: vi.fn() },
  session: { getSessionUser: vi.fn() },
}));
vi.mock("@/server/modules/invoices/payments.repository", () => ({
  paymentRepository: repository,
}));
vi.mock("@/server/lib/auth", () => session);
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
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
    repository.record.mockResolvedValue({
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
    expect(repository.record).toHaveBeenCalledWith("user", id, input);
    expect(await response.json()).toEqual({
      success: true,
      data: { id: "p", amount: "1.01" },
    });
  });
  it("hides foreign/missing invoice", async () => {
    repository.record.mockResolvedValue(null);
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
    expect(repository.record).not.toHaveBeenCalled();
  });
});
