import { z } from "zod";
export const businessRecordsQuerySchema = z
  .object({
    workspaceId: z.uuid(),
    after: z.uuid().optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .transform(Number)
      .default(25),
    includeDeleted: z.enum(["true", "false"]).default("false"),
  })
  .strict();
