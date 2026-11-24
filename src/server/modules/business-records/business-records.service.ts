import "server-only";
import { NotFoundError } from "@/server/lib/errors";
import { businessRecordsRepository } from "./business-records.repository";
export function createBusinessRecordsService(
  repository = businessRecordsRepository,
) {
  return {
    async list(
      userId: string,
      workspaceId: string,
      includeDeleted = false,
      after?: string,
      limit = 25,
    ) {
      const records = await repository.listOwned(
        userId,
        workspaceId,
        includeDeleted,
        after,
        limit,
      );
      if (!records) throw new NotFoundError("Business records");
      const page = records.slice(0, limit);
      return {
        records: page,
        nextCursor: records.length > limit ? page.at(-1)!.id : null,
      };
    },
  };
}
export const businessRecordsService = createBusinessRecordsService();
