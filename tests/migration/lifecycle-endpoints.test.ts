import { beforeEach, it, expect, vi } from "vitest";
const { repo, session } = vi.hoisted(() => ({
  repo: { act: vi.fn(), deleted: vi.fn(), pending: vi.fn() },
  session: { getSessionUser: vi.fn() },
}));
vi.mock("@/server/modules/invoices/lifecycle.service", () => ({
  lifecycleService: {
    act: (...args: unknown[]) => repo.act(...args),
    state: async (u: string, w: string) => ({
      deleted: await repo.deleted(u, w),
      pending: await repo.pending(u, w),
    }),
  },
}));
vi.mock("@/server/lib/auth", () => session);
vi.mock("@/server/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
import { POST } from "../../src/app/api/v1/invoices/[id]/lifecycle/route";
import { GET } from "../../src/app/api/v1/invoice-lifecycle/route";
import {
  UnauthorizedError,
  ConflictError,
  NotFoundError,
} from "@/server/lib/errors";
const id = "11111111-1111-4111-8111-111111111111",
  workspace = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id }) };
const input = { action: "prepare", key: "synthetic-key-123" };
const request = (body: unknown = input, origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/v1/invoices/" + id + "/lifecycle", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  session.getSessionUser.mockResolvedValue({ id: "owner" });
  repo.act.mockResolvedValue({
    id,
    invoiceId: id,
    invoiceNumber: "I-1",
    state: "pending",
    hadPayment: false,
    hadSentReminder: false,
    expiresAt: new Date("2026-12-01T00:00:00Z"),
  });
  repo.deleted.mockResolvedValue([]);
  repo.pending.mockResolvedValue(null);
});
it("routes authenticated owner request and projects safe proposal fields", async () => {
  const r = await POST(request(), context);
  expect(r.status).toBe(200);
  expect(repo.act).toHaveBeenCalledWith("owner", id, input);
  const body = await r.json();
  expect(body.data.invoiceId).toBe(id);
  expect(body.data).not.toHaveProperty("ownerId");
  expect(body.data).not.toHaveProperty("snapshot");
  expect(r.headers.get("Cache-Control")).toBe("no-store");
});
it("denies foreign origin before auth or repository", async () => {
  expect(
    (await POST(request(input, "https://foreign.example"), context)).status,
  ).toBe(403);
  expect(repo.act).not.toHaveBeenCalled();
  expect(session.getSessionUser).not.toHaveBeenCalled();
});
it("rejects signed-out lifecycle requests", async () => {
  session.getSessionUser.mockRejectedValue(new UnauthorizedError());
  expect((await POST(request(), context)).status).toBe(401);
  expect(repo.act).not.toHaveBeenCalled();
});
it("returns404 for foreign or missing owner scope", async () => {
  repo.act.mockRejectedValue(new NotFoundError("Invoice lifecycle"));
  expect((await POST(request(), context)).status).toBe(404);
});
it.each([
  { action: "confirm", key: "synthetic-key-123", proposalId: id },
  { action: "prepare", key: "short" },
  { ...input, ownerId: "forged" },
  { action: "restore", key: "synthetic-key-123", deletedBy: "forged" },
])("rejects malformed or forged lifecycle input %j", async (body) => {
  expect((await POST(request(body), context)).status).toBe(422);
  expect(repo.act).not.toHaveBeenCalled();
});
it("preserves typed risk gate conflict", async () => {
  repo.act.mockRejectedValue(
    new ConflictError("LIFECYCLE_RISK_UNKNOWN", "Unknown reminder state"),
  );
  const r = await POST(request(), context);
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("LIFECYCLE_RISK_UNKNOWN");
});
it("reads deleted and pending state only under authenticated identity", async () => {
  const r = await GET(
    new Request(
      "http://localhost:3000/api/v1/invoice-lifecycle?workspaceId=" + workspace,
    ),
    context,
  );
  expect(r.status).toBe(200);
  expect(repo.deleted).toHaveBeenCalledWith("owner", workspace);
  expect(repo.pending).toHaveBeenCalledWith("owner", workspace);
});
it("rejects invalid lifecycle state scope", async () => {
  expect(
    (
      await GET(
        new Request(
          "http://localhost:3000/api/v1/invoice-lifecycle?workspaceId=invalid",
        ),
        context,
      )
    ).status,
  ).toBe(422);
  expect(repo.deleted).not.toHaveBeenCalled();
});
