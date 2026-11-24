import "server-only";
import { getEnv } from "@/env";
import { supabaseAdmin } from "./supabase-admin";
import {
  StorageError,
  UnsupportedMediaError,
  PayloadTooLargeError,
  ConflictError,
} from "./errors";
const bucket = () =>
  supabaseAdmin.storage.from(getEnv().SUPABASE_INVOICE_BUCKET);
export async function checkStorage(): Promise<void> {
  const { error } = await bucket().list("", { limit: 1 });
  if (error) throw new StorageError();
}
export async function createUploadUrl(ownerId: string, invoiceId: string) {
  const path = `${ownerId}/${invoiceId}.pdf`;
  const { data, error } = await bucket().createSignedUploadUrl(path, {
    upsert: false,
  });
  if (error || !data) throw new StorageError();
  return { signedUrl: data.signedUrl, token: data.token, path };
}
export async function createDownloadUrl(path: string) {
  const { data, error } = await bucket().createSignedUrl(path, 60);
  if (error || !data) throw new StorageError();
  return { url: data.signedUrl, expiresIn: 60 };
}
export async function deleteFile(path: string): Promise<void> {
  const { error } = await bucket().remove([path]);
  if (error) throw new StorageError();
}

export async function inspectInvoiceFile(path: string, expectedSize: number) {
  const { data, error } = await bucket().info(path);
  if (error || !data) throw new StorageError();
  const metadata = data as unknown as {
    size?: number;
    contentType?: string;
    metadata?: { size?: number; mimetype?: string };
  };
  const size = metadata.size ?? metadata.metadata?.size;
  const type = metadata.contentType ?? metadata.metadata?.mimetype;
  if (typeof size !== "number" || size <= 0 || size > 10485760)
    throw new PayloadTooLargeError(10);
  if (size !== expectedSize)
    throw new ConflictError(
      "FILE_SIZE_MISMATCH",
      "Uploaded file size does not match",
    );
  if (type !== "application/pdf") throw new UnsupportedMediaError();
  const signed = await createDownloadUrl(path);
  let response: Response;
  try {
    response = await fetch(signed.url, {
      headers: { Range: "bytes=0-4" },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new StorageError();
  }
  if (!response.ok || !response.body) throw new StorageError();
  const reader = response.body.getReader();
  const prefix: number[] = [];
  try {
    while (prefix.length < 5) {
      const part = await reader.read();
      if (part.done) break;
      prefix.push(...part.value.slice(0, 5 - prefix.length));
    }
  } finally {
    await reader.cancel();
  }
  if (String.fromCharCode(...prefix) !== "%PDF-")
    throw new UnsupportedMediaError();
}
