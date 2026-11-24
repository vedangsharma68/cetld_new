import "server-only";
import { z } from "zod";
import { getSessionUser } from "@/server/lib/auth";
import { BadRequestError } from "@/server/lib/errors";
import { ok } from "@/server/lib/response";
import type { RouteContext } from "@/server/lib/handler";
import { invoiceCorrectionHistoryQuerySchema } from "@/shared/schemas/invoice-correction-history.schema";
import { invoiceCorrectionAuditsService } from "./invoice-correction-audits.service";
export const invoiceCorrectionAuditsController = {
  async list(request: Request, context: RouteContext) {
    const user = await getSessionUser(),
      query = invoiceCorrectionHistoryQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      id = z.uuid().safeParse((await context.params).id);
    if (!query.success || !id.success)
      throw new BadRequestError("Invalid invoice history query");
    return ok(
      await invoiceCorrectionAuditsService.list(
        user.id,
        query.data.workspaceId,
        id.data,
        query.data.after,
        query.data.limit,
      ),
    );
  },
};
