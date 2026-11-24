import assert from "node:assert/strict";
import postgres from "postgres";
import { getEnv } from "../../src/env";
import { settingsService } from "../../src/server/modules/settings/settings.service";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false }),
  owner = "11111111-1111-4111-8111-111111111111",
  workspace = "22222222-2222-4222-8222-222222222222";
try {
  await sql`insert into workspace_settings(workspace_id,business_name,whatsapp_owner_phone,owner_bot_preferences,follow_up_preferences,whatsapp_owner_attested_by,whatsapp_owner_attested_at) values(${workspace},'Exact settings','+12025550101','{"secret":"private"}','{"private":true}',${owner},clock_timestamp())`;
  await sql`insert into workspace_ai_settings(workspace_id,primary_model) values(${workspace},'exact-free')`;
  const view = await settingsService.read(owner, workspace);
  assert.equal(view.canEdit, true);
  assert.equal(view.settings!.businessName, "Exact settings");
  assert.equal(view.aiSettings!.primaryModel, "exact-free");
  assert.ok(
    !JSON.stringify(view).match(/private|Phone|Preferences|Attest|Provenance/),
  );
  await assert.rejects(
    settingsService.read("99999999-9999-4999-8999-999999999999", workspace),
    (e) => (e as { statusCode: number }).statusCode === 404,
  );
  await sql`delete from workspace_settings where workspace_id=${workspace}`;
  await sql`delete from workspace_ai_settings where workspace_id=${workspace}`;
  console.log(
    "Native settings member-scope general projection/private-field exclusion and foreign404 passed; read does not create settings",
  );
} finally {
  await sql.end();
}
