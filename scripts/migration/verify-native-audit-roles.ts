import assert from "node:assert/strict";
import postgres from "postgres";
import { getEnv } from "../../src/env";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const owner = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const url = new URL(env.DATABASE_URL);
url.username = "synthetic_runtime_audit";
const runtime = postgres(url.toString(), { max: 1, prepare: false });
try {
  // This role exists only in a disposable synthetic database. No candidate
  // migration or deployed credential is changed by this design experiment.
  await owner.unsafe(
    "create role synthetic_runtime_audit login bypassrls; grant usage on schema public to synthetic_runtime_audit; grant select,insert on payments,payment_reversals to synthetic_runtime_audit",
  );
  const [identity] = await runtime`select current_user principal`;
  assert.equal(identity!.principal, "synthetic_runtime_audit");
  await runtime`select id from payments limit 1`;
  await runtime`select id from payment_reversals limit 1`;
  const [grants] =
    await runtime`select has_table_privilege(current_user,'payments','INSERT') receipt_insert,has_table_privilege(current_user,'payment_reversals','INSERT') reversal_insert,has_table_privilege(current_user,'payments','UPDATE') receipt_update,has_table_privilege(current_user,'payment_reversals','DELETE') reversal_delete`;
  assert.deepEqual(grants, {
    receipt_insert: true,
    reversal_insert: true,
    receipt_update: false,
    reversal_delete: false,
  });
  for (const statement of [
    "update payments set amount=amount where false",
    "delete from payments where false",
    "update payment_reversals set amount=amount where false",
    "delete from payment_reversals where false",
  ]) {
    await assert.rejects(
      runtime.unsafe(statement),
      (e) => (e as { code: string }).code === "42501",
    );
  }
  // Server connects as table owner in the original brief. Even explicit REVOKE
  // cannot take away owner rights, so this is not represented as solved today.
  await owner.unsafe(
    "revoke update,delete on payments,payment_reversals from fixture",
  );
  const [ownerRights] =
    await owner`select has_table_privilege(current_user,'payments','UPDATE') receipt_update,has_table_privilege(current_user,'payment_reversals','DELETE') reversal_delete`;
  assert.equal(ownerRights!.receipt_update, true);
  assert.equal(ownerRights!.reversal_delete, true);
  console.log(
    "Audit-role experiment: separate non-owner BYPASSRLS role reads/inserts but actual UPDATE/DELETE returns42501; owner REVOKE retains rights. Runtime design decision still required, no deployed role created.",
  );
} finally {
  await runtime.end();
  await owner.end();
}
