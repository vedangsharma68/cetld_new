import { z } from "zod";
export const reopeningInputSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("prepare"), key: z.string().min(12).max(120) })
    .strict(),
  z
    .object({
      action: z.literal("confirm"),
      key: z.string().min(12).max(120),
      proposalId: z.uuid(),
      confirmation: z.literal("yes"),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      key: z.string().min(12).max(120),
      proposalId: z.uuid(),
    })
    .strict(),
]);
export type ReopeningInput = z.infer<typeof reopeningInputSchema>;
