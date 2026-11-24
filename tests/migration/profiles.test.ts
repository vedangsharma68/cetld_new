import { it, expect, vi } from "vitest";
vi.mock("@/server/modules/profiles/profiles.repository", () => ({
  profileRepository: {},
}));
import { createProfileService } from "../../src/server/modules/profiles/profiles.service";
import { planLegacyProfiles } from "../../scripts/migration/plan-legacy-profiles";
const id = "11111111-1111-4111-8111-111111111111",
  at = "2026-11-24T00:00:00Z";
it("preserves exact profile data/history without merging it into auth name", () =>
  expect(
    planLegacyProfiles(
      {
        profiles: [
          {
            user_id: id,
            full_name: " Original ",
            avatar_url: "opaque-original",
            created_at: at,
            updated_at: at,
          },
        ],
      },
      new Set([id]),
    ),
  ).toEqual([
    {
      userId: id,
      fullName: " Original ",
      avatarUrl: "opaque-original",
      createdAt: new Date(at),
      updatedAt: new Date(at),
    },
  ]));
it("rejects orphan/duplicate/unmapped profiles and missing table", () => {
  const row = {
    user_id: id,
    full_name: null,
    avatar_url: null,
    created_at: at,
    updated_at: at,
  };
  for (const input of [
    { profiles: [row, row] },
    { profiles: [{ ...row, future: "keep" }] },
    {},
  ])
    expect(() => planLegacyProfiles(input, new Set([id]))).toThrow();
  expect(() => planLegacyProfiles({ profiles: [row] }, new Set())).toThrow(
    /orphan/,
  );
});
it("reads and updates only the authenticated own profile projection", async () => {
  const repo = {
    find: vi
      .fn()
      .mockResolvedValue({
        fullName: "Name",
        updatedAt: new Date(at),
        avatarUrl: "private",
      }),
    save: vi
      .fn()
      .mockResolvedValue({
        fullName: "New",
        updatedAt: new Date(at),
        avatarUrl: "private",
      }),
  };
  const service = createProfileService(repo);
  expect(await service.read(id)).toEqual({
    fullName: "Name",
    updatedAt: new Date(at),
  });
  expect(await service.update(id, { fullName: "New" })).toEqual({
    fullName: "New",
    updatedAt: new Date(at),
  });
  expect(repo.save).toHaveBeenCalledWith(id, "New");
});
it("does not create a profile on missing read or swallow writes", async () => {
  const repo = {
    find: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(null),
  };
  expect(await createProfileService(repo).read(id)).toEqual({
    fullName: null,
    updatedAt: null,
  });
  expect(repo.save).not.toHaveBeenCalled();
  await expect(
    createProfileService(repo).update(id, { fullName: null }),
  ).rejects.toThrow();
});
