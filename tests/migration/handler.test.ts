import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
import { withHandler } from "@/server/lib/handler";
import {
  AppError,
  ForbiddenError,
  StorageError,
  UnauthorizedError,
} from "@/server/lib/errors";
import { readJson } from "@/server/lib/validation";
import { ok, created, noContent } from "@/server/lib/response";
import { z } from "zod";
const context = { params: Promise.resolve({}) };
function request(method = "GET", body?: string) {
  return new Request("http://localhost:3000/api/v1/test", {
    method,
    headers: { origin: "http://localhost:3000" },
    ...(body ? { body } : {}),
  });
}
describe("request boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    [200, () => ok({ id: "a" })],
    [201, () => created({ id: "a" })],
    [204, () => noContent()],
  ] as const)("success %s", async (status, response) => {
    const result = await withHandler(async () => response())(
      request(),
      context,
    );
    expect(result.status).toBe(status);
    expect(result.headers.get("X-Request-Id")).toBeTruthy();
    if (status === 204) expect(await result.text()).toBe("");
    else
      expect(await result.json()).toMatchObject({
        success: true,
        data: { id: "a" },
      });
  });
  it.each([
    [new UnauthorizedError(), 401, "UNAUTHORIZED"],
    [new ForbiddenError(), 403, "FORBIDDEN"],
    [new StorageError(), 502, "STORAGE_UNAVAILABLE"],
    [{ code: "23505", detail: "secret sql" }, 409, "DUPLICATE"],
    [{ cause: { code: "23503" } }, 409, "RELATED_RECORD"],
    [
      { code: "ECONNREFUSED", message: "postgres://secret" },
      503,
      "DATABASE_UNAVAILABLE",
    ],
    [new Error("secret SQL invoice amount"), 500, "INTERNAL_ERROR"],
    [
      new AppError(500, "PRIVATE", "do not leak", undefined, false),
      500,
      "INTERNAL_ERROR",
    ],
  ])("typed errors", async (error, status, code) => {
    const result = await withHandler(async () => {
      throw error;
    })(request(), context);
    expect(result.status).toBe(status);
    const text = await result.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("do not leak");
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      error: { code, requestId: expect.any(String) },
    });
  });
  it("only classifies JSON syntax at parse boundary", async () => {
    const parse = await withHandler(async (req) => {
      await readJson(req);
      return ok(null);
    })(request("POST", "{"), context);
    expect(parse.status).toBe(400);
    const programming = await withHandler(async () => {
      throw new SyntaxError("private internal parser");
    })(request(), context);
    expect(programming.status).toBe(500);
  });
  it("validation details are field-level", async () => {
    const response = await withHandler(async () => {
      z.object({ name: z.string() }).parse({ name: 4 });
      return ok(null);
    })(request(), context);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { details: { fieldErrors: { name: expect.any(Array) } } },
    });
  });
  it("rejects cross-origin writes", async () => {
    const controller = vi.fn(async () => ok(null));
    const result = await withHandler(controller)(
      new Request("http://localhost:3000/api/v1/test", {
        method: "POST",
        headers: { origin: "https://evil.invalid" },
      }),
      context,
    );
    expect(result.status).toBe(403);
    expect(controller).not.toHaveBeenCalled();
  });
});
