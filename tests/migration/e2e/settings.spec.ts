import { test, expect } from "@playwright/test";
import { evidencePath } from "./evidence";
test("general settings page shows honest empty state without private settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 908 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("synthetic-local-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/customers/);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No saved general settings.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Read-only preview.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Your full name").fill("   ");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(1);
  await page.getByLabel("Your full name").fill("Profile browser exact");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByLabel("Your full name")).toHaveValue(
    "Profile browser exact",
  );
  await expect(page.getByRole("status")).toHaveText("Profile saved.");
  await page.reload();
  await expect(page.getByLabel("Your full name")).toHaveValue(
    "Profile browser exact",
  );
  const response = await page.request.get(
    "/api/v1/settings?workspaceId=99999999-9999-4999-8999-999999999999",
  );
  expect(response.status()).toBe(404);
  const text = await response.text();
  expect(text).not.toMatch(/ownerBot|whatsappOwner|attested|password/i);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: evidencePath("cetld-settings-mobile.png"),
    fullPage: true,
  });
});
