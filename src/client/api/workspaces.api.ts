import { http } from "./http";
export type Workspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
};
export const workspacesApi = { list: () => http<Workspace[]>("/workspaces") };
