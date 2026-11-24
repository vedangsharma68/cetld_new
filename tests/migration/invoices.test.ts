import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/server/modules/invoices/invoices.repository", () => ({
  invoiceRepository: {},
}));
vi.mock("@/server/modules/invoices/storage-cleanup.service", () => ({
  sweepInvoiceFiles: vi.fn(),
}));
vi.mock("@/server/lib/storage", () => ({}));
vi.mock("@/server/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { createInvoiceService } from "@/server/modules/invoices/invoices.service";
import {
  canReadInvoice,
  canDeleteInvoice,
} from "@/server/modules/invoices/invoices.policy";
import { createInvoiceSchema } from "@/shared/schemas/invoices.schema";
const row = {
  id: "invoice",
  ownerId: "stored-owner",
  workspaceId: "business",
  customerId: null,
  invoiceNumber: "INV1",
  amount: "12.34",
  currency: "INR",
  status: "pending_upload" as "pending_upload" | "uploaded",
  filePath: null as string | null,
  fileSize: null as number | null,
  mimeType: null as string | null,
  uploadedAt: null,
  createdAt: new Date(),
};
const setup = () => {
  const repo = {
    membership: vi
      .fn()
      .mockResolvedValue({ workspaceId: "business", role: "owner" }),
    list: vi.fn().mockResolvedValue({ rows: [row], total: 1 }),
    find: vi.fn().mockResolvedValue({ ...row }),
    create: vi.fn().mockResolvedValue({ ...row }),
    reserveUpload: vi.fn().mockResolvedValue({ ...row }),
    finalize: vi.fn().mockResolvedValue({ ...row, status: "uploaded" }),
    remove: vi
      .fn()
      .mockResolvedValue({ jobId: "job", path: "stored-owner/invoice.pdf" }),
    finishCleanup: vi.fn(),
    dueCleanup: vi.fn(),
  };
  const files = {
    checkStorage: vi.fn(),
    createUploadUrl: vi.fn().mockResolvedValue({
      signedUrl: "https://fixture.invalid/signed",
      token: "t",
      path: "stored-owner/invoice.pdf",
    }),
    createDownloadUrl: vi.fn().mockResolvedValue({
      url: "https://fixture.invalid/signed",
      expiresIn: 60,
    }),
    deleteFile: vi.fn(),
    inspectInvoiceFile: vi.fn(),
  };
  return { repo, files, service: createInvoiceService(repo, files) };
};
beforeEach(() => vi.clearAllMocks());
describe("invoice membership and file lifecycle", () => {
  it("member read allowed, only owner deletes", () => {
    expect(() =>
      canReadInvoice({ workspaceId: "business", role: "member" }, "business"),
    ).not.toThrow();
    expect(() =>
      canDeleteInvoice({ workspaceId: "business", role: "member" }, "business"),
    ).toThrow();
    expect(() => canReadInvoice(null, "business")).toThrow();
  });
  it("list returns pagination metadata", async () => {
    const { service } = setup();
    expect(
      await service.list("member", {
        workspaceId: "business",
        page: 1,
        pageSize: 20,
      }),
    ).toMatchObject({ meta: { total: 1 } });
  });
  it("creates server-owned metadata only after membership", async () => {
    const { service, repo } = setup();
    await service.create("member", {
      workspaceId: "business",
      invoiceNumber: "INV1",
      amount: "12.34",
      currency: "INR",
    });
    expect(repo.create).toHaveBeenCalled();
  });
  it("foreign record returns404 before signing", async () => {
    const { service, repo, files } = setup();
    repo.find.mockResolvedValue(null);
    await expect(
      service.upload("foreign", "invoice", {
        fileName: "x.pdf",
        mimeType: "application/pdf",
        size: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(files.createUploadUrl).not.toHaveBeenCalled();
  });
  it("stored owner determines upload path, never caller", async () => {
    const { service, files } = setup();
    await service.upload("member", "invoice", {
      fileName: "../../untrusted.pdf",
      mimeType: "application/pdf",
      size: 10,
    });
    expect(files.createUploadUrl).toHaveBeenCalledWith(
      "stored-owner",
      "invoice",
    );
  });
  it("oversize413 and wrongtype415 before signing", async () => {
    const { service, files } = setup();
    await expect(
      service.upload("member", "invoice", {
        fileName: "x.pdf",
        mimeType: "text/plain",
        size: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 415 });
    await expect(
      service.upload("member", "invoice", {
        fileName: "x.pdf",
        mimeType: "application/pdf",
        size: 10485761,
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(files.createUploadUrl).not.toHaveBeenCalled();
  });
  it("uploaded invoice cannot mint another upload", async () => {
    const { service, repo, files } = setup();
    repo.find.mockResolvedValue({ ...row, status: "uploaded" });
    await expect(
      service.upload("member", "invoice", {
        fileName: "x.pdf",
        mimeType: "application/pdf",
        size: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(files.createUploadUrl).not.toHaveBeenCalled();
  });
  it("finalize requires actual object inspection before DB status", async () => {
    const { service, repo, files } = setup();
    repo.find.mockResolvedValue({
      ...row,
      filePath: "stored-owner/invoice.pdf",
      fileSize: 25,
      mimeType: "application/pdf",
    });
    await service.finalize("member", "invoice");
    expect(files.inspectInvoiceFile).toHaveBeenCalledWith(
      "stored-owner/invoice.pdf",
      25,
    );
    expect(repo.finalize).toHaveBeenCalled();
  });
  it("missing/invalid stored path blocks finalization", async () => {
    const { service, repo } = setup();
    repo.find.mockResolvedValue({
      ...row,
      filePath: "other/file",
      fileSize: 25,
    });
    await expect(service.finalize("member", "invoice")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("inspection failure never marks uploaded", async () => {
    const { service, repo, files } = setup();
    repo.find.mockResolvedValue({
      ...row,
      filePath: "stored-owner/invoice.pdf",
      fileSize: 25,
    });
    files.inspectInvoiceFile.mockRejectedValue(Error("invalid PDF"));
    await expect(service.finalize("member", "invoice")).rejects.toThrow();
    expect(repo.finalize).not.toHaveBeenCalled();
  });
  it("download path derived from row instead of arbitrary stored path", async () => {
    const { service, repo, files } = setup();
    repo.find.mockResolvedValue({
      ...row,
      status: "uploaded",
      filePath: "attacker-path",
    });
    await service.download("member", "invoice");
    expect(files.createDownloadUrl).toHaveBeenCalledWith(
      "stored-owner/invoice.pdf",
    );
  });
  it("storage deletion failure leaves durable cleanup, not500", async () => {
    const { service, files, repo } = setup();
    files.deleteFile.mockRejectedValue(Error("storage offline"));
    await expect(
      service.remove("owner", "invoice", "request"),
    ).resolves.toBeUndefined();
    expect(repo.remove).toHaveBeenCalledWith("owner", "invoice", "request");
    expect(repo.finishCleanup).not.toHaveBeenCalled();
  });
  it("even successful deletion retains late-upload cleanup tombstone", async () => {
    const { service, repo } = setup();
    await service.remove("owner", "invoice", "request");
    expect(repo.finishCleanup).not.toHaveBeenCalled();
  });
  it("money uses exact decimal string and rejects float exponents", () => {
    expect(
      createInvoiceSchema.safeParse({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        invoiceNumber: "INV1",
        amount: "12.34",
        currency: "INR",
      }).success,
    ).toBe(true);
    expect(
      createInvoiceSchema.safeParse({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        invoiceNumber: "INV1",
        amount: "1e9",
        currency: "INR",
      }).success,
    ).toBe(false);
  });
});
