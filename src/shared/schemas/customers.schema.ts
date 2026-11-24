import { z } from "zod";
import { customerCustomFieldsSchema } from "./customer-custom-fields.schema";
export const customerIdSchema = z.uuid();
export const createCustomerSchema = z
  .object({
    workspaceId: z.uuid(),
    customFields: customerCustomFieldsSchema.optional(),
    name: z.string().trim().min(1).max(160),
    companyName: z.string().trim().max(160).nullable().optional(),
    email: z
      .union([z.email().max(254), z.literal("")])
      .nullable()
      .optional(),
    phone: z.string().trim().max(40).nullable().optional(),
  })
  .strict();
export const updateCustomerSchema = createCustomerSchema
  .omit({ workspaceId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export const customerFiltersSchema = z.object({
  workspaceId: z.uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).default(""),
  sort: z.enum(["name", "createdAt"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerFilters = z.infer<typeof customerFiltersSchema>;
export type Customer = {
  id: string;
  workspaceId: string;
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
  customFields?: Record<string, string | number | boolean | null>;
};
