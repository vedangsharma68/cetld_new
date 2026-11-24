import assert from "node:assert/strict";
import { getEnv } from "../../src/env";
import {
  checkStorage,
  createUploadUrl,
  inspectInvoiceFile,
  createDownloadUrl,
  deleteFile,
} from "../../src/server/lib/storage";
const env = getEnv();
if (
  env.APP_ENV === "production" ||
  new URL(env.SUPABASE_URL).hostname !== "tgkpysathmrsngoavsqh.supabase.co"
)
  throw Error("Only isolated app-dev target allowed");
const owner = "00000000-0000-4000-8000-000000000001",
  invoice = crypto.randomUUID(),
  path = owner + "/" + invoice + ".pdf";
let uploaded = false;
try {
  await checkStorage();
  const signed = await createUploadUrl(owner, invoice);
  assert.equal(signed.path, path);
  const bytes = Buffer.from(
    "%PDF-1.4\n% Isolated synthetic storage service proof\n%%EOF\n",
  );
  const result = await fetch(signed.signedUrl, {
    method: "PUT",
    headers: { "content-type": "application/pdf" },
    body: bytes,
  });
  assert.ok(result.ok);
  uploaded = true;
  await inspectInvoiceFile(path, bytes.length);
  await assert.rejects(() => inspectInvoiceFile(path, bytes.length + 1), {
    code: "FILE_SIZE_MISMATCH",
  });
  const download = await createDownloadUrl(path);
  assert.equal(download.expiresIn, 60);
  const response = await fetch(download.url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  if (process.env.CETLD_VERIFY_ELAPSED_EXPIRY === "yes") {
    await new Promise((resolve) => setTimeout(resolve, 75000));
    const expired = await fetch(download.url, { cache: "no-store" });
    assert.ok(expired.status >= 400, "Expired signed download must fail");
    process.stdout.write(
      JSON.stringify({
        elapsedSignedExpiryDenied: true,
        status: expired.status,
      }) + "\n",
    );
  }
  process.stdout.write(
    JSON.stringify({
      isolatedAppDev: true,
      actualStorageWrapper: true,
      exactBytes: true,
      sizeMismatchRejected: true,
    }) + "\n",
  );
} finally {
  if (uploaded) {
    await deleteFile(path);
    process.stdout.write(
      JSON.stringify({ syntheticObjectRemoved: true }) + "\n",
    );
  }
}
