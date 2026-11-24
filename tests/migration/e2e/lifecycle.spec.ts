import { test, expect } from "@playwright/test";
test("owner reversible invoice deletion retains ledger and supports paused restore", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 908 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("synthetic-local-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/customers/);
  await page.goto("/invoices");
  await page.getByLabel("Invoice number").fill("BROWSER-LIFECYCLE");
  await page.getByLabel("Amount", { exact: true }).fill("12.34");
  await page.getByRole("button", { name: "Add invoice" }).click();
  let row = page.getByRole("row").filter({ hasText: "BROWSER-LIFECYCLE" });
  await row.getByRole("button", { name: "Record payment" }).click();
  await page.getByLabel("Payment amount for BROWSER-LIFECYCLE").fill("2.33");
  await page.getByRole("button", { name: "Save payment" }).click();
  await expect(row).toContainText("Paid 2.33");
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    page.getByLabel("Confirm deletion of BROWSER-LIFECYCLE"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Confirm deletion of BROWSER-LIFECYCLE"),
  ).toBeVisible();
  await page
    .getByLabel("Confirm deletion of BROWSER-LIFECYCLE")
    .fill("DELETE BROWSER-LIFECYCLE");
  await page.screenshot({
    path: "/downloads/cetld-lifecycle-mobile-20261124.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Confirm deletion", exact: true })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: "BROWSER-LIFECYCLE" }),
  ).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("button", { name: "Restore BROWSER-LIFECYCLE", exact: true })
    .click();
  row = page.getByRole("row").filter({ hasText: "BROWSER-LIFECYCLE" });
  await expect(row).toContainText("Paid 2.33");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
