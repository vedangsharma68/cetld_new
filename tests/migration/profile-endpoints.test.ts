import { it, expect, vi, beforeEach } from "vitest";
const { service, session } = vi.hoisted(() => ({
  service: { read: vi.fn(), update: vi.fn() },
  session: { getSessionUser: vi.fn() },
}));
vi.mock("@/server/modules/profiles/profiles.service", () => ({
  profileService: service,
}));
vi.mock("@/server/lib/auth", () => session);
vi.mock("@/server/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
import { GET, PATCH } from "../../src/app/api/v1/profile/route";
import { UnauthorizedError } from "../../src/server/lib/errors";
const context = { params: Promise.resolve({}) };
const request = (data: unknown, origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/v1/profile", {
    method: "PATCH",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(data),
  });
beforeEach(() => {
  vi.resetAllMocks();
  session.getSessionUser.mockResolvedValue({ id: "own-id" });
  service.read.mockResolvedValue({ fullName: "Exact", updatedAt: null });
  service.update.mockResolvedValue({ fullName: "Updated", updatedAt: null });
});
it("reads and writes only authenticated identity with projected output", async () => {
  expect(
    (await GET(new Request("http://localhost:3000/api/v1/profile"), context))
      .status,
  ).toBe(200);
  expect(service.read).toHaveBeenCalledWith("own-id");
  const r = await PATCH(request({ fullName: " Updated " }), context);
  expect(r.status).toBe(200);
  expect(service.update).toHaveBeenCalledWith("own-id", {
    fullName: "Updated",
  });
  expect(await r.json()).toMatchObject({
    success: true,
    data: { fullName: "Updated" },
  });
  expect(r.headers.get("Cache-Control")).toBe("no-store");
});
it.each([
  { fullName: "" },
  { fullName: "x".repeat(161) },
  { fullName: "Name", userId: "forged" },
  { fullName: "Name", avatarUrl: "https://tracker.invalid" },
])("rejects invalid/forged fields %j", async (data) => {
  expect((await PATCH(request(data), context)).status).toBe(422);
  expect(service.update).not.toHaveBeenCalled();
});
it("rejects signed-out and cross-origin writes before mutation", async () => {
  session.getSessionUser.mockRejectedValueOnce(new UnauthorizedError());
  expect((await PATCH(request({ fullName: null }), context)).status).toBe(401);
  expect(
    (
      await PATCH(
        request({ fullName: null }, "https://foreign.invalid"),
        context,
      )
    ).status,
  ).toBe(403);
  expect(service.update).not.toHaveBeenCalled();
});
