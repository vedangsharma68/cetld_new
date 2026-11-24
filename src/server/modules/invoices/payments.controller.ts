import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { ok } from "@/server/lib/response";
import { BadRequestError } from "@/server/lib/errors";
import { readJson } from "@/server/lib/validation";
import type { RouteContext } from "@/server/lib/handler";
import { invoiceIdSchema } from "@/shared/schemas/invoices.schema";
import { recordPaymentSchema } from "@/shared/schemas/payments.schema";
import { paymentService } from "./payments.service";
export const paymentController = {
  async record(request: Request, context: RouteContext) {
    const user = await getSessionUser();
    const id = invoiceIdSchema.safeParse((await context.params).id);
    if (!id.success) throw new BadRequestError("Invalid invoice id");
    return ok(
      await paymentService.record(
        user.id,
        id.data,
        recordPaymentSchema.parse(await readJson(request)),
      ),
    );
  },
};
