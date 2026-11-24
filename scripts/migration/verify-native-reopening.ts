import assert from "node:assert/strict";
import postgres from "postgres";
import { getEnv } from "../../src/env";
import { invoiceRepository } from "../../src/server/modules/invoices/invoices.repository";
import { paymentService } from "../../src/server/modules/invoices/payments.service";
import { reopeningService } from "../../src/server/modules/invoices/reopening.service";
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
  const make = async (label: string) => {
    const i = await invoiceRepository.create(owner, {
      workspaceId: workspace,
      invoiceNumber: label,
      amount: "100.00",
      currency: "INR",
    });
    assert.ok(i);
    await paymentService.record(owner, i.id, {
      amount: "2.00",
      settleRemaining: false,
      reference: null,
      idempotencyKey: label + "-payment",
    });
    return i;
  };
  const i = await make("REOPEN-1");
  await sql`update invoices set due_date='2026-01-01',metadata=metadata || '{"approved_reminder_text":"old"}'::jsonb where id=${i.id}`;
  const p = await reopeningService.act(owner, i.id, {
    action: "prepare",
    key: "reopen-prepare-1",
  });
  assert.equal(p.cashRefund, false);
  assert.equal(p.reversedAmount, "2.00");
  assert.deepEqual(
    await reopeningService.act(owner, i.id, {
      action: "prepare",
      key: "reopen-prepare-1",
    }),
    p,
  );
  await assert.rejects(
    reopeningService.act("99999999-9999-4999-8999-999999999999", i.id, {
      action: "confirm",
      key: "foreign-confirm",
      proposalId: p.id,
      confirmation: "yes",
    }),
  );
  const done = await reopeningService.act(owner, i.id, {
    action: "confirm",
    key: "reopen-confirm-1",
    proposalId: p.id,
    confirmation: "yes",
  });
  assert.equal(done.state, "confirmed");
  assert.equal(done.cashRefund, false);
  assert.equal(
    (
      await reopeningService.act(owner, i.id, {
        action: "confirm",
        key: "reopen-confirm-1",
        proposalId: p.id,
        confirmation: "yes",
      })
    ).state,
    "confirmed",
  );
  const [state] =
    await sql`select amount_paid,financial_status,followup_state,metadata from invoices where id=${i.id}`;
  assert.equal(Number(state!.amount_paid), 0);
  assert.equal(state!.financial_status, "overdue");
  assert.equal(state!.followup_state, "paused");
  assert.equal(state!.metadata.approved_reminder_text, null);
  const [audit] =
    await sql`select count(*) n from payments p join payment_reversals r on r.payment_id=p.id where p.invoice_id=${i.id}`;
  assert.equal(Number(audit!.n), 1);
  await paymentService.record(owner, i.id, {
    settleRemaining: true,
    reference: null,
    idempotencyKey: "resettle-after-reopen",
  });
  const [paid] = await sql`select amount_paid from invoices where id=${i.id}`;
  assert.equal(Number(paid!.amount_paid), 100);
  const s = await make("REOPEN-STALE"),
    sp = await reopeningService.act(owner, s.id, {
      action: "prepare",
      key: "reopen-prepare-stale",
    });
  await paymentService.record(owner, s.id, {
    amount: "1.00",
    settleRemaining: false,
    reference: null,
    idempotencyKey: "stale-new-payment",
  });
  await assert.rejects(
    reopeningService.act(owner, s.id, {
      action: "confirm",
      key: "reopen-confirm-stale",
      proposalId: sp.id,
      confirmation: "yes",
    }),
    /changed/,
  );
  const e = await make("REOPEN-EXPIRED"),
    ep = await reopeningService.act(owner, e.id, {
      action: "prepare",
      key: "reopen-prepare-expired",
    });
  await sql`update web_reopening_proposals set expires_at=clock_timestamp()-interval '1 second' where id=${ep.id}`;
  await assert.rejects(
    reopeningService.act(owner, e.id, {
      action: "confirm",
      key: "reopen-confirm-expired",
      proposalId: ep.id,
      confirmation: "yes",
    }),
    /expired/,
  );
  const c = await make("REOPEN-CANCEL"),
    cp = await reopeningService.act(owner, c.id, {
      action: "prepare",
      key: "reopen-prepare-cancel",
    });
  assert.equal(
    (
      await reopeningService.act(owner, c.id, {
        action: "cancel",
        key: "reopen-cancel-decision",
        proposalId: cp.id,
      })
    ).state,
    "cancelled",
  );
  await assert.rejects(
    reopeningService.act(owner, c.id, {
      action: "confirm",
      key: "reopen-confirm-cancel",
      proposalId: cp.id,
      confirmation: "yes",
    }),
  );
  // Completed decisions replay before all later state and ledger guard changes.
  await sql`update invoices set deleted_at=clock_timestamp(),financial_status='void',external_provider='later-ledger',amount_paid=0 where id=${i.id}`;
  assert.equal(
    (
      await reopeningService.act(owner, i.id, {
        action: "confirm",
        key: "reopen-confirm-1",
        proposalId: p.id,
        confirmation: "yes",
      })
    ).state,
    "confirmed",
  );
  // A later delivery-risk lockout must not prevent idempotent replay or cancel.
  await sql`update invoices set lifecycle_risk_verified=false where id=${i.id}`;
  assert.equal(
    (
      await reopeningService.act(owner, i.id, {
        action: "confirm",
        key: "reopen-confirm-1",
        proposalId: p.id,
        confirmation: "yes",
      })
    ).state,
    "confirmed",
  );
  const cancelled = await make("REOPEN-CANCEL-RISK");
  const cancelledProposal = await reopeningService.act(owner, cancelled.id, {
    action: "prepare",
    key: "cancel-risk-prepare",
  });
  await sql`update invoices set lifecycle_risk_verified=false where id=${cancelled.id}`;
  assert.equal(
    (
      await reopeningService.act(owner, cancelled.id, {
        action: "cancel",
        key: "cancel-risk-decision",
        proposalId: cancelledProposal.id,
      })
    ).state,
    "cancelled",
  );
  const concurrent = await make("REOPEN-CONCURRENT"),
    concurrentProposal = await reopeningService.act(owner, concurrent.id, {
      action: "prepare",
      key: "concurrent-prepare",
    });
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      reopeningService.act(owner, concurrent.id, {
        action: "confirm",
        key: "concurrent-confirm",
        proposalId: concurrentProposal.id,
        confirmation: "yes",
      }),
    ),
  );
  assert.ok(attempts.every((r) => r.state === "confirmed"));
  const [once] =
    await sql`select count(*) n from payment_reversals where invoice_id=${concurrent.id}`;
  assert.equal(Number(once!.n), 1);
  const race = await make("REOPEN-CONFIRM-CANCEL"),
    raceProposal = await reopeningService.act(owner, race.id, {
      action: "prepare",
      key: "decision-race-prepare",
    });
  const raceResults = await Promise.allSettled([
    reopeningService.act(owner, race.id, {
      action: "confirm",
      key: "decision-race-confirm",
      proposalId: raceProposal.id,
      confirmation: "yes",
    }),
    reopeningService.act(owner, race.id, {
      action: "cancel",
      key: "decision-race-cancel",
      proposalId: raceProposal.id,
    }),
  ]);
  assert.equal(raceResults.filter((r) => r.status === "fulfilled").length, 1);
  const [raceAudit] =
    await sql`select count(*) n from payment_reversals where invoice_id=${race.id}`;
  const winner = raceResults.find((r) => r.status === "fulfilled");
  assert.ok(winner?.status === "fulfilled");
  assert.equal(
    Number(raceAudit!.n),
    winner.value.state === "confirmed" ? 1 : 0,
  );
  console.log(
    "Native reopening: prepare/replay, owner scope, confirm/replay, retained receipt/reversal, overdue paused, re-settlement, stale/expiry/cancel guards passed; cashRefund false",
  );
} finally {
  await sql.end();
}
