import { test, expect } from "@playwright/test";
test("credentials, real workspace CRUD and cross-workspace privacy", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-local-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/customers$/);
  await expect(
    page.getByText("Synthetic Business", { exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  await page
    .getByLabel("Customer name", { exact: true })
    .fill("Local Browser Customer");
  await page
    .getByLabel("Email", { exact: true })
    .fill("synthetic@example.test");
  await page
    .getByRole("button", { name: "Add customer", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("link", { name: "Local Browser Customer" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: "/downloads/cetld-next-customers-mobile-20261124.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Local Browser Customer" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Customer name", { exact: true })
    .fill("Updated Browser Customer");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Updated Browser Customer" }),
  ).toBeVisible();
  const foreign = await page.request.get(
    "/api/v1/customers/55555555-5555-4555-8555-555555555555",
  );
  expect(foreign.status()).toBe(404);
  expect(await foreign.text()).not.toContain("Foreign private");
  await page.getByRole("button", { name: "Delete customer" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/customers$/);
  await expect(page.getByText("No customers yet")).toBeVisible();
});
