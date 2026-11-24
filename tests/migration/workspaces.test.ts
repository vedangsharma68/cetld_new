import { describe, expect, it, vi } from "vitest";
vi.mock("@/server/modules/workspaces/workspaces.repository", () => ({
  workspaceRepository: {},
}));
import { createWorkspaceService } from "@/server/modules/workspaces/workspaces.service";
describe("workspace service", () => {
  it("returns only repository-scoped memberships", async () => {
    const repository = {
      listForUser: vi
        .fn()
        .mockResolvedValue([{ id: "w", name: "Business", role: "owner" }]),
    };
    expect(await createWorkspaceService(repository).listForUser("u")).toEqual([
      { id: "w", name: "Business", role: "owner" },
    ]);
    expect(repository.listForUser).toHaveBeenCalledWith("u");
  });
  it("does not swallow repository failures", async () => {
    const repository = {
      listForUser: vi.fn().mockRejectedValue(new Error("unavailable")),
    };
    await expect(
      createWorkspaceService(repository).listForUser("u"),
    ).rejects.toThrow("unavailable");
  });
});
