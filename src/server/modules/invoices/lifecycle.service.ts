import "server-only";
import type { LifecycleInput } from "@/shared/schemas/invoice-lifecycle.schema";
import { NotFoundError } from "@/server/lib/errors";
import { lifecycleRepository } from "./lifecycle.repository";
export function createLifecycleService(repository = lifecycleRepository) {
  return {
    async act(userId: string, id: string, input: LifecycleInput) {
      const result = await repository.act(userId, id, input);
      if (!result) throw new NotFoundError("Invoice lifecycle");
      return {
        id: result.id,
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        state: result.state,
        hadPayment: result.hadPayment,
        hadSentReminder: result.hadSentReminder,
        expiresAt: result.expiresAt,
      };
    },
    async state(userId: string, workspaceId: string) {
      return {
        deleted: await repository.deleted(userId, workspaceId),
        pending: await repository.pending(userId, workspaceId),
      };
    },
  };
}
export const lifecycleService = createLifecycleService();
