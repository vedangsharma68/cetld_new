import { http } from "./http";
export type BusinessRecord = {
  id: string;
  recordType: string;
  name: string;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export const businessRecordsApi = {
  list: (workspaceId: string, includeDeleted: boolean, after?: string) =>
    http<{ records: BusinessRecord[]; nextCursor: string | null }>(
      `/business-records?${new URLSearchParams({ workspaceId, includeDeleted: String(includeDeleted), ...(after ? { after } : {}) })}`,
    ),
};
