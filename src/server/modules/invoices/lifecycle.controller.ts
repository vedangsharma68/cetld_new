import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { readJson } from "@/server/lib/validation";
import { ok } from "@/server/lib/response";
import { NotFoundError } from "@/server/lib/errors";
import type { RouteContext } from "@/server/lib/handler";
import { invoiceIdSchema } from "@/shared/schemas/invoices.schema";
import { lifecycleInputSchema } from "@/shared/schemas/invoice-lifecycle.schema";
import { lifecycleRepository } from "./lifecycle.repository";
export const lifecycleController = {
  async state(request: Request) {
    const user = await getSessionUser();
    const workspaceId = invoiceIdSchema.parse(
      new URL(request.url).searchParams.get("workspaceId"),
    );
    return ok({
      deleted: await lifecycleRepository.deleted(user.id, workspaceId),
      pending: await lifecycleRepository.pending(user.id, workspaceId),
    });
  },
  async act(request: Request, context: RouteContext) {
    const user = await getSessionUser();
    const id = invoiceIdSchema.parse((await context.params).id);
    const input = lifecycleInputSchema.parse(await readJson(request));
    const result = await lifecycleRepository.act(user.id, id, input);
    if (!result) throw new NotFoundError("Invoice lifecycle");
    return ok({
      id: result.id,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      state: result.state,
      hadPayment: result.hadPayment,
      hadSentReminder: result.hadSentReminder,
      expiresAt: result.expiresAt,
    });
  },
};
