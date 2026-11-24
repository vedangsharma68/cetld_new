import { z } from "zod";
const reserved =
  /^(id|.*_id|name|company_name|email|phone|invoice_number|issue_date|due_date|status|amount_paid|total_amount|subtotal|tax|currency|notes|invoice_direction|business_name|default_currency|default_timezone|follow_up_preferences|owner_bot_preferences|primary_model|fallback_model|followup_state|next_follow_up_at|metadata|custom_fields|created_at|updated_at|deleted_at|deleted_by|role|permissions|whatsapp_owner|workspace|tenant|owner|user)$/i;
const sensitive =
  /(token|secret|password|api.?key|credential|authorization|cookie|storage.?path|code.?hash|private.?key)/i;
// jsonb text includes spaces after separators and expands numeric exponents.
// Match its byte budget instead of JSON.stringify's compact representation.
function numericText(value: number): string {
  const source = String(value);
  if (!/[eE]/.test(source)) return source;
  const [mantissa, exponent] = source.split(/[eE]/),
    negative = mantissa!.startsWith("-"),
    digits = mantissa!.replace("-", "").replace(".", ""),
    point = mantissa!.replace("-", "").split(".")[0]!.length + Number(exponent);
  const expanded =
    point <= 0
      ? "0." + "0".repeat(-point) + digits
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : digits.slice(0, point) + "." + digits.slice(point);
  return (negative ? "-" : "") + expanded;
}
export function businessFieldsJsonbBytes(
  value: Record<string, string | number | boolean | null>,
): number {
  const pairs = Object.entries(value).map(
    ([k, v]) =>
      JSON.stringify(k) +
      ": " +
      (typeof v === "number" ? numericText(v) : JSON.stringify(v)),
  );
  return new TextEncoder().encode("{" + pairs.join(", ") + "}").length;
}
export const businessCustomFieldsSchema = z
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
        .refine((v) => Array.from(v).length <= 1000, "Maximum1000characters")
        .refine(
          (v) => !/[\x00-\x1f\x7f-\x9f]/.test(v),
          "Control characters are not allowed",
        ),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine((v) => Object.keys(v).length <= 50, "Maximum50fields")
  .refine(
    (v) => businessFieldsJsonbBytes(v) <= 8192,
    "Custom fields exceed8192bytes",
  );
