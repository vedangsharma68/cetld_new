import { it, expect, vi, beforeEach } from "vitest";
const { service, session } = vi.hoisted(() => ({
  service: { list: vi.fn() },
  session: { getSessionUser: vi.fn() },
}));
vi.mock(
  "@/server/modules/invoice-correction-audits/invoice-correction-audits.service",
  () => ({
    invoiceCorrectionAuditsService: service,
  }),
);
vi.mock("@/server/lib/auth", () => session);
vi.mock("@/server/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
import { GET } from "../../src/app/api/v1/invoices/[id]/correction-history/route";
import { UnauthorizedError, NotFoundError } from "../../src/server/lib/errors";
const workspace = "22222222-2222-4222-8222-222222222222",
  context = {
    params: Promise.resolve({ id: "44444444-4444-4444-8444-444444444444" }),
  };
const request = (query = "workspaceId=" + workspace) =>
  new Request("http://localhost:3000/api/v1/business-records?" + query);
beforeEach(() => {
  vi.resetAllMocks();
  session.getSessionUser.mockResolvedValue({ id: "member" });
  service.list.mockResolvedValue({ records: [] });
});
it("routes only authenticated owner scope and returns standard uncacheable response", async () => {
  const r = await GET(request(), context);
  expect(r.status).toBe(200);
  expect(service.list).toHaveBeenCalledWith(
    "member",
    workspace,
    "44444444-4444-4444-8444-444444444444",
    undefined,
    25,
  );
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  expect(await r.json()).toMatchObject({
    success: true,
    data: { records: [] },
  });
});
it("rejects unsigned reads and hides foreign business", async () => {
  session.getSessionUser.mockRejectedValueOnce(new UnauthorizedError());
  expect((await GET(request(), context)).status).toBe(401);
  service.list.mockRejectedValueOnce(new NotFoundError("Business records"));
  expect((await GET(request(), context)).status).toBe(404);
});
it.each([
  "workspaceId=bad",
  "workspaceId=" + workspace + "&ownerId=forged",
  "",
])("rejects invalid query %s", async (query) => {
  expect((await GET(request(query), context)).status).toBe(400);
  expect(service.list).not.toHaveBeenCalled();
});

it.each([
  "limit=0",
  "limit=51",
  "limit=-1",
  "limit=2.5",
  "limit=1e2",
  "limit=001",
  "after=bad",
])("rejects invalid paging %s", async (query) => {
  expect(
    (await GET(request("workspaceId=" + workspace + "&" + query), context))
      .status,
  ).toBe(400);
  expect(service.list).not.toHaveBeenCalled();
});
it("passes bounded limit and strict composite timestamp/UUIDcursor", async () => {
  const after =
    "2026-11-24T00:00:00.123456Z|33333333-3333-4333-8333-333333333333";
  expect(
    (
      await GET(
        request("workspaceId=" + workspace + "&limit=2&after=" + after),
        context,
      )
    ).status,
  ).toBe(200);
  expect(service.list).toHaveBeenCalledWith(
    "member",
    workspace,
    "44444444-4444-4444-8444-444444444444",
    after,
    2,
  );
});
