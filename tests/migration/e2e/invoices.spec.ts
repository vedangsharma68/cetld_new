import { evidencePath } from "./evidence";
import { test, expect } from "@playwright/test";
test("invoice metadata UI and cross-business API privacy", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-local-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/customers$/);
  await page.getByRole("link", { name: "Invoices", exact: true }).click();
  await page
    .getByLabel("Invoice number", { exact: true })
    .fill("BROWSER-PDF-1");
  await page.getByLabel("Amount", { exact: true }).fill("250.50");
  await page.getByRole("button", { name: "Add invoice", exact: true }).click();
  await expect(page.getByText("BROWSER-PDF-1", { exact: true })).toBeVisible();
  const response = await page.request.get(
    "/api/v1/invoices?workspaceId=44444444-4444-4444-8444-444444444444",
  );
  expect(response.status()).toBe(404);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: evidencePath("cetld-next-invoices-mobile-20261124.png"),
    fullPage: true,
  });
});
