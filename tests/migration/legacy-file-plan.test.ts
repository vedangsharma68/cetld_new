import { it, expect } from "vitest";
import { planLegacyFiles } from "../../scripts/migration/plan-legacy-files";
const business = "11111111-1111-4111-8111-111111111111",
  invoice = "22222222-2222-4222-8222-222222222222",
  owner = "33333333-3333-4333-8333-333333333333",
  id = "44444444-4444-4444-8444-444444444444";
const scope = () =>
  new Map([[invoice, { workspaceId: business, ownerId: owner }]]);
const row = () => ({
  id,
  workspace_id: business,
  invoice_id: invoice,
  storage_path: "original-business/original-invoice.pdf",
  file_name: "original filename.pdf",
  mime_type: "application/pdf",
  size_bytes: "1234",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});
it("plans server-owned target path without dropping original metadata or claiming bytes verified", () => {
  const source = row();
  const p = planLegacyFiles({ invoice_files: [source] }, scope())[0]!;
  expect(p).toEqual({
    original: source,
    sourcePath: source.storage_path,
    destinationPath: owner + "/" + invoice + ".pdf",
    sizeBytes: 1234n,
    originalFileName: source.file_name,
    requiresByteVerification: true,
  });
});
it("blocks duplicate IDs, multiple files and cross-business originals", () => {
  expect(() =>
    planLegacyFiles({ invoice_files: [row(), row()] }, scope()),
  ).toThrow(/Duplicate/);
  expect(() =>
    planLegacyFiles(
      {
        invoice_files: [
          row(),
          { ...row(), id: "55555555-5555-4555-8555-555555555555" },
        ],
      },
      scope(),
    ),
  ).toThrow(/Multiple/);
  expect(() => planLegacyFiles({ invoice_files: [row()] }, new Map())).toThrow(
    /orphan/,
  );
  expect(() =>
    planLegacyFiles(
      { invoice_files: [{ ...row(), workspace_id: owner }] },
      scope(),
    ),
  ).toThrow(/orphan/);
});
it.each([
  "../file.pdf",
  "/file.pdf",
  "a//file.pdf",
  "a/./file.pdf",
  "a\\file.pdf",
  "a/%2e%2e/file.pdf",
  "https://untrusted.invalid/a.pdf",
  "a/file.pdf?x=y",
])("rejects unsafe object path %s", (storage_path) => {
  expect(() =>
    planLegacyFiles({ invoice_files: [{ ...row(), storage_path }] }, scope()),
  ).toThrow(/Unsafe/);
});
it.each([
  { mime_type: "image/png" },
  { size_bytes: null },
  { size_bytes: "0" },
  { size_bytes: "10485761" },
  { size_bytes: 1234 },
])("blocks unsupported original instead of dropping it %j", (changes) => {
  expect(() =>
    planLegacyFiles({ invoice_files: [{ ...row(), ...changes }] }, scope()),
  ).toThrow();
});
it("rejects unknown source columns", () => {
  expect(() =>
    planLegacyFiles(
      { invoice_files: [{ ...row(), valuable_extra: "keep me" }] },
      scope(),
    ),
  ).toThrow();
});
