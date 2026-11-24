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
    page.getByText("Business settings are read-only.", { exact: false }),
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
  await page
    .getByRole("combobox")
    .selectOption("22222222-2222-4222-8222-222222222222");
  const records = page.getByRole("region", {
    name: "Business records",
    exact: true,
  });
  await expect(
    records.getByText("Synthetic supplier", { exact: true }),
  ).toBeVisible();
  await expect(records.getByText("0011", { exact: true })).toBeVisible();
  await expect(
    records.getByText("Deleted synthetic supplier", { exact: true }),
  ).toHaveCount(0);
  await expect(
    records.getByRole("button", { name: "Load more records", exact: true }),
  ).toBeVisible();
  await records
    .getByRole("button", { name: "Load more records", exact: true })
    .click();
  await expect(
    records.getByText("Showing all matching records.", { exact: false }),
  ).toBeVisible();
  await records.getByLabel("Include deleted history").check();
  await expect(
    records.getByText("Deleted synthetic supplier", { exact: true }),
  ).toBeVisible();
  const paged = await page.request.get(
    "/api/v1/business-records?workspaceId=22222222-2222-4222-8222-222222222222&includeDeleted=true&limit=1",
  );
  const first = (await paged.json()).data;
  expect(first.records).toHaveLength(1);
  expect(first.nextCursor).toBeTruthy();
  const final = await page.request.get(
    "/api/v1/business-records?workspaceId=22222222-2222-4222-8222-222222222222&includeDeleted=true&limit=1&after=" +
      first.nextCursor,
  );
  const second = (await final.json()).data;
  expect(second.records).toHaveLength(1);
  expect(second.records[0].id).not.toBe(first.records[0].id);
  expect(second.nextCursor).toBeTruthy();
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
