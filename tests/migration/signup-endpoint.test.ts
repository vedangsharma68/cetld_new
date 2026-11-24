import { beforeEach, describe, expect, it, vi } from "vitest";
const { signup } = vi.hoisted(() => ({ signup: vi.fn() }));
vi.mock("@/server/modules/auth/signup.service", () => ({
  signupService: { signup },
}));
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
import { POST } from "@/app/api/v1/auth/signup/route";
import { AppError } from "@/server/lib/errors";
const context = { params: Promise.resolve({}) };
const input = {
  email: "invite@example.test",
  name: "Name",
  businessName: "Business",
  password: "long-synthetic-test-password",
};
const request = (body: unknown) =>
  new Request("http://localhost:3000/api/v1/auth/signup", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
beforeEach(() => vi.resetAllMocks());
describe("signup route", () => {
  it("200 generic pending response, no account identifiers", async () => {
    signup.mockResolvedValue({ message: "Check your email" });
    const response = await POST(request(input), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { message: "Check your email" },
    });
  });
  it("invalid422", async () => {
    const response = await POST(request({}), context);
    expect(response.status).toBe(422);
    expect(signup).not.toHaveBeenCalled();
  });
  it("missing sender503", async () => {
    signup.mockRejectedValue(
      new AppError(
        503,
        "EMAIL_UNAVAILABLE",
        "Email signup is temporarily unavailable",
      ),
    );
    expect((await POST(request(input), context)).status).toBe(503);
  });
});
