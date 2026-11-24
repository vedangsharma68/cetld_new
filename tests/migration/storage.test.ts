import { describe, expect, it, vi } from "vitest";
const { storage } = vi.hoisted(() => ({
  storage: {
    list: vi.fn(),
    info: vi.fn(),
    createSignedUploadUrl: vi.fn(),
    createSignedUrl: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("@/server/lib/supabase-admin", () => ({
  supabaseAdmin: { storage: { from: () => storage } },
}));
import {
  checkStorage,
  createUploadUrl,
  createDownloadUrl,
  deleteFile,
  inspectInvoiceFile,
} from "@/server/lib/storage";
describe("storage wrapper", () => {
  it("creates server-derived path", async () => {
    storage.createSignedUploadUrl.mockResolvedValue({
      data: { signedUrl: "https://example.test/signed", token: "ephemeral" },
      error: null,
    });
    expect(await createUploadUrl("owner", "invoice")).toMatchObject({
      path: "owner/invoice.pdf",
    });
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(
      "owner/invoice.pdf",
      { upsert: false },
    );
  });
  it("download has60second expiry", async () => {
    storage.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://example.test/signed" },
      error: null,
    });
    expect(await createDownloadUrl("owner/invoice.pdf")).toEqual({
      url: "https://example.test/signed",
      expiresIn: 60,
    });
  });
  it("delete errors are typed", async () => {
    storage.remove.mockResolvedValue({
      error: { message: "private raw backend" },
    });
    await expect(deleteFile("owner/invoice.pdf")).rejects.toMatchObject({
      statusCode: 502,
      code: "STORAGE_UNAVAILABLE",
    });
  });
  it("health failure is typed", async () => {
    storage.list.mockResolvedValue({
      error: { message: "private raw backend" },
    });
    await expect(checkStorage()).rejects.toMatchObject({ statusCode: 502 });
  });
});

it("finalization checks real storage size/type and PDF magic", async () => {
  storage.info.mockResolvedValue({
    data: { size: 25, contentType: "application/pdf" },
    error: null,
  });
  storage.createSignedUrl.mockResolvedValue({
    data: { signedUrl: "https://fixture.invalid" },
    error: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("%PDF-synthetic")),
  );
  await expect(
    inspectInvoiceFile("owner/invoice.pdf", 25),
  ).resolves.toBeUndefined();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("NOPE!")));
  await expect(
    inspectInvoiceFile("owner/invoice.pdf", 25),
  ).rejects.toMatchObject({ statusCode: 415 });
  vi.unstubAllGlobals();
});
it("finalization rejects actual size mismatch before reading content", async () => {
  storage.info.mockResolvedValue({
    data: { size: 26, contentType: "application/pdf" },
    error: null,
  });
  await expect(
    inspectInvoiceFile("owner/invoice.pdf", 25),
  ).rejects.toMatchObject({ statusCode: 409 });
});
