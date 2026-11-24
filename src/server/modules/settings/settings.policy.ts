import "server-only";
import { NotFoundError } from "@/server/lib/errors";
import type { Membership } from "../customers/customers.policy";
export function canReadSettings(
  member: Membership | null,
  workspaceId: string,
) {
  if (!member || member.workspaceId !== workspaceId)
    throw new NotFoundError("Business settings");
}
export function canEditSettings(member: Membership) {
  return member.role === "owner" || member.role === "admin";
}
