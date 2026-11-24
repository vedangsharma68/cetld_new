import { describe, expect, it, vi } from "vitest";
const { ping, storage } = vi.hoisted(() => ({
  ping: vi.fn(),
  storage: vi.fn(),
}));
vi.mock("@/server/modules/health/health.repository", () => ({
  pingDatabase: ping,
}));
vi.mock("@/server/lib/storage", () => ({ checkStorage: storage }));
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
import { health } from "@/server/modules/health/health.service";
import { GET } from "@/app/api/health/route";
import { StorageError } from "@/server/lib/errors";
const context = { params: Promise.resolve({}) };
const request = () => new Request("http://localhost:3000/api/health");
describe("health", () => {
  it("checks both dependencies and returns envelope", async () => {
    ping.mockResolvedValue(undefined);
    storage.mockResolvedValue(undefined);
    expect(await health()).toEqual({ status: "ok", db: "ok", storage: "ok" });
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: "ok", db: "ok", storage: "ok" },
    });
  });
  it("unreachable DB503", async () => {
    ping.mockRejectedValue({ code: "ECONNREFUSED" });
    expect((await GET(request(), context)).status).toBe(503);
  });
  it("storage unavailable502", async () => {
    ping.mockResolvedValue(undefined);
    storage.mockRejectedValue(new StorageError());
    expect((await GET(request(), context)).status).toBe(502);
  });
});
