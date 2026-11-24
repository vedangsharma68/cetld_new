import { z } from "zod";
const instant = z.string().datetime({ offset: true }),
  fields = z.record(z.string(), z.unknown());
const modelLists = {
  primary: [
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/openai/gpt-oss-20b",
    "@cf/qwen/qwen3-30b-a3b-fp8",
    "@cf/zai-org/glm-4.7-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "space-bunny-free",
  ],
  fallback: [
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/openai/gpt-oss-20b",
    "@cf/qwen/qwen3-30b-a3b-fp8",
    "@cf/zai-org/glm-4.7-flash",
    "space-bunny-free",
    "longcat-2.5-preview-free",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gpt-oss:20b-cloud",
  ],
};
const model = (kind: keyof typeof modelLists) =>
  z
    .string()
    .refine(
      (v) =>
        modelLists[kind].includes(v) ||
        (v.length <= 100 && /^[a-z0-9][a-z0-9.-]*-free$/.test(v)),
    );
const settings = z
  .object({
    workspace_id: z.uuid(),
    business_name: z
      .string()
      .refine((v) => v.trim().length >= 1 && v.trim().length <= 200)
      .nullable(),
    default_currency: z.string().regex(/^[A-Z]{3}$/),
    default_timezone: z.string(),
    follow_up_preferences: fields,
    created_at: instant,
    updated_at: instant,
    whatsapp_owner_attested_at: instant.nullable(),
    whatsapp_owner_attested_by: z.uuid().nullable(),
    whatsapp_owner_phone: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullable(),
    owner_bot_preferences: fields,
    offline_invoice_provenance: z.boolean(),
  })
  .strict();
const ai = z
  .object({
    workspace_id: z.uuid(),
    primary_model: model("primary"),
    fallback_model: model("fallback").nullable(),
    created_at: instant,
    updated_at: instant,
    offline_invoice_provenance: z.boolean(),
  })
  .strict();
export function planLegacySettings(
  snapshot: unknown,
  businesses: Set<string>,
  users: Set<string>,
) {
  const s = z
    .object({
      workspace_settings: z.array(settings),
      workspace_ai_settings: z.array(ai),
    })
    .parse(snapshot);
  const seen = new Set<string>(),
    seenAi = new Set<string>();
  const workspaceSettings = s.workspace_settings.map((r) => {
    if (
      !businesses.has(r.workspace_id) ||
      seen.has(r.workspace_id) ||
      (r.whatsapp_owner_attested_by !== null &&
        !users.has(r.whatsapp_owner_attested_by))
    )
      throw Error("Duplicate or orphan settings");
    seen.add(r.workspace_id);
    return {
      workspaceId: r.workspace_id,
      businessName: r.business_name,
      defaultCurrency: r.default_currency,
      defaultTimezone: r.default_timezone,
      followUpPreferences: r.follow_up_preferences,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      whatsappOwnerAttestedAt: r.whatsapp_owner_attested_at
        ? new Date(r.whatsapp_owner_attested_at)
        : null,
      whatsappOwnerAttestedBy: r.whatsapp_owner_attested_by,
      whatsappOwnerPhone: r.whatsapp_owner_phone,
      ownerBotPreferences: r.owner_bot_preferences,
      offlineInvoiceProvenance: r.offline_invoice_provenance,
    };
  });
  const workspaceAiSettings = s.workspace_ai_settings.map((r) => {
    if (
      !businesses.has(r.workspace_id) ||
      seenAi.has(r.workspace_id) ||
      r.primary_model === r.fallback_model
    )
      throw Error("Duplicate or orphan AI settings");
    seenAi.add(r.workspace_id);
    return {
      workspaceId: r.workspace_id,
      primaryModel: r.primary_model,
      fallbackModel: r.fallback_model,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      offlineInvoiceProvenance: r.offline_invoice_provenance,
    };
  });
  return { workspaceSettings, workspaceAiSettings };
}
