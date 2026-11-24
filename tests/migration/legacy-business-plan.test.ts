import { it, expect } from "vitest";
import { planLegacyImport } from "../../scripts/migration/plan-legacy-import";
const id = "11111111-1111-4111-8111-111111111111",
  wid = "22222222-2222-4222-8222-222222222222",
  other = "33333333-3333-4333-8333-333333333333";
const user = {
  id,
  email: "legacy@example.test",
  encrypted_password: null,
  email_confirmed_at: null,
  banned_until: null,
  deleted_at: null,
  is_sso_user: false,
  is_anonymous: false,
  raw_user_meta_data: {},
  email_change: "",
  phone: null,
  phone_change: "",
};
const snapshot = {
  users: [user],
  identities: [],
  workspaces: [{ id: wid, owner_id: id, name: "Business" }],
  members: [{ workspace_id: wid, user_id: id, role: "owner" }],
};
it("preserves business UUID and role without global privilege", () => {
  const p = planLegacyImport(snapshot);
  expect(p.members).toEqual([{ workspaceId: wid, userId: id, role: "owner" }]);
  expect(p.users[0]!.role).toBe("member");
  expect(p.workspaces[0]!.id).toBe(wid);
});
it.each([
  [
    "orphan owner",
    {
      ...snapshot,
      workspaces: [{ ...snapshot.workspaces[0]!, owner_id: other }],
    },
  ],
  [
    "duplicate business",
    {
      ...snapshot,
      workspaces: [...snapshot.workspaces, ...snapshot.workspaces],
    },
  ],
  [
    "orphan member",
    {
      ...snapshot,
      members: [{ workspace_id: wid, user_id: other, role: "owner" }],
    },
  ],
  [
    "orphan business membership",
    {
      ...snapshot,
      members: [{ workspace_id: other, user_id: id, role: "owner" }],
    },
  ],
  [
    "duplicate membership",
    { ...snapshot, members: [...snapshot.members, ...snapshot.members] },
  ],
  ["missing owner membership", { ...snapshot, members: [] }],
  [
    "owner role mismatch",
    {
      ...snapshot,
      members: [{ workspace_id: wid, user_id: id, role: "admin" }],
    },
  ],
  [
    "unknown role",
    {
      ...snapshot,
      members: [{ workspace_id: wid, user_id: id, role: "superuser" }],
    },
  ],
])("blocks %s", (_name, input) =>
  expect(() => planLegacyImport(input)).toThrow(),
);
