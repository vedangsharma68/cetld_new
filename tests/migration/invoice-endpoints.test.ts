import { describe, it, expect, vi, beforeEach } from "vitest";
const { service, auth } = vi.hoisted(() => ({
  service: {
    list: vi.fn(),
    detail: vi.fn(),
    create: vi.fn(),
    upload: vi.fn(),
    finalize: vi.fn(),
    download: vi.fn(),
    remove: vi.fn(),
  },
  auth: vi.fn(),
}));
vi.mock("@/server/modules/invoices/invoices.service", () => ({
  invoiceService: service,
}));
vi.mock("@/server/lib/auth", () => ({ getSessionUser: auth }));
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
import { GET as list, POST as create } from "@/app/api/v1/invoices/route";
import {
  GET as detail,
  PATCH as finalize,
  DELETE as remove,
} from "@/app/api/v1/invoices/[id]/route";
import { POST as upload } from "@/app/api/v1/invoices/[id]/upload-url/route";
import { GET as download } from "@/app/api/v1/invoices/[id]/download-url/route";
import { UnauthorizedError, NotFoundError } from "@/server/lib/errors";
const id = "66666666-6666-4666-8666-666666666666",
  ws = "22222222-2222-4222-8222-222222222222",
  c = { params: Promise.resolve({ id }) };
const req = (method: string, path: string, body?: unknown) =>
  new Request("http://localhost:3000/api/v1/" + path, {
    method,
    headers: { origin: "http://localhost:3000" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ id: "u" });
});
describe("invoice route contracts", () => {
  it("GET list200 and bad query400", async () => {
    service.list.mockResolvedValue({
      rows: [],
      meta: { page: 1, pageSize: 20, total: 0 },
    });
    expect(
      (await list(req("GET", `invoices?workspaceId=${ws}`), c)).status,
    ).toBe(200);
    expect((await list(req("GET", "invoices?workspaceId=bad"), c)).status).toBe(
      400,
    );
  });
  it("POST metadata201 and invalid422", async () => {
    service.create.mockResolvedValue({ id });
    expect(
      (
        await create(
          req("POST", "invoices", {
            workspaceId: ws,
            invoiceNumber: "INV1",
            amount: "12.34",
            currency: "INR",
          }),
          c,
        )
      ).status,
    ).toBe(201);
    expect((await create(req("POST", "invoices", {}), c)).status).toBe(422);
  });
  it("GET detail200 and foreign404", async () => {
    service.detail.mockResolvedValue({ id });
    expect((await detail(req("GET", "invoices/" + id), c)).status).toBe(200);
    service.detail.mockRejectedValue(new NotFoundError("Invoice"));
    expect((await detail(req("GET", "invoices/" + id), c)).status).toBe(404);
  });
  it("upload200 and invalid422", async () => {
    service.upload.mockResolvedValue({
      signedUrl: "https://fixture.invalid",
      token: "t",
      path: "owner/id.pdf",
    });
    expect(
      (
        await upload(
          req("POST", "invoices/" + id + "/upload-url", {
            fileName: "a.pdf",
            mimeType: "application/pdf",
            size: 4,
          }),
          c,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await upload(
          req("POST", "invoices/" + id + "/upload-url", { path: "untrusted" }),
          c,
        )
      ).status,
    ).toBe(422);
  });
  it("finalize200 and invalid422", async () => {
    service.finalize.mockResolvedValue({ id, status: "uploaded" });
    expect(
      (
        await finalize(
          req("PATCH", "invoices/" + id, { status: "uploaded" }),
          c,
        )
      ).status,
    ).toBe(200);
    expect(
      (await finalize(req("PATCH", "invoices/" + id, { status: "other" }), c))
        .status,
    ).toBe(422);
  });
  it("download200 and signed-out401", async () => {
    service.download.mockResolvedValue({
      url: "https://fixture.invalid",
      expiresIn: 60,
    });
    expect(
      (await download(req("GET", "invoices/" + id + "/download-url"), c))
        .status,
    ).toBe(200);
    auth.mockRejectedValue(new UnauthorizedError());
    expect(
      (await download(req("GET", "invoices/" + id + "/download-url"), c))
        .status,
    ).toBe(401);
  });
  it("DELETE is fail-closed and never calls permanent removal", async () => {
    const response = await remove(req("DELETE", "invoices/" + id), c);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "LIFECYCLE_CONFIRMATION_REQUIRED" },
    });
    expect(service.remove).not.toHaveBeenCalled();
  });
});
