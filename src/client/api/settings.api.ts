import { http } from "./http";
import type { BusinessSettingsView } from "@/shared/schemas/settings.schema";
export const settingsApi = {
  read: (workspaceId: string) =>
    http<BusinessSettingsView>(
      `/settings?${new URLSearchParams({ workspaceId })}`,
    ),
};
