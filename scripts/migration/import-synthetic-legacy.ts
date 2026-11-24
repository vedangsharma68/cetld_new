import postgres from "postgres";
import { planLegacyImport } from "./plan-legacy-import";
// Proof-only import. Deliberately cannot target a hosted or production database.
// A separate reviewed operator is required before real account export/import.
export async function importSyntheticLegacy(
  databaseUrl: string,
  snapshot: unknown,
) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || process.env.APP_ENV !== "test")
    throw Error("Synthetic loopback test import only");
  const p = planLegacyImport(snapshot);
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await sql.begin(async (tx) => {
      for (const u of p.users)
        await tx`insert into users(id,email,name,role,email_verified_at,banned_until,deleted_at,password_hash,session_version) values(${u.id},${u.email},${u.name},${u.role},${u.emailVerifiedAt},${u.bannedUntil},${u.deletedAt},${u.passwordHash},${u.sessionVersion})`;
      for (const a of p.accounts)
        await tx`insert into provider_accounts(provider,provider_account_id,user_id) values(${a.provider},${a.providerAccountId},${a.userId})`;
      for (const w of p.workspaces)
        await tx`insert into workspaces(id,name,owner_id,slug,created_at,updated_at) values(${w.id},${w.name},${w.ownerId},${w.slug},${w.createdAt},${w.updatedAt})`;
      for (const m of p.members)
        await tx`insert into workspace_members(workspace_id,user_id,role,created_at,updated_at) values(${m.workspaceId},${m.userId},${m.role},${m.createdAt},${m.updatedAt})`;
    });
    return {
      users: p.users.length,
      accounts: p.accounts.length,
      workspaces: p.workspaces.length,
      members: p.members.length,
    };
  } finally {
    await sql.end();
  }
}
