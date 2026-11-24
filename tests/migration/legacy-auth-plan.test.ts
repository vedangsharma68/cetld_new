import { describe, it, expect } from "vitest";
import { hashSync, compareSync } from "bcryptjs";
import { planLegacyAuth } from "../../scripts/migration/plan-legacy-auth";
const id = "11111111-1111-4111-8111-111111111111";
const u = () => ({
  id,
  email: "Legacy@example.test",
  encrypted_password: hashSync("synthetic-legacy-password", 4),
  email_confirmed_at: "2026-11-20T10:00:00Z",
  banned_until: null,
  deleted_at: null,
  is_anonymous: false,
  is_sso_user: false,
  raw_user_meta_data: { name: "Legacy" },
  email_change: "",
  phone: null,
  phone_change: "",
});
const identity = () => ({
  user_id: id,
  provider: "google",
  provider_id: "trusted-sub",
  identity_data: {
    sub: "trusted-sub",
    email: "legacy@example.test",
    email_verified: true,
  },
});
describe("legacy auth import plan, pure no effects", () => {
  it("preserves UUID bcrypt verification and disabled states without privilege upgrade", () => {
    const input = {
      ...u(),
      banned_until: "2026-12-01T00:00:00Z",
      deleted_at: "2026-11-21T00:00:00Z",
    };
    const p = planLegacyAuth({ users: [input], identities: [identity()] });
    expect(p.users[0]).toMatchObject({
      id,
      passwordHash: input.encrypted_password,
      emailVerifiedAt: input.email_confirmed_at,
      bannedUntil: input.banned_until,
      deletedAt: input.deleted_at,
      role: "member",
    });
    expect(
      compareSync("synthetic-legacy-password", p.users[0]!.passwordHash!),
    ).toBe(true);
    expect(p.accounts[0]).toEqual({
      provider: "google",
      providerAccountId: "trusted-sub",
      userId: id,
    });
  });
  it("does not upgrade unverified email accounts", () =>
    expect(
      planLegacyAuth({
        users: [{ ...u(), email_confirmed_at: null }],
        identities: [],
      }).users[0]!.emailVerifiedAt,
    ).toBeNull());
  it("blocks collisions unknown providers invalid hashes and unsupported auth", () => {
    for (const s of [
      { users: [u(), u()], identities: [] },
      { users: [{ ...u(), encrypted_password: "not-bcrypt" }], identities: [] },
      { users: [{ ...u(), is_sso_user: true }], identities: [] },
      { users: [u()], identities: [{ ...identity(), provider: "unknown" }] },
      {
        users: [u()],
        identities: [
          {
            ...identity(),
            identity_data: {
              sub: "other",
              email: "legacy@example.test",
              email_verified: true,
            },
          },
        ],
      },
      {
        users: [u()],
        identities: [
          {
            ...identity(),
            identity_data: {
              sub: "trusted-sub",
              email: "attacker@example.test",
              email_verified: true,
            },
          },
        ],
      },
      {
        users: [u()],
        identities: [
          {
            ...identity(),
            identity_data: {
              sub: "trusted-sub",
              email: "legacy@example.test",
              email_verified: false,
            },
          },
        ],
      },
    ])
      expect(() => planLegacyAuth(s)).toThrow();
  });
});

it.each([
  ["anonymous", { is_anonymous: true }],
  ["SSO", { is_sso_user: true }],
  ["invalid hash", { encrypted_password: "not-bcrypt" }],
  ["pending email", { email_change: "new@example.test" }],
  ["phone auth", { phone: "+15555550100" }],
  ["pending phone", { phone_change: "+15555550100" }],
])("blocks %s independently", (_name, change) => {
  expect(() =>
    planLegacyAuth({ users: [{ ...u(), ...change }], identities: [] }),
  ).toThrow();
});
it("blocks orphan identity", () => {
  expect(() => planLegacyAuth({ users: [], identities: [identity()] })).toThrow(
    /Orphan/,
  );
});
it("blocks duplicate Google subject", () => {
  expect(() =>
    planLegacyAuth({ users: [u()], identities: [identity(), identity()] }),
  ).toThrow(/Duplicate provider subject/);
});
it("blocks duplicate canonical email across distinct UUIDs", () => {
  expect(() =>
    planLegacyAuth({
      users: [
        u(),
        {
          ...u(),
          id: "22222222-2222-4222-8222-222222222222",
          email: "legacy@example.test",
        },
      ],
      identities: [],
    }),
  ).toThrow(/Duplicate account identity/);
});
it("blocks snapshots omitting phone or pending-change state", () => {
  const { phone, ...incomplete } = u();
  void phone;
  expect(() =>
    planLegacyAuth({ users: [incomplete], identities: [] }),
  ).toThrow();
});
