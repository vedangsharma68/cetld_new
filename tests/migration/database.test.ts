import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
const db = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111",
  workspace = "22222222-2222-4222-8222-222222222222";
beforeAll(async () => {
  for (const file of (await readdir("src/server/db/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    await db.exec(await readFile("src/server/db/migrations/" + file, "utf8"));
});
afterAll(() => db.close());
describe("generated migration on synthetic PostgreSQL", () => {
  it("creates user/workspace/member/customer with constraints", async () => {
    await db.query(
      "insert into users(id,email,name) values($1,'owner@example.test','Owner')",
      [owner],
    );
    await db.query(
      "insert into workspaces(id,name,owner_id) values($1,'Test',$2)",
      [workspace, owner],
    );
    await db.query(
      "insert into workspace_members(workspace_id,user_id,role) values($1,$2,'owner')",
      [workspace, owner],
    );
    await db.query(
      "insert into customers(workspace_id,name) values($1,'Synthetic Customer')",
      [workspace],
    );
    const result = await db.query(
      "select name from customers where workspace_id=$1",
      [workspace],
    );
    expect(result.rows).toEqual([{ name: "Synthetic Customer" }]);
  });
  it("unique email and FK protections", async () => {
    await expect(
      db.query("insert into users(email) values('owner@example.test')"),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query(
        "insert into customers(workspace_id,name) values('33333333-3333-4333-8333-333333333333','No workspace')",
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("invitation mutation rolls back with account failure", async () => {
    await db.query(
      "insert into signup_invites_v2(email,code_hash,expires_at) values('rollback@example.test','hash',now()+interval '1 hour')",
    );
    await db.exec("begin");
    await db.query(
      "update signup_invites_v2 set consumed_at=now() where code_hash='hash'",
    );
    await db.exec("rollback");
    const result = await db.query<{ consumed_at: null }>(
      "select consumed_at from signup_invites_v2 where code_hash='hash'",
    );
    expect(result.rows[0]?.consumed_at).toBeNull();
  });
});
