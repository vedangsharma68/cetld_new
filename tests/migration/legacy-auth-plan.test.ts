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
