import { z } from "zod";
import { exactMoneySchema } from "./exact-money";
export const recordPaymentSchema = z
  .object({
    amount: exactMoneySchema.optional(),
    settleRemaining: z.boolean(),
    reference: z.string().trim().max(500).nullable().default(null),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (v) =>
      v.settleRemaining ? v.amount === undefined : v.amount !== undefined,
    "Choose an amount or settle remaining",
  );
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
