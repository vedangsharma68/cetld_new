import { describe, expect, it } from "vitest";
import { planLegacyCustomers } from "../../scripts/migration/plan-legacy-customers";
const business = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const row = () => ({
  id,
  workspace_id: business,
  name: "Original customer",
  company_name: "Original company",
  email: "synthetic@example.invalid",
  phone: "+12025550101",
  metadata: { private: "retained", source: [1, { nested: true }] },
  custom_fields: { arbitrary: { nested: "legacy JSON" } },
  created_at: "2025-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  external_provider: "zoho",
  external_customer_id: "exact-0000123",
  last_synced_at: "2026-10-01T12:01:00Z",
  sync_status: "error",
  last_sync_error: "private import history",
  reminder_tone: "gentle",
});
describe("legacy customer preservation planning", () => {
  it("preserves every observed column, including unknown JSON shapes, private metadata and integration state", () => {
    const source = row();
    const original = structuredClone(source);
    const result = planLegacyCustomers(
      { customers: [source] },
      new Set([business]),
    )[0];
    expect(result).toEqual({
      id,
      workspaceId: business,
      name: source.name,
      companyName: source.company_name,
      email: source.email,
      phone: source.phone,
      metadata: source.metadata,
      customFields: source.custom_fields,
      createdAt: new Date(source.created_at),
      updatedAt: new Date(source.updated_at),
      externalProvider: source.external_provider,
      externalCustomerId: source.external_customer_id,
      lastSyncedAt: new Date(source.last_synced_at),
      syncStatus: source.sync_status,
      lastSyncError: source.last_sync_error,
      reminderTone: source.reminder_tone,
    });
    expect(source).toEqual(original);
  });
  it("keeps nulls rather than inventing customer contact or attribution", () => {
    const source = {
      ...row(),
      company_name: null,
      email: null,
      phone: null,
      external_provider: null,
      external_customer_id: null,
      last_synced_at: null,
      last_sync_error: null,
      reminder_tone: null,
    };
    expect(
      planLegacyCustomers({ customers: [source] }, new Set([business]))[0],
    ).toMatchObject({
      companyName: null,
      email: null,
      phone: null,
      lastSyncedAt: null,
      reminderTone: null,
    });
  });
  it("rejects duplicate IDs and unknown businesses", () => {
    expect(() =>
      planLegacyCustomers({ customers: [row(), row()] }, new Set([business])),
    ).toThrow("Duplicate or orphan");
    expect(() =>
      planLegacyCustomers({ customers: [row()] }, new Set()),
    ).toThrow("Duplicate or orphan");
  });
  it("rejects new unmapped columns and missing required source fields", () => {
    expect(() =>
      planLegacyCustomers(
        { customers: [{ ...row(), future_private: true }] },
        new Set([business]),
      ),
    ).toThrow();
    const incomplete: Partial<ReturnType<typeof row>> = row();
    delete incomplete.metadata;
    expect(() =>
      planLegacyCustomers({ customers: [incomplete] }, new Set([business])),
    ).toThrow();
  });
});
