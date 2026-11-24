import { beforeEach, describe, expect, it, vi } from "vitest";
const { getUser, service } = vi.hoisted(() => ({
  getUser: vi.fn(),
  service: {
    list: vi.fn(),
    detail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("@/server/lib/auth", () => ({ getSessionUser: getUser }));
vi.mock("@/server/modules/customers/customers.service", () => ({
  customerService: service,
}));
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
import { UnauthorizedError, NotFoundError } from "@/server/lib/errors";
import { GET, POST } from "@/app/api/v1/customers/route";
import {
  GET as DETAIL,
  PATCH,
  DELETE,
} from "@/app/api/v1/customers/[id]/route";
const id = "11111111-1111-4111-8111-111111111111",
  workspaceId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id }) };
function request(method = "GET", body?: unknown) {
  return new Request(
    `http://localhost:3000/api/v1/customers?workspaceId=${workspaceId}`,
    {
      method,
      headers: { origin: "http://localhost:3000" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  getUser.mockResolvedValue({ id: "u", role: "member" });
  service.list.mockResolvedValue({
    rows: [{ id }],
    meta: { page: 1, pageSize: 20, total: 1 },
  });
  service.detail.mockResolvedValue({ id });
  service.create.mockResolvedValue({ id });
  service.update.mockResolvedValue({ id });
});
describe("customer route contracts", () => {
  it("GET list200 and bad query400", async () => {
    expect((await GET(request(), context)).status).toBe(200);
    expect(
      (
        await GET(
          new Request("http://localhost:3000/api/v1/customers?page=0"),
          context,
        )
      ).status,
    ).toBe(400);
  });
  it("POST201 and validation422", async () => {
    expect(
      (await POST(request("POST", { workspaceId, name: "Test" }), context))
        .status,
    ).toBe(201);
    expect(
      (await POST(request("POST", { workspaceId, name: "" }), context)).status,
    ).toBe(422);
  });
  it("GET detail200 and concealed404", async () => {
    expect((await DETAIL(request(), context)).status).toBe(200);
    service.detail.mockRejectedValue(new NotFoundError("Customer"));
    expect((await DETAIL(request(), context)).status).toBe(404);
  });
  it("PATCH200 and validation422", async () => {
    expect(
      (await PATCH(request("PATCH", { name: "Test" }), context)).status,
    ).toBe(200);
    expect((await PATCH(request("PATCH", {}), context)).status).toBe(422);
  });
  it("DELETE204 and concealed404", async () => {
    expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    service.remove.mockRejectedValue(new NotFoundError("Customer"));
    expect((await DELETE(request("DELETE"), context)).status).toBe(404);
  });
  it.each([GET, POST, DETAIL, PATCH, DELETE])(
    "requires a live session",
    async (route) => {
      getUser.mockRejectedValue(new UnauthorizedError());
      expect((await route(request(), context)).status).toBe(401);
    },
  );
});

it("malformed customer path id is400", async () => {
  getUser.mockResolvedValue({ id: "u" });
  expect(
    (await DETAIL(request(), { params: Promise.resolve({ id: "not-a-uuid" }) }))
      .status,
  ).toBe(400);
});
