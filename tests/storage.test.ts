import assert from "node:assert/strict";
import test from "node:test";
import {
  createInvoiceFileSignedUrl,
  deleteInvoiceFile,
  INVOICE_FILES_BUCKET,
  uploadInvoiceFile,
} from "../src/storage.js";
import { getBusinessSettings, getProfile, updateBusinessSettings, updateProfile } from "../src/settings.js";

function fakeClient() {
  const calls: any[] = [];
  const client: any = {
    calls,
    from(table: string) {
      return {
        select: (columns: string) => {
          calls.push(["select", table, columns]);
          return {
            eq: (_field: string, _value: string) => ({
              maybeSingle: async () => ({ data: { user_id: _value, workspace_id: _value }, error: null }),
            }),
          };
        },
        upsert: (row: unknown, options: unknown) => {
          calls.push(["upsert", table, row, options]);
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, _body: unknown, options: unknown) => {
            calls.push(["upload", bucket, path, options]);
            return { data: { path }, error: null };
          },
          createSignedUrl: async (path: string, expiry: number) => {
            calls.push(["signed", bucket, path, expiry]);
            return { data: { signedUrl: "https://signed.example/file" }, error: null };
          },
          remove: async (paths: string[]) => {
            calls.push(["remove", bucket, paths]);
            return { data: paths, error: null };
          },
        };
      },
    },
  };
  return client;
}

test("uploads an allowed invoice file with tenant path and no upsert", async () => {
  const client = fakeClient();
  const result = await uploadInvoiceFile(client, {
    workspaceId: "workspace-1",
    invoiceId: "invoice-1",
    body: new Uint8Array([1, 2, 3]),
    contentType: "application/pdf",
    originalName: "invoice.pdf",
  });
  assert.match(result.path, /^workspace-1\/invoice-1\/[0-9a-f-]+\.pdf$/);
  assert.equal(client.calls[0][1], INVOICE_FILES_BUCKET);
  assert.equal(client.calls[0][3].upsert, false);
  assert.equal(client.calls[0][3].metadata.originalName, "invoice.pdf");
});

test("rejects unsupported, oversized, empty, and unsafe file inputs before upload", async () => {
  const client = fakeClient();
  await assert.rejects(() => uploadInvoiceFile(client, {
    workspaceId: "w", invoiceId: "i", body: new Uint8Array([1]), contentType: "text/plain",
  }), /Unsupported/);
  await assert.rejects(() => uploadInvoiceFile(client, {
    workspaceId: "w", invoiceId: "i", body: new Uint8Array(10 * 1024 * 1024 + 1), contentType: "image/png",
  }), /10 MB/);
  await assert.rejects(() => uploadInvoiceFile(client, {
    workspaceId: "w", invoiceId: "i", body: new Uint8Array(), contentType: "image/png",
  }), /empty/);
  await assert.rejects(() => uploadInvoiceFile(client, {
    workspaceId: "w/other", invoiceId: "i", body: new Uint8Array([1]), contentType: "image/png",
  }), /path segment/);
  assert.equal(client.calls.length, 0);
});

test("signed downloads and deletes use the private invoice bucket", async () => {
  const client = fakeClient();
  assert.equal(await createInvoiceFileSignedUrl(client, "w/i/file.pdf"), "https://signed.example/file");
  await deleteInvoiceFile(client, "w/i/file.pdf");
  assert.deepEqual(client.calls[0], ["signed", INVOICE_FILES_BUCKET, "w/i/file.pdf", 300]);
  assert.deepEqual(client.calls[1], ["remove", INVOICE_FILES_BUCKET, ["w/i/file.pdf"]]);
});

test("settings helpers persist profile and workspace settings through RLS client", async () => {
  const client = fakeClient();
  const profile = await updateProfile(client, "user-1", { full_name: "Vedang" });
  const settings = await updateBusinessSettings(client, "workspace-1", { business_name: "cetld" });
  assert.equal(profile.user_id, "user-1");
  assert.equal(settings.workspace_id, "workspace-1");
  assert.equal((await getProfile(client, "user-1"))?.user_id, "user-1");
  assert.equal((await getBusinessSettings(client, "workspace-1"))?.workspace_id, "workspace-1");
});
