import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { BadRequestError } from "@/server/lib/errors";
import { ok } from "@/server/lib/response";
import { businessRecordsQuerySchema } from "@/shared/schemas/business-records.schema";
import { businessRecordsService } from "./business-records.service";
export const businessRecordsController = {
  async list(request: Request) {
    const user = await getSessionUser(),
      query = businessRecordsQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
    if (!query.success)
      throw new BadRequestError("Invalid business records query");
    return ok(
      await businessRecordsService.list(
        user.id,
        query.data.workspaceId,
        query.data.includeDeleted === "true",
        query.data.after,
        query.data.limit,
      ),
    );
  },
};
