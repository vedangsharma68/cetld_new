import { test, expect } from "@playwright/test";
test("open signup has no code, absent sender fails honestly without account", async ({
  page,
  request,
}) => {
  await page.goto("/signup");
  await expect(page.getByLabel("Invite code")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  const r = await request.post("/api/v1/auth/signup", {
    headers: { origin: "http://127.0.0.1:3107" },
    data: {
      email: "browser-pending@example.test",
      password: "synthetic-local-password-only",
      name: "Name",
      businessName: "Business",
    },
  });
  expect(r.status()).toBe(503);
  expect((await r.json()).error.code).toBe("EMAIL_UNAVAILABLE");
});
test("verification endpoint requires password proof and rejects invalid token", async ({
  request,
}) => {
  const r = await request.post("/api/v1/auth/verify-email", {
    headers: { origin: "http://127.0.0.1:3107" },
    data: { token: "0".repeat(64), password: "synthetic-long-password" },
  });
  expect(r.status()).toBe(403);
});
