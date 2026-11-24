import { test, expect } from "@playwright/test";
import { evidencePath } from "./evidence";
test("owner reads original correction snapshots with bounded continuation and no replay", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 908 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("synthetic-local-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/customers/);
  await page.goto("/invoices");
  await page
    .getByRole("combobox", { name: "Business", exact: true })
    .selectOption("22222222-2222-4222-8222-222222222222");
  const row = page.getByRole("row").filter({ hasText: "SYNTHETIC-HISTORY" });
  await row
    .getByRole("button", { name: "Correction history", exact: true })
    .click();
  const history = row.getByRole("region", {
    name: "Invoice correction history",
  });
  await expect(history.locator("li")).toHaveCount(25);
  await history
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Before" }) })
    .first()
    .locator("summary")
    .click();
  await expect(history).toContainText("Original private value");
  await expect(history).toContainText('"opaque": "0011"');
  await history
    .getByRole("button", { name: "Load more history", exact: true })
    .click();
  await expect(history.locator("li")).toHaveCount(26);
  await expect(
    history.getByRole("button", { name: "Load more history", exact: true }),
  ).toHaveCount(0);
  await history.screenshot({
    path: evidencePath("cetld-correction-history-panel-mobile.png"),
  });
  await page.screenshot({
    path: evidencePath("cetld-correction-history-populated-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
