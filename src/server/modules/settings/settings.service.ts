import "server-only";
import { NotFoundError } from "@/server/lib/errors";
import { settingsRepository } from "./settings.repository";
import { canReadSettings, canEditSettings } from "./settings.policy";
import type { BusinessSettingsView } from "@/shared/schemas/settings.schema";
export function createSettingsService(repository = settingsRepository) {
  return {
    async read(
      userId: string,
      workspaceId: string,
    ): Promise<BusinessSettingsView> {
      const row = await repository.findForMember(userId, workspaceId);
      if (!row) throw new NotFoundError("Business settings");
      canReadSettings(row.member, workspaceId);
      return {
        workspaceId,
        canEdit: canEditSettings(row.member),
        settings: row.settings
          ? {
              businessName: row.settings.businessName,
              defaultCurrency: row.settings.defaultCurrency,
              defaultTimezone: row.settings.defaultTimezone,
            }
          : null,
        aiSettings: row.aiSettings
          ? {
              primaryModel: row.aiSettings.primaryModel,
              fallbackModel: row.aiSettings.fallbackModel,
            }
          : null,
      };
    },
  };
}
export const settingsService = createSettingsService();
