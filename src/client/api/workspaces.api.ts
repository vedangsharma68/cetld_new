import { http } from "./http";
export type Workspace = {
  id: string;
  name: string;
  canManageLifecycle: boolean;
  canReadBusinessRecords: boolean;
  role: "owner" | "admin" | "member";
};
export const workspacesApi = { list: () => http<Workspace[]>("/workspaces") };
