import { it, expect } from "vitest";
import { planLegacySettings } from "../../scripts/migration/plan-legacy-settings";
const business = "11111111-1111-4111-8111-111111111111",
  user = "22222222-2222-4222-8222-222222222222",
  at = "2026-11-24T00:00:00Z";
const fixture = () => ({
  workspace_settings: [
    {
      workspace_id: business,
      business_name: "Exact original",
      default_currency: "INR",
      default_timezone: "Asia/Kolkata",
      follow_up_preferences: { private: { queue: "off" } },
      created_at: at,
      updated_at: at,
      whatsapp_owner_attested_at: at,
      whatsapp_owner_attested_by: user,
      whatsapp_owner_phone: "+12025550101",
      owner_bot_preferences: { custom: ["original"] },
      offline_invoice_provenance: true,
    },
  ],
  workspace_ai_settings: [
    {
      workspace_id: business,
      primary_model: "exact-model-free",
      fallback_model: null,
      created_at: at,
      updated_at: at,
      offline_invoice_provenance: true,
    },
  ],
});
it("retains settings and proof metadata without enabling any message delivery", () => {
  const f = fixture(),
    p = planLegacySettings(f, new Set([business]), new Set([user]));
  expect(p.workspaceSettings[0]).toMatchObject({
    businessName: "Exact original",
    followUpPreferences: f.workspace_settings[0]!.follow_up_preferences,
    whatsappOwnerAttestedBy: user,
    ownerBotPreferences: { custom: ["original"] },
    offlineInvoiceProvenance: true,
  });
  expect(p.workspaceAiSettings[0]).toMatchObject({
    primaryModel: "exact-model-free",
    fallbackModel: null,
  });
});
it("rejects orphan business/attestation and duplicate rows", () => {
  expect(() =>
    planLegacySettings(fixture(), new Set(), new Set([user])),
  ).toThrow(/orphan/);
  expect(() =>
    planLegacySettings(fixture(), new Set([business]), new Set()),
  ).toThrow(/orphan/);
  const f = fixture();
  f.workspace_ai_settings.push(f.workspace_ai_settings[0]!);
  expect(() =>
    planLegacySettings(f, new Set([business]), new Set([user])),
  ).toThrow(/Duplicate/);
});
it("rejects unmapped and missing fields rather than discarding preferences", () => {
  const f = fixture();
  Object.assign(f.workspace_settings[0]!, { future_private: "retain" });
  expect(() =>
    planLegacySettings(f, new Set([business]), new Set([user])),
  ).toThrow();
  expect(() =>
    planLegacySettings({ workspace_settings: [] }, new Set(), new Set()),
  ).toThrow();
});
it.each([
  { business_name: "   " },
  { business_name: "x".repeat(201) },
  { default_currency: "inr" },
  { whatsapp_owner_phone: "123" },
  { follow_up_preferences: [] },
  { owner_bot_preferences: [] },
])("rejects settings constraint violation %j", (change) => {
  const f = fixture();
  Object.assign(f.workspace_settings[0]!, change);
  expect(() =>
    planLegacySettings(f, new Set([business]), new Set([user])),
  ).toThrow();
});
it.each([
  { primary_model: "not-supported" },
  { primary_model: "UPPER-free" },
  { primary_model: "x".repeat(100) + "-free" },
  { fallback_model: "exact-model-free" },
  { fallback_model: "bad-model" },
])("rejects invalid AI models %j", (change) => {
  const f = fixture();
  Object.assign(f.workspace_ai_settings[0]!, change);
  expect(() =>
    planLegacySettings(f, new Set([business]), new Set([user])),
  ).toThrow();
});
it("retains asymmetric fallback choices and valid custom free models", () => {
  const f = fixture();
  Object.assign(f.workspace_ai_settings[0]!, {
    fallback_model: "gpt-oss:20b-cloud",
  });
  expect(
    planLegacySettings(f, new Set([business]), new Set([user]))
      .workspaceAiSettings[0]!.fallbackModel,
  ).toBe("gpt-oss:20b-cloud");
  Object.assign(f.workspace_ai_settings[0]!, {
    primary_model: "gpt-oss:20b-cloud",
  });
  expect(() =>
    planLegacySettings(f, new Set([business]), new Set([user])),
  ).toThrow();
});
