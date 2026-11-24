import { invoiceCorrectionAuditsService } from "../../src/server/modules/invoice-correction-audits/invoice-correction-audits.service";
import { businessRecordsService } from "../../src/server/modules/business-records/business-records.service";
import assert from "node:assert/strict";
import postgres from "postgres";
import { financialFixture } from "../../tests/migration/financial-fixture";
import { coreFixture } from "../../tests/migration/core-fixture";
import { importSyntheticCore } from "./import-synthetic-core";
import { getEnv } from "../../src/env";
import { paymentService } from "../../src/server/modules/invoices/payments.service";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const original = coreFixture(),
  financial = financialFixture();
// Use dedicated UUIDs to avoid colliding with other native proof fixtures.
const remap = (v: string) =>
  v
    .replaceAll(
      "11111111-1111-4111-8111-111111111111",
      "a1111111-1111-4111-8111-111111111111",
    )
    .replaceAll(
      "22222222-2222-4222-8222-222222222222",
      "a2222222-2222-4222-8222-222222222222",
    )
    .replaceAll(
      "33333333-3333-4333-8333-333333333333",
      "a3333333-3333-4333-8333-333333333333",
    );
const at = "2026-11-24T00:00:00Z",
  invoice = financial.invoices[0]!,
  payment = financial.payments[0]!,
  proposalId = "66666666-6666-4666-8666-666666666666";
