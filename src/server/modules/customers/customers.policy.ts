import "server-only";
import { NotFoundError } from "@/server/lib/errors";
export type Membership = {
  workspaceId: string;
  role: "owner" | "admin" | "member";
};
export function canViewCustomer(
  membership: Membership | null,
  workspaceId: string,
): void {
  if (!membership || membership.workspaceId !== workspaceId)
    throw new NotFoundError("Customer");
}
export function canManageCustomer(
  membership: Membership | null,
  workspaceId: string,
): void {
  canViewCustomer(membership, workspaceId);
}
