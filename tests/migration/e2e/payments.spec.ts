import { test, expect } from "@playwright/test";
test("records a payment exactly and shows persisted balance", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 908 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("synthetic-local-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/customers/);
  await page.goto("/invoices");
  await page.getByLabel("Invoice number").fill("BROWSER-PAYMENT");
  await page.getByLabel("Amount", { exact: true }).fill("12.34");
  await page.getByRole("button", { name: "Add invoice" }).click();
  const row = page.getByRole("row").filter({ hasText: "BROWSER-PAYMENT" });
  await row.getByRole("button", { name: "Record payment" }).click();
  await page.getByLabel("Payment amount for BROWSER-PAYMENT").fill("2.33");
  await page.screenshot({
    path: "/downloads/cetld-payment-form-mobile-20261124.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Save payment" }).click();
  await expect(row).toContainText("Paid 2.33");
  await expect(row).toContainText("draft");
  await page.screenshot({
    path: "/downloads/cetld-payment-mobile-20261124.png",
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: "BROWSER-PAYMENT" }),
  ).toContainText("Paid 2.33");
});
