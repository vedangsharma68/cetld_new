import "server-only";
import { workspaceRepository } from "./workspaces.repository";
export function createWorkspaceService(repository = workspaceRepository) {
  return {
    async listForUser(userId: string) {
      return repository.listForUser(userId);
    },
  };
}
export const workspaceService = createWorkspaceService();
