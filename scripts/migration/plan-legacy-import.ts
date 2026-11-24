import { z } from "zod";
import { planLegacyAuth } from "./plan-legacy-auth";
const businessSchema = z.object({
  workspaces: z.array(
    z.object({ id: z.uuid(), owner_id: z.uuid(), name: z.string().min(1) }),
  ),
  members: z.array(
    z.object({
      workspace_id: z.uuid(),
      user_id: z.uuid(),
      role: z.enum(["owner", "admin", "member"]),
    }),
  ),
});
export function planLegacyImport(snapshot: unknown) {
  const auth = planLegacyAuth(snapshot);
  const business = businessSchema.parse(snapshot);
  const userIds = new Set(auth.users.map((u) => u.id));
  const workspaceIds = new Set<string>();
  const keys = new Set<string>();
  for (const w of business.workspaces) {
    if (workspaceIds.has(w.id) || !userIds.has(w.owner_id))
      throw Error("Duplicate business or orphan owner");
    workspaceIds.add(w.id);
  }
  const members = business.members.map((m) => {
    const key = m.workspace_id + ":" + m.user_id;
    if (
      keys.has(key) ||
      !workspaceIds.has(m.workspace_id) ||
      !userIds.has(m.user_id)
    )
      throw Error("Duplicate or orphan membership");
    keys.add(key);
    return { workspaceId: m.workspace_id, userId: m.user_id, role: m.role };
  });
  const membersByKey = new Map(
    members.map((m) => [m.workspaceId + ":" + m.userId, m]),
  );
  for (const w of business.workspaces) {
    const owner = membersByKey.get(w.id + ":" + w.owner_id);
    if (owner?.role !== "owner")
      throw Error("Business owner membership mismatch");
  }
  return {
    ...auth,
    workspaces: business.workspaces.map((w) => ({
      id: w.id,
      ownerId: w.owner_id,
      name: w.name,
    })),
    members,
  };
}
