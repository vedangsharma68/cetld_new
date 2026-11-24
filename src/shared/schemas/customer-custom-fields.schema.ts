import { z } from "zod";
const reserved =
  /^(id|.*_id|name|company_name|email|phone|invoice_number|issue_date|due_date|status|amount_paid|total_amount|subtotal|tax|currency|notes|invoice_direction|business_name|default_currency|default_timezone|follow_up_preferences|owner_bot_preferences|primary_model|fallback_model|followup_state|next_follow_up_at|metadata|custom_fields|created_at|updated_at|deleted_at|deleted_by|role|permissions|whatsapp_owner|workspace|tenant|owner|user)$/i;
const sensitive =
  /(token|secret|password|api.?key|credential|authorization|cookie|storage.?path|code.?hash|private.?key)/i;
export const customerCustomFieldsSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .refine(
        (k) => !reserved.test(k) && !sensitive.test(k),
        "Reserved field name",
      ),
    z.union([
      z
        .string()
        .max(1000)
        .refine(
          (v) => !/[\x00-\x1f\x7f]/.test(v),
          "Control characters are not allowed",
        ),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine((v) => Object.keys(v).length <= 50, "Maximum50fields")
  .refine(
    (v) => new TextEncoder().encode(JSON.stringify(v)).length <= 8192,
    "Custom fields exceed8192bytes",
  );
