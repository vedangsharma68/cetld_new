import { describe, it, expect, vi, beforeEach } from "vitest";
const { repository, limiter } = vi.hoisted(() => ({
  repository: { open: vi.fn() },
  limiter: { takeAttempt: vi.fn() },
}));
vi.mock("@/server/modules/auth/google-signup.repository", () => ({
  googleSignupRepository: repository,
}));
vi.mock("@/server/modules/auth/auth.repository", () => ({
  authRepository: limiter,
}));
import { googleSignupService } from "@/server/modules/auth/google-signup.service";
beforeEach(() => {
  vi.resetAllMocks();
  limiter.takeAttempt.mockResolvedValue(true);
});
describe("verified Google open signup", () => {
  it("refuses unverified identity before DB", async () => {
    expect(
      await googleSignupService.open("u@example.test", "s", "Name", false, "a"),
    ).toBeNull();
    expect(repository.open).not.toHaveBeenCalled();
  });
  it("per-address creation cap runs before DB", async () => {
    limiter.takeAttempt.mockResolvedValue(false);
    await expect(
      googleSignupService.open("u@example.test", "s", "Name", true, "a"),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(repository.open).not.toHaveBeenCalled();
  });
  it("verified callback passes subject/email binding without invite", async () => {
    repository.open.mockResolvedValue({ id: "u" });
    expect(
      await googleSignupService.open(
        "U@example.test",
        "subject",
        "Name",
        true,
        "a",
      ),
    ).toEqual({ id: "u" });
    expect(repository.open).toHaveBeenCalledWith({
      email: "u@example.test",
      subject: "subject",
      name: "Name",
    });
  });
});

it.each([undefined, null, "", "  ", "\t\n"])(
  "missing or blank provider name %s does not block signup",
  async (name) => {
    await googleSignupService.open("u@example.test", "s", name, true, "a");
    expect(repository.open).toHaveBeenCalledWith({
      email: "u@example.test",
      subject: "s",
      name: "New member",
    });
  },
);
it.each(["x".repeat(161), "世".repeat(200), "😀".repeat(180)])(
  "bounds long provider names without splitting Unicode",
  async (name) => {
    await googleSignupService.open(
      "u@example.test",
      "s",
      "  " + name + "  ",
      true,
      "a",
    );
    expect(repository.open.mock.calls[0]![0].name).toBe(
      Array.from(name).slice(0, 160).join(""),
    );
  },
);
it("trims a valid provider name", async () => {
  await googleSignupService.open("u@example.test", "s", "  世界  ", true, "a");
  expect(repository.open.mock.calls[0]![0].name).toBe("世界");
});
