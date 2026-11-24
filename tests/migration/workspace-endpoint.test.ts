import { describe, expect, it, vi } from "vitest";
const { getUser, service } = vi.hoisted(() => ({
  getUser: vi.fn(),
  service: { listForUser: vi.fn() },
}));
vi.mock("@/server/lib/auth", () => ({ getSessionUser: getUser }));
vi.mock("@/server/modules/workspaces/workspaces.service", () => ({
  workspaceService: service,
}));
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
import { GET } from "@/app/api/v1/workspaces/route";
import { UnauthorizedError } from "@/server/lib/errors";
const context = { params: Promise.resolve({}) };
const request = () => new Request("http://localhost:3000/api/v1/workspaces");
describe("workspace route", () => {
  it("200 with server session principal", async () => {
    getUser.mockResolvedValue({ id: "u" });
    service.listForUser.mockResolvedValue([{ id: "w", name: "Business" }]);
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(service.listForUser).toHaveBeenCalledWith("u");
  });
  it("401 before listing", async () => {
    getUser.mockRejectedValue(new UnauthorizedError());
    expect((await GET(request(), context)).status).toBe(401);
  });
});