invoice.amount_paid = "0";
const source = JSON.parse(
  remap(
    JSON.stringify({
      ...original,
      ...financial,
      invoice_correction_audits: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          workspace_id: invoice.workspace_id,
          owner_id: original.users[0]!.id,
          invoice_id: invoice.id,
          source_kind: "whatsapp",
          source_event_id: "source:event:exact",
          values: { currency: "INR" },
          before_snapshot: { private: { original: "0011" } },
          after_snapshot: { exact_total: "9007199254740993.01" },
          created_at: at,
        },
      ],
      business_records: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: invoice.workspace_id,
          record_type: "supplier",
          name: " Original supplier ",
          custom_fields: { supplier_note: "source-private", label: "0011" },
          created_at: at,
          updated_at: at,
          deleted_at: at,
          deleted_by: original.users[0]!.id,
        },
      ],
      profiles: [
        {
          user_id: original.users[0]!.id,
          full_name: "Exact imported profile",
          avatar_url: "opaque-avatar",
          created_at: at,
          updated_at: at,
        },
      ],
      workspace_settings: [
        {
          workspace_id: invoice.workspace_id,
          business_name: "Exact imported settings",
          default_currency: "INR",
          default_timezone: "Asia/Kolkata",
          follow_up_preferences: { private: "preserved" },
          created_at: at,
          updated_at: at,
          whatsapp_owner_attested_at: at,
          whatsapp_owner_attested_by: original.users[0]!.id,
          whatsapp_owner_phone: "+12025550101",
          owner_bot_preferences: { private: "retained" },
          offline_invoice_provenance: true,
        },
      ],
      workspace_ai_settings: [
        {
          workspace_id: invoice.workspace_id,
          primary_model: "exact-free",
          fallback_model: null,
          created_at: at,
          updated_at: at,
          offline_invoice_provenance: true,
        },
      ],
      users: [
        { ...original.users[0], email: "reversed-import@example.invalid" },
      ],
      workspaces: [{ ...original.workspaces[0], slug: "reversed-import" }],
      invoice_reopening_proposals: [
        {
          id: proposalId,
          workspace_id: invoice.workspace_id,
          owner_id: original.users[0]!.id,
          phone: "+12025550101",
          invoice_id: invoice.id,
          source_message_id: "original-source",
          invoice_number: invoice.invoice_number,
          currency: invoice.currency,
          amount: payment.amount,
          expected_updated_at: at,
          ledger_fingerprint: "original-hash",
          payment_ids: [payment.id],
          state: "confirmed",
          created_at: at,
          expires_at: at,
          decision_message_id: "original-decision",
          result: { private: "retained" },
        },
      ],
      payment_reversals: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: invoice.workspace_id,
          invoice_id: invoice.id,
          payment_id: payment.id,
          proposal_id: proposalId,
          amount: payment.amount,
          actor_id: original.users[0]!.id,
          reason: "owner_invoice_reopening",
          recorded_at: at,
        },
      ],
      invoice_number_sequences: [
        {
          workspace_id: invoice.workspace_id,
          invoice_year: 2026,
          last_value: "9007199254740993",
        },
      ],
    }),
  ),
);
try {
  assert.deepEqual(await importSyntheticCore(env.DATABASE_URL, source), {
    invoices: 1,
    payments: 1,
    reversals: 1,
    sequences: 1,
  });
  const [audit] =
    await sql`select source_kind,source_event_id,values,before_snapshot,after_snapshot,created_at from invoice_correction_audits where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`;
  assert.equal(audit!.source_kind, "whatsapp");
  assert.equal(audit!.source_event_id, "source:event:exact");
  assert.deepEqual(audit!.before_snapshot, { private: { original: "0011" } });
  assert.deepEqual(audit!.after_snapshot, {
    exact_total: "9007199254740993.01",
  });
  assert.equal(audit!.created_at.toISOString(), at.replace("Z", ".000Z"));
  await assert.rejects(
    sql`insert into invoice_correction_audits(id,workspace_id,owner_id,invoice_id,source_kind,source_event_id,values,before_snapshot,after_snapshot) select gen_random_uuid(),workspace_id,owner_id,invoice_id,source_kind,source_event_id,values,before_snapshot,after_snapshot from invoice_correction_audits where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`,
    (e) => (e as { code: string }).code === "23505",
  );
  const [record] =
    await sql`select name,custom_fields,created_at,deleted_at,deleted_by from business_records where id='77777777-7777-4777-8777-777777777777'`;
  assert.equal(record!.name, " Original supplier ");
  assert.deepEqual(record!.custom_fields, {
    supplier_note: "source-private",
    label: "0011",
  });
  assert.equal(record!.deleted_at.toISOString(), at.replace("Z", ".000Z"));
  assert.equal(record!.deleted_by, source.users[0].id);
  assert.equal(
    (
      await businessRecordsService.list(
        source.users[0].id,
        source.workspaces[0].id,
      )
    ).records.length,
    0,
  );
  assert.equal(
    (
      await businessRecordsService.list(
        source.users[0].id,
        source.workspaces[0].id,
        true,
      )
    ).records.length,
    1,
  );
  // A real member who is not the business owner must not see owner-only records.
  const member = "99999999-9999-4999-8999-999999999999";
  await sql`insert into users(id,email,name) values(${member},'record-member@example.test','Record member') on conflict(id) do nothing`;
  await sql`insert into workspace_members(workspace_id,user_id,role) values(${source.workspaces[0].id},${member},'member')`;
  await assert.rejects(
    businessRecordsService.list(member, source.workspaces[0].id, true),
    (e) => (e as { statusCode: number }).statusCode === 404,
  );
  await assert.rejects(
    sql`update business_records set deleted_by=null where id='77777777-7777-4777-8777-777777777777'`,
    (e) => (e as { code: string }).code === "23514",
  );
  // Cursor pages must exhaust a bounded dataset once, including deleted history.
  for (let i = 0; i < 53; i++)
    await sql`insert into business_records(workspace_id,record_type,name) values(${source.workspaces[0].id},'fixture',${"Paged record " + i})`;
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    const page = await businessRecordsService.list(
      source.users[0].id,
      source.workspaces[0].id,
      true,
      cursor,
      10,
    );
    assert.ok(page.records.length <= 10);
    for (const record of page.records) {
      assert.ok(!seen.has(record.id));
      seen.add(record.id);
    }
    cursor = page.nextCursor ?? undefined;
    pageCount++;
    assert.ok(pageCount <= 6);
  } while (cursor);
  assert.equal(seen.size, 54);
  assert.equal(pageCount, 6);
  const history = await invoiceCorrectionAuditsService.list(
    source.users[0].id,
    source.workspaces[0].id,
    invoice.id,
  );
  assert.equal(history.records.length, 1);
  assert.equal(history.nextCursor, null);
  assert.equal(history.records[0]!.sourceEventId, "source:event:exact");
  await assert.rejects(
    invoiceCorrectionAuditsService.list(
      member,
      source.workspaces[0].id,
      invoice.id,
    ),
    (e) => (e as { statusCode: number }).statusCode === 404,
  );
  await assert.rejects(
    invoiceCorrectionAuditsService.list(
      source.users[0].id,
      "44444444-4444-4444-8444-444444444444",
      invoice.id,
    ),
    (e) => (e as { statusCode: number }).statusCode === 404,
  );
  // Deliberately reverse UUID/time order and use microsecond ties.
  for (let i = 0; i < 3; i++)
    await sql`insert into invoice_correction_audits(id,workspace_id,owner_id,invoice_id,source_kind,source_event_id,values,before_snapshot,after_snapshot,created_at) values(${`eeeeeeee-eeee-4eee-8eee-${String(3 - i).padStart(12, "0")}`},${source.workspaces[0].id},${source.users[0].id},${invoice.id},'dashboard',${"chronological-" + i},'{}','{}','{}',${"2026-11-19T00:00:00.00000" + i + "Z"}::text::timestamptz)`;
  let auditCursor: string | undefined;
  const auditSeen: string[] = [];
  do {
    const p = await invoiceCorrectionAuditsService.list(
      source.users[0].id,
      source.workspaces[0].id,
      invoice.id,
      auditCursor,
      1,
    );
    for (const r of p.records) auditSeen.push(r.sourceEventId);
    auditCursor = p.nextCursor ?? undefined;
    assert.ok(auditSeen.length <= 4);
  } while (auditCursor);
  assert.deepEqual(auditSeen, [
    "chronological-0",
    "chronological-1",
    "chronological-2",
    "source:event:exact",
  ]);
  const [importedPrivate] =
    await sql`select p.full_name,p.avatar_url,s.owner_bot_preferences,s.whatsapp_owner_phone,a.primary_model from profiles p join workspace_settings s on s.whatsapp_owner_attested_by=p.user_id join workspace_ai_settings a on a.workspace_id=s.workspace_id where p.user_id=${source.users[0].id}`;
  assert.equal(importedPrivate!.full_name, "Exact imported profile");
  assert.equal(importedPrivate!.avatar_url, "opaque-avatar");
  assert.deepEqual(importedPrivate!.owner_bot_preferences, {
    private: "retained",
  });
  assert.equal(importedPrivate!.whatsapp_owner_phone, "+12025550101");
  assert.equal(importedPrivate!.primary_model, "exact-free");
  const [row] =
    await sql`select i.amount_paid, p.amount, r.amount reversed, s.last_value from invoices i join payments p on p.invoice_id=i.id join payment_reversals r on r.payment_id=p.id join invoice_number_sequences s on s.workspace_id=i.workspace_id where i.id=${invoice.id}`;
  assert.equal(Number(row!.amount_paid), 0);
  assert.equal(row!.amount, row!.reversed);
  assert.equal(String(row!.last_value), "9007199254740993");
  await paymentService.record(source.users[0].id, invoice.id, {
    amount: "2.00",
    settleRemaining: false,
    reference: null,
    idempotencyKey: "after-reversal",
  });
  const [net] =
    await sql`select amount_paid from invoices where id=${invoice.id}`;
  assert.equal(Number(net!.amount_paid), 2);
  const [receipts] =
    await sql`select count(*) n from payments where invoice_id=${invoice.id}`;
  assert.equal(Number(receipts!.n), 2);
  await assert.rejects(importSyntheticCore(env.DATABASE_URL, source));
  const [sequence] =
    await sql`select last_value from invoice_number_sequences where workspace_id=${source.workspaces[0].id}`;
  assert.equal(String(sequence!.last_value), "9007199254740993");
  console.log(
    "Native complete core/reversal/sequence synthetic import, net balance payment and collision rollback passed. No real import or numbering parity claim.",
  );
} finally {
  await sql.end();
}
