import postgres from "postgres";
import { hash } from "bcryptjs";
import { getEnv } from "../../src/env";
const env = getEnv();
if (
  env.APP_ENV === "production" ||
  new URL(env.SUPABASE_URL).hostname !== "tgkpysathmrsngoavsqh.supabase.co"
)
  throw Error("Isolated app-dev only");
const fixturePassword = process.env.CETLD_HOSTED_FIXTURE_PASSWORD;
if (!fixturePassword || fixturePassword.length < 32)
  throw Error("Ephemeral fixture password required");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    await tx`insert into users(id,email,name,role,password_hash,email_verified_at) values('00000000-0000-4000-8000-000000000011','hosted-fixture@example.invalid','Isolated Hosted Fixture','member',${await hash(fixturePassword, 12)},now())`;
    await tx`insert into workspaces(id,name,owner_id) values('00000000-0000-4000-8000-000000000012','Isolated Hosted Fixture','00000000-0000-4000-8000-000000000011')`;
    await tx`insert into workspace_members(workspace_id,user_id,role) values('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000011','owner')`;
  });
} finally {
  await sql.end();
}
