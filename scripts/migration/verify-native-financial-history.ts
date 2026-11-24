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
