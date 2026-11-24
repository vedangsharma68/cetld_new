import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  workspaceMembers,
  workspaceSettings,
  workspaceAiSettings,
} from "@/server/db/schema";
export const settingsRepository = {
  async findForMember(userId: string, workspaceId: string) {
    return db.transaction(
      async (tx) => {
        const [member] = await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, userId),
            ),
          )
          .for("share");
        if (!member) return null;
        // Deliberately select only the approved low-sensitivity fields. Never select
        // owner phone, attestation, preference objects or provenance into this result.
        const [settings] = await tx
          .select({
            businessName: workspaceSettings.businessName,
            defaultCurrency: workspaceSettings.defaultCurrency,
            defaultTimezone: workspaceSettings.defaultTimezone,
          })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId));
        const [aiSettings] = await tx
          .select({
            primaryModel: workspaceAiSettings.primaryModel,
            fallbackModel: workspaceAiSettings.fallbackModel,
          })
          .from(workspaceAiSettings)
          .where(eq(workspaceAiSettings.workspaceId, workspaceId));
        return {
          member,
          settings: settings ?? null,
          aiSettings: aiSettings ?? null,
        };
      },
      { isolationLevel: "repeatable read" },
    );
  },
};
