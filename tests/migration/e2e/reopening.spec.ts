import { test, expect } from "@playwright/test";
import { evidencePath } from "./evidence";
test("owner confirms local reopening without erasing history or promising a refund", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 908 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("synthetic-local-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/customers/);
  await page.goto("/invoices");
  await page.getByLabel("Invoice number").fill("BROWSER-REOPEN");
  await page.getByLabel("Amount", { exact: true }).fill("12.34");
  await page.getByRole("button", { name: "Add invoice" }).click();
  const row = page.getByRole("row").filter({ hasText: "BROWSER-REOPEN" });
  await expect(
    row.getByRole("button", { name: "Reopen invoice", exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "Record payment" }).click();
  await page.getByLabel("Payment amount for BROWSER-REOPEN").fill("2.33");
  await page.getByRole("button", { name: "Save payment" }).click();
  await expect(row).toContainText("Paid 2.33");
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes("/reopening") && r.request().method() === "POST",
  );
  await row
    .getByRole("button", { name: "Reopen invoice", exact: true })
    .click();
  const preview = await (await responsePromise).json();
  const changed = await page.request.post(
    `/api/v1/invoices/${preview.data.invoiceId}/payments`,
    {
      headers: { origin: "http://127.0.0.1:3107" },
      data: {
        amount: "0.01",
        settleRemaining: false,
        reference: null,
        idempotencyKey: "browser-stale-reopen-change",
      },
    },
  );
  expect(changed.status()).toBe(200);
  await row.getByRole("button", { name: "Confirm reopening" }).click();
  await expect(row).toContainText("Prepare a new reopening preview");
  await expect(
    row.getByRole("button", { name: "Confirm reopening" }),
  ).toHaveCount(0);
  await row
    .getByRole("button", { name: "Reopen invoice", exact: true })
    .click();
  await expect(row).toContainText("Reverse 2.34");
  await expect(row).toContainText("This does not send a cash refund");
  await page.screenshot({
    path: evidencePath("cetld-reopening-confirm-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await row.getByRole("button", { name: "Confirm reopening" }).click();
  await expect(row).toContainText("Paid 0.00");
  await expect(row).toContainText("sent");
  await expect(row).toContainText("No cash refund was sent");
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: "BROWSER-REOPEN" }),
  ).toContainText("Paid 0.00");
});
