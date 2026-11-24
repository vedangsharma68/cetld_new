import "server-only";
import { sql } from "./client";
export async function assertDatabaseRole(): Promise<void> {
  const rows = await sql<
    { ok: boolean }[]
  >`select (r.rolsuper or r.rolbypassrls or (count(c.oid)=11 and coalesce(bool_and(c.relowner=r.oid and not c.relforcerowsecurity),false))) as ok from pg_roles r left join pg_class c on c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname in ('users','customers','workspaces','workspace_members','provider_accounts','signup_invites_v2','auth_rate_limits','oauth_signup_challenges','email_signup_verifications','invoices','storage_cleanup_jobs') where r.rolname=current_user group by r.oid,r.rolsuper,r.rolbypassrls`;
  if (rows[0]?.ok !== true)
    throw new Error(
      "Database role must own target tables without FORCE RLS, or explicitly bypass RLS",
    );
}
