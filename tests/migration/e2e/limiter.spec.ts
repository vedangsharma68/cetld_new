import { test, expect } from "@playwright/test";
test("Auth.js reports rate limit clearly to the login form", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("blocked@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-wrong-password");
  for (let i = 0; i < 10; i++) {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("main [role=alert]")).toHaveText(
      "Email or password is incorrect.",
    );
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
  }
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("main [role=alert]")).toHaveText(
    "Too many failed attempts. Try again in 15 minutes.",
  );
  await page.screenshot({
    path: "/downloads/cetld-next-rate-limit-20261124.png",
    fullPage: true,
  });
});
