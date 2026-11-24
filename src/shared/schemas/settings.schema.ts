import { z } from "zod";
export const businessSettingsQuerySchema = z
  .object({ workspaceId: z.uuid() })
  .strict();
export const businessSettingsViewSchema = z.object({
  workspaceId: z.uuid(),
  canEdit: z.boolean(),
  settings: z
    .object({
      businessName: z.string().nullable(),
      defaultCurrency: z.string(),
      defaultTimezone: z.string(),
    })
    .nullable(),
  aiSettings: z
    .object({ primaryModel: z.string(), fallbackModel: z.string().nullable() })
    .nullable(),
});
export type BusinessSettingsView = z.infer<typeof businessSettingsViewSchema>;
