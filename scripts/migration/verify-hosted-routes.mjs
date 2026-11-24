import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const fixturePassword = process.env.CETLD_HOSTED_FIXTURE_PASSWORD;
if (!fixturePassword || fixturePassword.length < 32)
  throw Error("Ephemeral fixture password required");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 900 },
  extraHTTPHeaders: { "x-fixture-client-ip": "127.0.0.1" },
});
const base = "http://127.0.0.1:3109",
  workspace = "00000000-0000-4000-8000-000000000012";
try {
  await page.goto(base + "/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("hosted-fixture@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill(fixturePassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/customers$/);
  const call = async (method, path, body) => {
    const r = await page.request.fetch(base + "/api/v1" + path, {
      method,
      headers: { Origin: base },
      data: body,
    });
    const value = await r.json().catch(() => null);
    assert.ok(r.ok(), JSON.stringify({ path, status: r.status(), value }));
    return value?.data;
  };
  const customer = await call("POST", "/customers", {
    workspaceId: workspace,
    name: "Hosted synthetic customer",
    companyName: "Test only",
  });
  await call("PATCH", "/customers/" + customer.id, {
    name: "Hosted edited customer",
  });
  const invoice = await call("POST", "/invoices", {
    workspaceId: workspace,
    customerId: customer.id,
    invoiceNumber: "HOSTED-SYNTHETIC-1",
    amount: "12.34",
    currency: "INR",
  });
  const bytes = Buffer.from(
    "%PDF-1.4\n% Hosted actual route synthetic proof\n%%EOF\n",
  );
  const signed = await call("POST", "/invoices/" + invoice.id + "/upload-url", {
    fileName: "original-synthetic-name.pdf",
    mimeType: "application/pdf",
    size: bytes.length,
  });
  const upload = await fetch(signed.signedUrl, {
    method: "PUT",
    headers: { "content-type": "application/pdf" },
    body: bytes,
  });
  assert.ok(upload.ok);
  await call("PATCH", "/invoices/" + invoice.id, { status: "uploaded" });
  const download = await call(
    "GET",
    "/invoices/" + invoice.id + "/download-url",
  );
  assert.deepEqual(
    Buffer.from(await (await fetch(download.url)).arrayBuffer()),
    bytes,
  );
  await call("POST", "/invoices/" + invoice.id + "/payments", {
    amount: "2.33",
    settleRemaining: false,
    reference: null,
    idempotencyKey: "hosted-synthetic-payment",
  });
  const proposal = await call(
    "POST",
    "/invoices/" + invoice.id + "/lifecycle",
    { action: "prepare", key: "hosted-synthetic-prepare" },
  );
  await call("POST", "/invoices/" + invoice.id + "/lifecycle", {
    action: "confirm",
    key: "hosted-synthetic-confirm",
    proposalId: proposal.id,
    confirmation: "DELETE HOSTED-SYNTHETIC-1",
  });
  const hidden = await page.request.get(
    base + "/api/v1/invoices/" + invoice.id,
  );
  assert.equal(hidden.status(), 404);
  await call("POST", "/invoices/" + invoice.id + "/lifecycle", {
    action: "restore",
    key: "hosted-synthetic-restore",
  });
  const restored = await call("GET", "/invoices/" + invoice.id);
  assert.equal(restored.amountPaid, "2.33");
  assert.equal(restored.originalFileName, "original-synthetic-name.pdf");
  await page.goto(base + "/invoices");
  await page.getByText("HOSTED-SYNTHETIC-1", { exact: true }).waitFor();
  await mkdir("/tmp/cetld-hosted-visual", { recursive: true });
  await page.screenshot({
    path: "/tmp/cetld-hosted-visual/hosted-invoice-mobile.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      authenticatedHostedRoute: true,
      customerCRUD: true,
      pdfSignedRoundtrip: true,
      payment: true,
      softDeleteHidden: true,
      restoreLedger: true,
      invoiceId: invoice.id,
      customerId: customer.id,
    }),
  );
} finally {
  await browser.close();
}
