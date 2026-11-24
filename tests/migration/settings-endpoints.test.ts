import { it, expect, vi, beforeEach } from "vitest";
const { service, session } = vi.hoisted(() => ({
  service: { read: vi.fn() },
  session: { getSessionUser: vi.fn() },
}));
vi.mock("@/server/modules/settings/settings.service", () => ({
  settingsService: service,
}));
vi.mock("@/server/lib/auth", () => session);
vi.mock("@/server/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
import { GET } from "../../src/app/api/v1/settings/route";
import { UnauthorizedError, NotFoundError } from "../../src/server/lib/errors";
const workspace = "22222222-2222-4222-8222-222222222222",
  context = { params: Promise.resolve({}) };
const request = (query = "workspaceId=" + workspace) =>
  new Request("http://localhost:3000/api/v1/settings?" + query);
beforeEach(() => {
  vi.resetAllMocks();
  session.getSessionUser.mockResolvedValue({ id: "member" });
  service.read.mockResolvedValue({
    workspaceId: workspace,
    canEdit: false,
    settings: null,
    aiSettings: null,
  });
});
it("routes only authenticated membership and returns standard uncacheable response", async () => {
  const r = await GET(request(), context);
  expect(r.status).toBe(200);
  expect(service.read).toHaveBeenCalledWith("member", workspace);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  expect(await r.json()).toMatchObject({
    success: true,
    data: { workspaceId: workspace, settings: null },
  });
});
it("rejects unsigned reads and hides foreign business", async () => {
  session.getSessionUser.mockRejectedValueOnce(new UnauthorizedError());
  expect((await GET(request(), context)).status).toBe(401);
  service.read.mockRejectedValueOnce(new NotFoundError("Business settings"));
  expect((await GET(request(), context)).status).toBe(404);
});
it.each([
  "workspaceId=bad",
  "workspaceId=" + workspace + "&ownerId=forged",
  "",
])("rejects invalid query %s", async (query) => {
  expect((await GET(request(query), context)).status).toBe(400);
  expect(service.read).not.toHaveBeenCalled();
});
