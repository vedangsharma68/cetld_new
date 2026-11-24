import { createHash } from "node:crypto";
import postgres from "postgres";
import { getEnv } from "../../src/env";
import { deleteFile } from "../../src/server/lib/storage";
const env = getEnv();
if (
  env.APP_ENV === "production" ||
  new URL(env.SUPABASE_URL).hostname !== "tgkpysathmrsngoavsqh.supabase.co"
)
  throw Error("Isolated app-dev only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const w = "00000000-0000-4000-8000-000000000012",
  u = "00000000-0000-4000-8000-000000000011";
try {
  const fixture =
    await sql`select w.id from workspaces w join users u on u.id=w.owner_id where w.id=${w} and u.id=${u} and u.email='hosted-fixture@example.invalid' and w.name='Isolated Hosted Fixture'`;
  if (fixture.length !== 1)
    throw Error("Exact synthetic fixture identity missing, cleanup stopped");
  const rows =
    await sql`select file_path from invoices where workspace_id=${w}`;
  const paths = rows.map((r) => r.file_path).filter(Boolean);
  if (paths.length) {
    for (const path of paths) await deleteFile(path);
  }
  await sql.begin(async (tx) => {
    await tx`delete from invoice_lifecycle_proposals where workspace_id=${w}`;
    await tx`delete from payments where workspace_id=${w}`;
    await tx`delete from invoices where workspace_id=${w}`;
    await tx`delete from customers where workspace_id=${w}`;
    await tx`delete from workspace_members where workspace_id=${w}`;
    await tx`delete from workspaces where id=${w} and owner_id=${u}`;
    await tx`delete from auth_rate_limits where key=${createHash("sha256").update("credentials:127.0.0.1:hosted-fixture@example.invalid").digest("hex")}`;
    await tx`delete from users where id=${u} and email='hosted-fixture@example.invalid'`;
  });
  process.stdout.write(
    JSON.stringify({ syntheticFixtureRemoved: true }) + "\n",
  );
} finally {
  await sql.end();
}
