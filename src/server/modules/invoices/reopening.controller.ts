import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { readJson } from "@/server/lib/validation";
import { ok } from "@/server/lib/response";
import type { RouteContext } from "@/server/lib/handler";
import { invoiceIdSchema } from "@/shared/schemas/invoices.schema";
import { reopeningInputSchema } from "@/shared/schemas/invoice-reopening.schema";
import { reopeningService } from "./reopening.service";
export const reopeningController = {
  async act(request: Request, context: RouteContext) {
    const user = await getSessionUser();
    return ok(
      await reopeningService.act(
        user.id,
        invoiceIdSchema.parse((await context.params).id),
        reopeningInputSchema.parse(await readJson(request)),
      ),
    );
  },
};
