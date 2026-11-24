import { afterEach, describe, expect, it, vi } from "vitest";
import { http, httpPaginated } from "@/client/api/http";
afterEach(() => vi.unstubAllGlobals());
describe("one HTTP client", () => {
  it("retains pagination metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          data: [{ id: 1 }],
          meta: { page: 2, pageSize: 20, total: 34 },
        }),
      ),
    );
    expect(await httpPaginated("/customers")).toEqual({
      data: [{ id: 1 }],
      meta: { page: 2, pageSize: 20, total: 34 },
    });
  });
  it("returns undefined for204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    expect(await http("/customers/1", { method: "DELETE" })).toBeUndefined();
  });
  it("typed failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Please sign in",
              requestId: "r",
            },
          },
          { status: 401 },
        ),
      ),
    );
    await expect(http("/customers")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      requestId: "r",
    });
  });
  it("network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(http("/customers")).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
    });
  });
});
