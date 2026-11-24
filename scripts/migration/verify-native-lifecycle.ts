import assert from "node:assert/strict";
import postgres from "postgres";
import { getEnv } from "../../src/env";
import { lifecycleRepository } from "../../src/server/modules/invoices/lifecycle.repository";
import { lifecycleService } from "../../src/server/modules/invoices/lifecycle.service";
import { invoiceRepository } from "../../src/server/modules/invoices/invoices.repository";
import { paymentRepository } from "../../src/server/modules/invoices/payments.repository";
const env = getEnv();
if (
  env.APP_ENV !== "test" ||
  new URL(env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw Error("Synthetic loopback only");
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const owner = "11111111-1111-4111-8111-111111111111",
  workspace = "22222222-2222-4222-8222-222222222222",
  foreign = "33333333-3333-4333-8333-333333333333";
try {
  const invoice = await invoiceRepository.create(owner, {
    workspaceId: workspace,
    invoiceNumber: "LIFECYCLE-NATIVE",
    amount: "12.34",
    currency: "INR",
  });
  assert.ok(invoice);
  await assert.rejects(() => lifecycleService.act(foreign, invoice.id, {action:"prepare",key:"foreign-lifecycle"}), {statusCode:404});
  let proposal = await lifecycleService.act(owner, invoice.id, {
    action: "prepare",
    key: "native-prepare-1",
  });
  assert.ok(proposal);
  assert.equal(
    (
      await lifecycleService.act(owner, invoice.id, {
        action: "prepare",
        key: "native-prepare-1",
      })
    )?.id,
    proposal.id,
  );
  await paymentRepository.record(owner, invoice.id, {
    amount: "2.33",
    settleRemaining: false,
    reference: null,
    idempotencyKey: "lifecycle-payment",
  });
  await assert.rejects(
    () =>
      lifecycleService.act(owner, invoice.id, {
        action: "confirm",
        key: "confirm-stale",
        proposalId: proposal.id,
        confirmation: "yes",
      }),
    { code: "ACTION_STALE" },
  );
  await lifecycleService.act(owner, invoice.id, {
    action: "cancel",
    key: "cancel-stale",
    proposalId: proposal.id,
  });
  proposal = await lifecycleService.act(owner, invoice.id, {
    action: "prepare",
    key: "native-prepare-2",
  });
  assert.ok(proposal);
  assert.equal(proposal.hadPayment, true);
  await assert.rejects(
    () =>
      lifecycleService.act(owner, invoice.id, {
        action: "confirm",
        key: "confirm-wrong",
        proposalId: proposal.id,
        confirmation: "yes",
      }),
    { code: "EXACT_CONFIRMATION_REQUIRED" },
  );
  const result = await lifecycleService.act(owner, invoice.id, {
    action: "confirm",
    key: "confirm-exact",
    proposalId: proposal.id,
    confirmation: "DELETE LIFECYCLE-NATIVE",
  });
  assert.equal(result?.state, "deleted");
  await assert.rejects(
    () =>
      lifecycleService.act(owner, invoice.id, {
        action: "confirm",
        key: "confirm-exact",
        proposalId: proposal.id,
        confirmation: "yes",
      }),
    { code: "IDEMPOTENCY_MISMATCH" },
  );
  assert.equal(
    (
      await lifecycleService.act(owner, invoice.id, {
        action: "confirm",
        key: "confirm-exact",
        proposalId: proposal.id,
        confirmation: "DELETE LIFECYCLE-NATIVE",
      })
    )?.state,
    "deleted",
  );
  assert.equal(
    await invoiceRepository.reserveUpload(
      owner,
      invoice.id,
      { fileName: "a.pdf", mimeType: "application/pdf", size: 20 },
      owner + "/" + invoice.id + ".pdf",
    ),
    null,
  );
  assert.equal(await invoiceRepository.finalize(owner, invoice.id), null);

  assert.equal(await invoiceRepository.find(owner, invoice.id), null);
  assert.equal(
    (
      await sql`select count(*)::int n from payments where invoice_id=${invoice.id}`
    )[0]!.n,
    1,
  );
  assert.equal(
    (
      await sql`select count(*)::int n from storage_cleanup_jobs where path=${owner + "/" + invoice.id + ".pdf"}`
    )[0]!.n,
    0,
  );
  await assert.rejects(
    () =>
      paymentRepository.record(owner, invoice.id, {
        amount: "2.33",
        settleRemaining: false,
        reference: null,
        idempotencyKey: "lifecycle-payment",
      }),
    { code: "INVOICE_DELETED" },
  );
  assert.equal(
    (
      await lifecycleService.act(owner, invoice.id, {
        action: "restore",
        key: "restore-native",
      })
    )?.state,
    "restored",
  );
  assert.equal(
    (await invoiceRepository.find(owner, invoice.id))?.amountPaid,
    "2.33",
  );
  assert.equal(
    (await sql`select followup_state from invoices where id=${invoice.id}`)[0]!
      .followup_state,
    "paused",
  );
  assert.equal(
    (
      await lifecycleService.act(owner, invoice.id, {
        action: "restore",
        key: "restore-native",
      })
    )?.state,
    "restored",
  );
  // Pending proposal scope is business+owner, not invoice. Concurrent creates
  // serialize through the same owner scope and leave exactly one pending row.
  const second = await invoiceRepository.create(owner, {
    workspaceId: workspace,
    invoiceNumber: "LIFECYCLE-SECOND",
    amount: "1.00",
    currency: "INR",
  });
  assert.ok(second);
  const pendingRace = await Promise.allSettled([
    lifecycleService.act(owner, invoice.id, {
      action: "prepare",
      key: "pending-race-first",
    }),
    lifecycleService.act(owner, second.id, {
      action: "prepare",
      key: "pending-race-second",
    }),
  ]);
  assert.equal(pendingRace.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(pendingRace.filter((r) => r.status === "rejected").length, 1);
  const pending = await lifecycleRepository.pending(owner, workspace);
  assert.ok(pending);
  assert.equal(await lifecycleRepository.pending(foreign, workspace), null);
  assert.deepEqual(await lifecycleRepository.deleted(foreign, workspace), []);
  await sql`update invoice_lifecycle_proposals set expires_at=clock_timestamp()-interval '1 second' where id=${pending.id}`;
  await assert.rejects(
    () =>
      lifecycleService.act(owner, pending.invoiceId, {
        action: "confirm",
        key: "expired-native-confirm",
        proposalId: pending.id,
        confirmation: "DELETE LIFECYCLE-NATIVE",
      }),
    { code: "ACTION_EXPIRED" },
  );
  const expiryReplacement = await lifecycleService.act(owner, second.id, {
    action: "prepare",
    key: "after-expiry-native",
  });
  assert.ok(expiryReplacement);
  await lifecycleService.act(owner, second.id, {
    action: "confirm",
    key: "unpaid-delete-native",
    proposalId: expiryReplacement.id,
    confirmation: " YES ",
  });
  assert.equal(
    (await lifecycleRepository.deleted(owner, workspace)).some(
      (row) => row.id === second.id,
    ),
    true,
  );
  const deletion = (
    await sql`select deleted_at from invoices where id=${second.id}`
  )[0]!.deleted_at;
  await sql`update invoices set deleted_at=clock_timestamp()-interval '31 days' where id=${second.id}`;
  await assert.rejects(
    () =>
      lifecycleService.act(owner, second.id, {
        action: "restore",
        key: "expired-restore-native",
      }),
    { code: "UNDO_EXPIRED" },
  );
  await sql`update invoices set deleted_at=${deletion} where id=${second.id}`;
  await lifecycleService.act(owner, second.id, {
    action: "restore",
    key: "second-restore-native",
  });
  // Business owner without matching owner membership is not enough.
  await sql`update workspace_members set role='admin' where workspace_id=${workspace} and user_id=${owner}`;
  await assert.rejects(() => lifecycleService.act(owner, second.id, {action:"prepare",key:"owner-role-mismatch"}), {statusCode:404});
  assert.equal(await lifecycleRepository.pending(owner, workspace), null);
  assert.deepEqual(await lifecycleRepository.deleted(owner, workspace), []);
  await sql`update workspace_members set role='owner' where workspace_id=${workspace} and user_id=${owner}`;
  await sql`update invoices set lifecycle_risk_verified=false where id=${invoice.id}`;
  await assert.rejects(
    () =>
      lifecycleService.act(owner, invoice.id, {
        action: "prepare",
        key: "unverified-risk",
      }),
    { code: "LIFECYCLE_RISK_UNKNOWN" },
  );
  console.log(
    "Synthetic lifecycle owner, proposal replay, payment staleness, exact confirmation, retained ledger/file path, hidden deletion and paused restore passed. No service-message or reminder integration claimed.",
  );
} finally {
  await sql.end();
}
