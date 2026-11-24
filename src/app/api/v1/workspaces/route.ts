import { withHandler } from "@/server/lib/handler";
import { listWorkspaces } from "@/server/modules/workspaces/workspaces.controller";
export const GET = withHandler(listWorkspaces);
