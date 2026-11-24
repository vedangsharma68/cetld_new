import "server-only";
import { NotFoundError, ForbiddenError } from "@/server/lib/errors";
import type { Membership } from "../customers/customers.policy";
export function canReadInvoice(member: Membership | null, workspaceId: string) {
  if (!member || member.workspaceId !== workspaceId)
    throw new NotFoundError("Invoice");
}
export function canDeleteInvoice(
  member: Membership | null,
  workspaceId: string,
) {
  canReadInvoice(member, workspaceId);
  if (member?.role !== "owner")
    throw new ForbiddenError("Only the business owner can delete an invoice");
}
