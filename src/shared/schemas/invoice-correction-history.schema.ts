import { z } from "zod";
export const invoiceCorrectionHistoryQuerySchema = z
  .object({
    workspaceId: z.uuid(),
    after: z
      .string()
      .max(80)
      .refine((v) => {
        const [at, id, ...extra] = v.split("|");
        return (
          extra.length === 0 &&
          z.string().datetime({ offset: true }).safeParse(at).success &&
          z.uuid().safeParse(id).success
        );
      }, "Invalid history cursor")
      .optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .transform(Number)
      .default(25),
  })
  .strict();
