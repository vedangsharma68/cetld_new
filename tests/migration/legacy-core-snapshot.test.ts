import { it, expect } from "vitest";
import { planLegacyCoreSnapshot } from "../../scripts/migration/plan-legacy-core-snapshot";
const user = "11111111-1111-4111-8111-111111111111",
  business = "22222222-2222-4222-8222-222222222222",
  customer = "33333333-3333-4333-8333-333333333333";
function fixture() {
  return {
    users: [
      {
        id: user,
        email: "synthetic@example.invalid",
        encrypted_password: null,
        email_confirmed_at: "2026-11-24T00:00:00Z",
        banned_until: null,
        deleted_at: null,
        is_sso_user: false,
        is_anonymous: false,
        raw_user_meta_data: {},
        email_change: "",
        phone: null,
        phone_change: "",
      },
    ],
    identities: [],
    workspaces: [
      {
        id: business,
        name: "Synthetic",
        owner_id: user,
        slug: "original-business",
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-21T00:00:00Z",
      },
    ],
    members: [
      {
        workspace_id: business,
        user_id: user,
        role: "owner",
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-21T00:00:00Z",
      },
    ],
    customers: [
      {
        id: customer,
        workspace_id: business,
        name: "Synthetic customer",
        company_name: null,
        email: null,
        phone: null,
        metadata: { private: "kept" },
        custom_fields: {},
        created_at: "2026-11-24T00:00:00Z",
        updated_at: "2026-11-24T00:00:00Z",
        external_provider: null,
        external_customer_id: null,
        last_synced_at: null,
        sync_status: "local",
        last_sync_error: null,
        reminder_tone: null,
      },
    ],
    payment_reversals: [],
    invoice_reopening_proposals: [],
    invoice_number_sequences: [],
    invoices: [],
    payments: [],
    invoice_files: [],
  };
}
it("composes exact user/business/customer scope without claiming a complete import", () => {
  const p = planLegacyCoreSnapshot(fixture());
  expect(p.users[0]?.id).toBe(user);
  expect(p.customers[0]?.workspaceId).toBe(business);
  expect(p.realImportAllowed).toBe(false);
  expect(p.remainingGates).toContain("reminder-effects-and-queues");
});
it("fails the entire plan on orphan customer or missing source slice", () => {
  const f = fixture();
  f.customers[0]!.workspace_id = user;
  expect(() => planLegacyCoreSnapshot(f)).toThrow(/orphan/);
  const partial: Partial<ReturnType<typeof fixture>> = fixture();
  delete partial.invoice_files;
  expect(() => planLegacyCoreSnapshot(partial)).toThrow();
});

it("blocks every unrecognized source table even when empty", () => {
  expect(() =>
    planLegacyCoreSnapshot({ ...fixture(), unmapped_table: [] }),
  ).toThrow(/Unmapped snapshot tables/);
});

it("composes invoice, exact ledger and original-file ownership and rejects cross-tenant wiring", () => {
  const f = fixture(),
    at = "2026-11-24T00:00:00Z",
    id = "44444444-4444-4444-8444-444444444444";
  const complete = {
    ...f,
    invoices: [
      {
        id,
        workspace_id: business,
        customer_id: customer,
        invoice_number: "C-1",
        issue_date: "2026-11-24",
        due_date: null,
        currency: "INR",
        total_amount: "12.34",
        amount_paid: "2.33",
        status: "sent",
        notes: null,
        metadata: { private: true },
        created_at: at,
        updated_at: at,
        external_provider: null,
        external_invoice_id: null,
        last_synced_at: null,
        sync_status: "local",
        last_sync_error: null,
        followup_state: "paused",
        next_follow_up_at: null,
        last_follow_up_at: null,
        reminder_count: 0,
        customer_phone: null,
        follow_up_settings: {},
        automation_version: "9007199254740993",
        deleted_at: null,
        deleted_by: null,
        custom_fields: {},
      },
    ],
    payments: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: business,
        invoice_id: id,
        amount: "2.33",
        paid_at: at,
        method: null,
        reference: null,
        metadata: {},
        created_at: at,
        updated_at: at,
        external_provider: null,
        external_payment_id: null,
        last_synced_at: null,
        sync_status: "local",
        last_sync_error: null,
        idempotency_key: null,
        settle_remaining: false,
      },
    ],
    invoice_files: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: business,
        invoice_id: id,
        storage_path: "old/original.pdf",
        file_name: "original filename.pdf",
        mime_type: "application/pdf",
        size_bytes: "1234",
        created_at: at,
        updated_at: at,
      },
    ],
  };
  const p = planLegacyCoreSnapshot(complete);
  expect(p.invoices[0]).toMatchObject({
    ownerId: user,
    customerId: customer,
    amountPaid: "2.33",
    automationVersion: 9007199254740993n,
    lifecycleRiskVerified: false,
  });
  expect(p.files[0]).toMatchObject({
    destinationPath: user + "/" + id + ".pdf",
    originalFileName: "original filename.pdf",
    requiresByteVerification: true,
  });
  for (const table of ["invoices", "payments", "invoice_files"] as const) {
    const foreign = structuredClone(complete);
    foreign[table][0]!.workspace_id = user;
    expect(() => planLegacyCoreSnapshot(foreign)).toThrow(/orphan/);
  }
});
