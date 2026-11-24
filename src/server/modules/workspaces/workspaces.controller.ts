import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { ok } from "@/server/lib/response";
import { workspaceService } from "./workspaces.service";
export async function listWorkspaces() {
  const user = await getSessionUser();
  return ok(await workspaceService.listForUser(user.id));
}
