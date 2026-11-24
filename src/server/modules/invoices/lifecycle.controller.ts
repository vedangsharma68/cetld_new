import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { readJson } from "@/server/lib/validation";
import { ok } from "@/server/lib/response";
import type { RouteContext } from "@/server/lib/handler";
import { invoiceIdSchema } from "@/shared/schemas/invoices.schema";
import { lifecycleInputSchema } from "@/shared/schemas/invoice-lifecycle.schema";
import { lifecycleService } from "./lifecycle.service";
export const lifecycleController = {
  async state(request: Request) {
    const user = await getSessionUser();
    const workspaceId = invoiceIdSchema.parse(
      new URL(request.url).searchParams.get("workspaceId"),
    );
    return ok(await lifecycleService.state(user.id, workspaceId));
  },
  async act(request: Request, context: RouteContext) {
    const user = await getSessionUser();
    const id = invoiceIdSchema.parse((await context.params).id);
    const input = lifecycleInputSchema.parse(await readJson(request));
    return ok(await lifecycleService.act(user.id, id, input));
  },
};
