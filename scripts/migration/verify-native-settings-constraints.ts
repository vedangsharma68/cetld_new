import assert from "node:assert/strict";
import postgres from "postgres";
import { getEnv } from "../../src/env";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
try {
  const [business] = await sql`select id from workspaces limit 1`;
  assert.ok(business);
  await sql`insert into workspace_settings(workspace_id) values (${business.id})`;
  await sql`insert into workspace_ai_settings(workspace_id,primary_model,fallback_model) values (${business.id},'custom-free','gpt-oss:20b-cloud')`;
  const violations = [
    [
      "workspace_settings_business_name_check",
      "update workspace_settings set business_name = '   '",
    ],
    [
      "workspace_settings_default_currency_check",
      "update workspace_settings set default_currency = 'inr'",
    ],
    [
      "workspace_settings_follow_up_preferences_check",
      "update workspace_settings set follow_up_preferences = '[]'::jsonb",
    ],
    [
      "workspace_settings_owner_bot_preferences_object",
      "update workspace_settings set owner_bot_preferences = '[]'::jsonb",
    ],
    [
      "workspace_settings_owner_bot_preferences_object",
      "update workspace_settings set owner_bot_preferences = jsonb_build_object('x', repeat('界',3000))",
    ],
    [
      "workspace_settings_whatsapp_owner_phone_check",
      "update workspace_settings set whatsapp_owner_phone = '123'",
    ],
    [
      "workspace_ai_settings_primary_model_check",
      "update workspace_ai_settings set primary_model = 'gpt-oss:20b-cloud', fallback_model = NULL",
    ],
    [
      "workspace_ai_settings_primary_model_check",
      "update workspace_ai_settings set primary_model = 'unsupported'",
    ],
    [
      "workspace_ai_settings_primary_model_check",
      "update workspace_ai_settings set primary_model = repeat('a',100) || '-free'",
    ],
    [
      "workspace_ai_settings_fallback_model_check",
      "update workspace_ai_settings set fallback_model = 'UPPER-free'",
    ],
    [
      "workspace_ai_settings_models_different",
      "update workspace_ai_settings set fallback_model = primary_model",
    ],
    ["workspaces_name_check", "update workspaces set name = '  '"],
    ["workspaces_slug_check", "update workspaces set slug = 'UPPERCASE'"],
  ];
  for (const [constraint, statement] of violations) {
    await assert.rejects(sql.unsafe(statement!), (error: unknown) => {
      const e = error as { code: string; constraint_name: string };
      return e.code === "23514" && e.constraint_name === constraint;
    });
  }
  await sql`update workspace_settings set business_name=' Exact ', whatsapp_owner_phone='+12025550101', owner_bot_preferences=${sql.json({ custom: "original" })}`;
  await sql`update workspace_ai_settings set primary_model='@cf/openai/gpt-oss-20b', fallback_model='longcat-2.5-preview-free'`;
  await sql`delete from workspace_settings where workspace_id=${business.id}`;
  await sql`delete from workspace_ai_settings where workspace_id=${business.id}`;
  console.log(
    "Native settings/business constraints: 13 invalid states rejected; valid private settings/model states preserved",
  );
} finally {
  await sql.end();
}
