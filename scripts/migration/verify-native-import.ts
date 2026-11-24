import assert from "node:assert/strict";
import postgres from "postgres";
import { hash } from "bcryptjs";
import { getEnv } from "../../src/env";
import { importSyntheticLegacy } from "./import-synthetic-legacy";
import { authService } from "../../src/server/modules/auth/auth.service";
import { authRepository } from "../../src/server/modules/auth/auth.repository";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const id = "77777777-7777-4777-8777-777777777777",
  business = "88888888-8888-4888-8888-888888888888";
const password = "synthetic-imported-password";
const user = {
  id,
  email: "legacy-import@example.test",
  encrypted_password: await hash(password, 4),
  email_confirmed_at: "2026-11-20T00:00:00Z",
  banned_until: null,
  deleted_at: null,
  is_sso_user: false,
  is_anonymous: false,
  raw_user_meta_data: { name: "Imported synthetic" },
  email_change: "",
  phone: null,
  phone_change: "",
};
const snapshot = {
  users: [user],
  identities: [
    {
      user_id: id,
      provider: "google",
      provider_id: "synthetic-import-subject",
      identity_data: {
        sub: "synthetic-import-subject",
        email: user.email,
        email_verified: true,
      },
    },
  ],
  workspaces: [
    {
      id: business,
      name: "Imported synthetic business",
      owner_id: id,
      slug: "original-business",
      created_at: "2026-11-20T00:00:00Z",
      updated_at: "2026-11-21T00:00:00Z",
    },
  ],
  members: [
    {
      workspace_id: business,
      user_id: id,
      role: "owner",
      created_at: "2026-11-20T00:00:00Z",
      updated_at: "2026-11-21T00:00:00Z",
    },
  ],
};
try {
  assert.deepEqual(await importSyntheticLegacy(env.DATABASE_URL, snapshot), {
    users: 1,
    accounts: 1,
    workspaces: 1,
    members: 1,
  });
  const [preservedBusiness] =
    await sql`select slug,created_at,updated_at from workspaces where id=${business}`;
  assert.equal(preservedBusiness!.slug, "original-business");
  assert.equal(
    preservedBusiness!.created_at.toISOString(),
    "2026-11-20T00:00:00.000Z",
  );
  assert.equal(
    preservedBusiness!.updated_at.toISOString(),
    "2026-11-21T00:00:00.000Z",
  );
  assert.equal(
    (await authService.credentials(user.email, password, "import-proof"))?.id,
    id,
  );
  assert.equal(
    (await authRepository.byProvider("google", "synthetic-import-subject"))?.id,
    id,
  );
  assert.equal(
    (await sql`select password_hash from users where id=${id}`)[0]!
      .password_hash,
    user.encrypted_password,
  );
  assert.equal(
    (
      await sql`select role from workspace_members where workspace_id=${business} and user_id=${id}`
    )[0]!.role,
    "owner",
  );
  const rollbackId = "99999999-9999-4999-8999-999999999999";
  await assert.rejects(() =>
    importSyntheticLegacy(env.DATABASE_URL, {
      users: [
        { ...user, id: rollbackId, email: "rollback-import@example.test" },
        { ...user, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      ],
      identities: [],
      workspaces: [],
      members: [],
    }),
  );
  assert.equal(
    (await sql`select count(*)::int n from users where id=${rollbackId}`)[0]!.n,
    0,
  );
  assert.equal(
    (
      await sql`select count(*)::int n from workspace_members where user_id=${id} and workspace_id='44444444-4444-4444-8444-444444444444'`
    )[0]!.n,
    0,
  );
  console.log(
    "Synthetic same-UUID/bcrypt/Google binding/business membership import and atomic collision rollback passed. No real account snapshot read.",
  );
} finally {
  await sql.end();
}
