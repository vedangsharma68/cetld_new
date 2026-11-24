import "server-only";
import { invoiceRepository } from "./invoices.repository";
import { deleteFile } from "@/server/lib/storage";
import { logger } from "@/server/lib/logger";
// Signed uploads last2hours. Keep tombstones permanently and recheck every3hours,
// so an arbitrarily late in-flight upload still has a durable cleanup record.
export async function sweepInvoiceFiles() {
  const jobs = await invoiceRepository.dueCleanup();
  for (const job of jobs) {
    try {
      await deleteFile(job.path);
      await invoiceRepository.finishCleanup(job.id);
    } catch {
      logger.warn(
        { requestId: job.requestId, code: "STORAGE_CLEANUP_PENDING" },
        "Deferred invoice file cleanup will retry",
      );
    }
  }
}
