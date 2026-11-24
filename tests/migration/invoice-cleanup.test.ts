import { describe, it, vi, expect, beforeEach } from "vitest";
const { repo, files, log } = vi.hoisted(() => ({
  repo: { dueCleanup: vi.fn(), finishCleanup: vi.fn() },
  files: { deleteFile: vi.fn() },
  log: { warn: vi.fn() },
}));
vi.mock("@/server/modules/invoices/invoices.repository", () => ({
  invoiceRepository: repo,
}));
vi.mock("@/server/lib/storage", () => files);
vi.mock("@/server/lib/logger", () => ({ logger: log }));
import { sweepInvoiceFiles } from "@/server/modules/invoices/storage-cleanup.service";
beforeEach(() => vi.resetAllMocks());
describe("deferred cleanup", () => {
  it("processes only repository-selected due jobs and completes after storage", async () => {
    repo.dueCleanup.mockResolvedValue([
      { id: "j", path: "owner/id.pdf", requestId: "r" },
    ]);
    await sweepInvoiceFiles();
    expect(files.deleteFile).toHaveBeenCalledWith("owner/id.pdf");
    expect(repo.finishCleanup).toHaveBeenCalledWith("j");
  });
  it("failure retains durable job and records originating request", async () => {
    repo.dueCleanup.mockResolvedValue([
      { id: "j", path: "owner/id.pdf", requestId: "r" },
    ]);
    files.deleteFile.mockRejectedValue(Error("offline"));
    await expect(sweepInvoiceFiles()).resolves.toBeUndefined();
    expect(repo.finishCleanup).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      { requestId: "r", code: "STORAGE_CLEANUP_PENDING" },
      expect.any(String),
    );
  });
});
