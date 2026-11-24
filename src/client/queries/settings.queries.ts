"use client";
import { useQuery } from "@tanstack/react-query";
import { settingsApi } from "@/client/api/settings.api";
import { qk } from "./query-keys";
export function useBusinessSettings(workspaceId: string) {
  return useQuery({
    queryKey: qk.settings.detail(workspaceId),
    queryFn: () => settingsApi.read(workspaceId),
    enabled: !!workspaceId,
  });
}
