import { z } from "zod";
const instant = z.string().datetime({ offset: true });
const file = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    invoice_id: z.uuid(),
    storage_path: z.string().min(1),
    file_name: z.string().min(1),
    mime_type: z.string().nullable(),
    size_bytes: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
    created_at: instant,
    updated_at: instant,
  })
  .strict();
// No storage writes or file downloads. Actual bytes, PDF signature and object
// inventory must be verified by a separately reviewed copying operator.
export function planLegacyFiles(
  snapshot: unknown,
  invoices: Map<string, { workspaceId: string; ownerId: string }>,
) {
  const source = z.object({ invoice_files: z.array(file) }).parse(snapshot);
  const ids = new Set<string>(),
    invoiceIds = new Set<string>(),
    paths = new Set<string>();
  return source.invoice_files.map((f) => {
    const invoice = invoices.get(f.invoice_id);
    if (!invoice || invoice.workspaceId !== f.workspace_id || ids.has(f.id))
      throw Error("Duplicate or orphan invoice file");
    ids.add(f.id);
    // Candidate supports one PDF per invoice. Never choose a primary file or
    // silently drop extra originals to fit that model.
    if (invoiceIds.has(f.invoice_id))
      throw Error(
        "Multiple original files need explicit preservation before import",
      );
    invoiceIds.add(f.invoice_id);
    if (paths.has(f.storage_path))
      throw Error(
        "Shared original object needs explicit preservation before import",
      );
    paths.add(f.storage_path);
    if (
      f.storage_path.startsWith("/") ||
      f.storage_path.includes("\\") ||
      f.storage_path.split("/").some((p) => ["", ".", ".."].includes(p)) ||
      /[\u0000-\u001f\u007f:%?#]/.test(f.storage_path)
    )
      throw Error("Unsafe or ambiguous original storage path");
    if (
      f.mime_type !== "application/pdf" ||
      f.size_bytes === null ||
      BigInt(f.size_bytes) <= 0n ||
      BigInt(f.size_bytes) > 10485760n
    )
      throw Error(
        "Original file needs explicit type/size preservation before import",
      );
    return {
      original: { ...f },
      sourcePath: f.storage_path,
      destinationPath: invoice.ownerId + "/" + f.invoice_id + ".pdf",
      sizeBytes: BigInt(f.size_bytes),
      requiresByteVerification: true as const,
    };
  });
}
