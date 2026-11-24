import { test, expect } from "@playwright/test";
test("landing and login fit desktop and narrow mobile", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Keep your business/ }),
    ).toBeVisible();
    await page.screenshot({
      path: `/downloads/cetld-next-home-${width}-20261124.png`,
      fullPage: true,
    });
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `/downloads/cetld-next-login-${width}-20261124.png`,
      fullPage: true,
    });
  }
});
test("signed-out customer route redirects and API401", async ({
  page,
  request,
}) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login$/);
  const response = await request.get(
    "/api/v1/customers?workspaceId=11111111-1111-4111-8111-111111111111",
  );
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({
    success: false,
    error: { code: "UNAUTHORIZED", requestId: expect.any(String) },
  });
});
test("wrong-origin signup is rejected before database access", async ({
  request,
}) => {
  const response = await request.post("/api/v1/auth/signup", {
    headers: { origin: "https://untrusted.invalid" },
    data: {},
  });
  expect(response.status()).toBe(403);
});

test("future dashboard routes are gated by default", async ({ page }) => {
  await page.goto("/settings/future-module");
  await expect(page).toHaveURL(/\/login$/);
});
