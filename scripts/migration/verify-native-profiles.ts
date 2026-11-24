import assert from "node:assert/strict";
import postgres from "postgres";
import { getEnv } from "../../src/env";
import { profileService } from "../../src/server/modules/profiles/profiles.service";
import { planLegacyProfiles } from "./plan-legacy-profiles";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false }),
  owner = "11111111-1111-4111-8111-111111111111",
  other = "99999999-9999-4999-8999-999999999999",
  at = "2026-11-20T00:00:00Z";
try {
  const plan = planLegacyProfiles(
    {
      profiles: [
        {
          user_id: owner,
          full_name: " Original profile ",
          avatar_url: "opaque-retained-value",
          created_at: at,
          updated_at: at,
        },
      ],
    },
    new Set([owner]),
  );
  const row = plan[0]!;
  await sql`insert into profiles(user_id,full_name,avatar_url,created_at,updated_at) values(${row.userId},${row.fullName},${row.avatarUrl},${row.createdAt},${row.updatedAt})`;
  assert.equal(
    (await profileService.read(owner)).fullName,
    " Original profile ",
  );
  assert.deepEqual(await profileService.read(other), {
    fullName: null,
    updatedAt: null,
  });
  await profileService.update(owner, { fullName: "Changed" });
  const [saved] =
    await sql`select avatar_url,created_at,full_name from profiles where user_id=${owner}`;
  assert.equal(saved!.avatar_url, "opaque-retained-value");
  assert.equal(saved!.created_at.toISOString(), "2026-11-20T00:00:00.000Z");
  assert.equal(saved!.full_name, "Changed");
  const [foreign] =
    await sql`select count(*) n from profiles where user_id=${other}`;
  assert.equal(Number(foreign!.n), 0);
  await assert.rejects(
    sql`update profiles set full_name='   ' where user_id=${owner}`,
    (e) => (e as { code: string }).code === "23514",
  );
  await sql`delete from profiles where user_id=${owner}`;
  console.log(
    "Native profile import retains exact name/avatar/timestamps, self update preserves avatar/history, other identity read empty and CHECK guard passed",
  );
} finally {
  await sql.end();
}
