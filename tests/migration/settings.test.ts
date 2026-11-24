import { it, expect, vi } from "vitest";
vi.mock("@/server/modules/settings/settings.repository", () => ({
  settingsRepository: {},
}));
import { createSettingsService } from "../../src/server/modules/settings/settings.service";
it.each(["owner", "admin", "member"] as const)(
  "projects only general settings for %s",
  async (role) => {
    const row = {
      member: { workspaceId: "w", role },
      settings: {
        businessName: "Exact",
        defaultCurrency: "INR",
        defaultTimezone: "Asia/Kolkata",
        whatsappOwnerPhone: "private",
        ownerBotPreferences: { private: true },
      },
      aiSettings: {
        primaryModel: "exact-free",
        fallbackModel: null,
        offlineInvoiceProvenance: true,
      },
    };
    const view = await createSettingsService({
      findForMember: vi.fn().mockResolvedValue(row),
    }).read("u", "w");
    expect(view).toEqual({
      workspaceId: "w",
      canEdit: role !== "member",
      settings: {
        businessName: "Exact",
        defaultCurrency: "INR",
        defaultTimezone: "Asia/Kolkata",
      },
      aiSettings: { primaryModel: "exact-free", fallbackModel: null },
    });
    expect(JSON.stringify(view)).not.toMatch(
      /private|Provenance|Phone|Preferences/,
    );
  },
);
it("preserves missing settings rather than creating defaults on read", async () =>
  expect(
    await createSettingsService({
      findForMember: vi
        .fn()
        .mockResolvedValue({
          member: { workspaceId: "w", role: "member" },
          settings: null,
          aiSettings: null,
        }),
    }).read("u", "w"),
  ).toMatchObject({ settings: null, aiSettings: null }));
it("hides foreign business and rejects inconsistent repository scope", async () => {
  await expect(
    createSettingsService({
      findForMember: vi.fn().mockResolvedValue(null),
    }).read("u", "foreign"),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    createSettingsService({
      findForMember: vi
        .fn()
        .mockResolvedValue({ member: { workspaceId: "other", role: "owner" } }),
    }).read("u", "w"),
  ).rejects.toMatchObject({ statusCode: 404 });
});
