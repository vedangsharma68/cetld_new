import { describe, expect, it, vi } from "vitest";
vi.mock("@/server/modules/auth/auth.repository", () => ({
  authRepository: {},
}));
import { hash } from "bcryptjs";
import { createAuthService } from "@/server/modules/auth/auth.service";
import { createSignupService } from "@/server/modules/auth/signup.service";
vi.mock("@/server/modules/auth/signup.repository", () => ({
  signupRepository: {},
}));
describe("auth", () => {
  it("accepts compatible bcrypt and denies wrong credentials", async () => {
    const repo = {
      byId: vi.fn(),
      byEmail: vi.fn().mockResolvedValue({
        id: "u",
        email: "u@example.test",
        name: "Test",
        image: null,
        emailVerifiedAt: new Date(),
        passwordHash: await hash("test-password", 4),
      }),
      byProvider: vi.fn(),
      resetAttempts: vi.fn(),
      takeAttempt: vi.fn().mockResolvedValue(true),
    };
    const service = createAuthService(repo);
    expect(
      await service.credentials("u@example.test", "test-password"),
    ).toMatchObject({ id: "u" });
    expect(await service.credentials("u@example.test", "wrong")).toBeNull();
  });
  it("Google-only user cannot use credentials", async () => {
    const repo = {
      byId: vi.fn(),
      byEmail: vi.fn().mockResolvedValue({ passwordHash: null }),
      byProvider: vi.fn(),
      resetAttempts: vi.fn(),
      takeAttempt: vi.fn().mockResolvedValue(true),
    };
    expect(
      await createAuthService(repo).credentials("u@example.test", "wrong"),
    ).toBeNull();
  });
  it("verified Google requires established subject binding", async () => {
    const repo = {
      byId: vi.fn(),
      byEmail: vi.fn(),
      byProvider: vi.fn().mockResolvedValue(null),
      resetAttempts: vi.fn(),
      takeAttempt: vi.fn(),
    };
    const service = createAuthService(repo);
    expect(await service.google("s", "u@example.test", false)).toBeNull();
    expect(await service.google("s", "u@example.test", true)).toBeNull();
    repo.byProvider.mockResolvedValue({ id: "u", email: "u@example.test" });
    expect(await service.google("s", "u@example.test", true)).toMatchObject({
      id: "u",
    });
  });
  it("rate limits before password lookup", async () => {
    const repo = {
      byId: vi.fn(),
      byEmail: vi.fn(),
      byProvider: vi.fn(),
      resetAttempts: vi.fn(),
      takeAttempt: vi.fn().mockResolvedValue(false),
    };
    await expect(
      createAuthService(repo).credentials("u@example.test", "p"),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(repo.byEmail).not.toHaveBeenCalled();
  });
});
describe("verified open signup service", () => {
  const input = {
    email: "u@example.test",
    password: "long-test-password",
    name: "Name",
    businessName: "Business",
  };
  const setup = () => {
    const repo = { prepare: vi.fn().mockResolvedValue(true), verify: vi.fn() };
    const limiter = {
      byId: vi.fn(),
      byEmail: vi.fn(),
      byProvider: vi.fn(),
      resetAttempts: vi.fn(),
      takeAttempt: vi.fn().mockResolvedValue(true),
    };
    const mailer = { assertReady: vi.fn(), send: vi.fn() };
    return {
      repo,
      limiter,
      mailer,
      service: createSignupService(repo, limiter, mailer),
    };
  };
  it("persists only hashes and responds generically", async () => {
    const { repo, mailer, service } = setup();
    expect(await service.signup(input)).toEqual({
      message: expect.stringContaining("Check your email"),
    });
    const passed = repo.prepare.mock.calls[0]?.[0] as {
      tokenHash: string;
      passwordHash: string;
    };
    expect(passed.passwordHash).not.toContain(input.password);
    const token = mailer.send.mock.calls[0]?.[1] as string;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(passed.tokenHash).not.toBe(token);
  });
  it("per-address cap runs before persistence", async () => {
    const { repo, limiter, service } = setup();
    limiter.takeAttempt.mockResolvedValue(false);
    await expect(service.signup(input, "address")).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(repo.prepare).not.toHaveBeenCalled();
  });
  it("missing mail blocks before persisting pending state", async () => {
    const { repo, mailer, service } = setup();
    mailer.assertReady.mockImplementation(() => {
      throw Error("unconfigured");
    });
    await expect(service.signup(input)).rejects.toThrow("unconfigured");
    expect(repo.prepare).not.toHaveBeenCalled();
  });
  it("verification rejects expired/wrong/replayed token uniformly", async () => {
    const { repo, service } = setup();
    repo.verify.mockResolvedValue(null);
    await expect(
      service.verify("a".repeat(64), input.password),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("verification passes token hash, not raw token", async () => {
    const { repo, service } = setup();
    repo.verify.mockResolvedValue({ verified: true });
    await expect(
      service.verify("a".repeat(64), input.password),
    ).resolves.toEqual({ verified: true });
    expect(repo.verify.mock.calls[0]?.[0]).not.toBe("a".repeat(64));
  });
});

it("existing-email requests return generic response without dead email", async () => {
  const repo = { prepare: vi.fn().mockResolvedValue(false), verify: vi.fn() };
  const limiter = {
    byId: vi.fn(),
    byEmail: vi.fn(),
    byProvider: vi.fn(),
    resetAttempts: vi.fn(),
    takeAttempt: vi.fn().mockResolvedValue(true),
  };
  const mailer = { assertReady: vi.fn(), send: vi.fn() };
  const service = createSignupService(repo, limiter, mailer);
  await expect(
    service.signup({
      email: "existing@example.test",
      password: "long-test-password",
      name: "Name",
      businessName: "Business",
    }),
  ).resolves.toMatchObject({
    message: expect.stringContaining("Check your email"),
  });
  expect(mailer.send).not.toHaveBeenCalled();
});
