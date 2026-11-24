import { z } from "zod";
export const lifecycleInputSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("prepare"), key: z.string().min(12).max(120) })
    .strict(),
  z
    .object({
      action: z.literal("confirm"),
      key: z.string().min(12).max(120),
      proposalId: z.uuid(),
      confirmation: z.string().max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      key: z.string().min(12).max(120),
      proposalId: z.uuid(),
    })
    .strict(),
  z
    .object({ action: z.literal("restore"), key: z.string().min(12).max(120) })
    .strict(),
]);
export type LifecycleInput = z.infer<typeof lifecycleInputSchema>;
export type LifecycleResult = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  state: string;
  hadPayment: boolean;
  hadSentReminder: boolean;
  expiresAt: string;
};
