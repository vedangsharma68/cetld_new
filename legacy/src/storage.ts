/** Private invoice-file storage helpers using an injected, authenticated client. */

import { randomUUID } from "node:crypto";
import type { SupabaseLike } from "./settings.js";

export const INVOICE_FILES_BUCKET = "invoice-files";
export const MAX_INVOICE_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_INVOICE_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedInvoiceMimeType = (typeof ALLOWED_INVOICE_MIME_TYPES)[number];
export type InvoiceFileBody = Blob | ArrayBuffer | Uint8Array;

export type UploadInvoiceFileInput = {
  workspaceId: string;
  invoiceId: string;
  body: InvoiceFileBody;
  contentType: AllowedInvoiceMimeType | string;
  originalName?: string;
};

export type UploadedInvoiceFile = {
  path: string;
  bucket: string;
  originalName?: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function validateSegment(value: string, name: string): void {
  if (!value || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    fail(`${name} must be a non-empty path segment`);
  }
}

function byteLength(body: InvoiceFileBody): number {
  if ("size" in body) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return body.byteLength;
}

function extensionFor(contentType: string): string {
  return ({
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  } as Record<string, string>)[contentType] ?? fail("Unsupported invoice file MIME type");
}

function throwIfError(response: { error?: unknown }): void {
  if (response?.error) throw response.error;
}

function filePath(input: UploadInvoiceFileInput): string {
  validateSegment(input.workspaceId, "workspaceId");
  validateSegment(input.invoiceId, "invoiceId");
  const extension = extensionFor(input.contentType);
  return `${input.workspaceId}/${input.invoiceId}/${randomUUID()}.${extension}`;
}

export async function uploadInvoiceFile(
  client: SupabaseLike,
  input: UploadInvoiceFileInput,
): Promise<UploadedInvoiceFile> {
  if (!ALLOWED_INVOICE_MIME_TYPES.includes(input.contentType as AllowedInvoiceMimeType)) {
    fail("Unsupported invoice file MIME type");
  }
  const size = byteLength(input.body);
  if (size > MAX_INVOICE_FILE_BYTES) fail("Invoice file exceeds the 10 MB limit");
  if (size < 1) fail("Invoice file cannot be empty");
  const path = filePath(input);
  const metadata = input.originalName ? { originalName: input.originalName } : undefined;
  const response = await client.storage.from(INVOICE_FILES_BUCKET).upload(path, input.body, {
    contentType: input.contentType,
    upsert: false,
    ...(metadata ? { metadata } : {}),
  });
  throwIfError(response);
  return { path, bucket: INVOICE_FILES_BUCKET, ...(input.originalName ? { originalName: input.originalName } : {}) };
}

export async function createInvoiceFileSignedUrl(
  client: SupabaseLike,
  path: string,
  expiresInSeconds = 300,
): Promise<string> {
  if (!path || path.startsWith("/") || path.includes("..")) fail("Invalid invoice file path");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 86_400) {
    fail("Signed URL expiry must be between 1 and 86400 seconds");
  }
  const response = await client.storage.from(INVOICE_FILES_BUCKET).createSignedUrl(path, expiresInSeconds);
  throwIfError(response);
  if (!response.data?.signedUrl) fail("Storage did not return a signed URL");
  return response.data.signedUrl;
}

export async function deleteInvoiceFile(client: SupabaseLike, path: string): Promise<void> {
  if (!path || path.startsWith("/") || path.includes("..")) fail("Invalid invoice file path");
  const response = await client.storage.from(INVOICE_FILES_BUCKET).remove([path]);
  throwIfError(response);
}
