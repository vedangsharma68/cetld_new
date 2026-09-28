import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractInvoice } from '../ai/extraction.mjs';

const fixture = (name) => readFile(fileURLToPath(new URL(`./fixtures/${name}.pdf`, import.meta.url)));
const field = (value, confidence = 0.99) => ({ value, confidence });
const base = {
  direction: field('receivable'), invoiceNumber: field('INV-R-1048'),
  customerName: field('Northlake Foods'), invoiceDate: field('2026-09-01'),
  dueDate: field('2026-10-01'), subtotal: field(100), tax: field(18),
  total: field(118), outstandingAmount: field(118), currency: field('INR'),
  clientPhone: field(null, 0), clientEmail: field(null, 0), notes: field(null, 0),
  lineItems: { value: [], confidence: 0 },
};

async function extractFixture(name, overrides = {}) {
  const bytes = await fixture(name);
  assert.match(bytes.subarray(0, 8).toString('ascii'), /^%PDF-1\./);
  assert.match(bytes.subarray(-32).toString('ascii'), /%%EOF/);
  let delivered;
  const provider = { async generateStructured(options) {
    delivered = options;
    return { data: options.validate({ ...base, ...overrides }), model: 'fixture-provider' };
  } };
  const result = await extractInvoice({ provider, bytes, mimeType: 'application/pdf', fileName: `${name}.pdf` });
  const content = delivered.messages[0].content;
  assert.equal(typeof content, 'string', 'selectable PDF text should reach the model without binary PDF processing');
  assert.match(content, /Page 1 of 1/);
  assert.match(content, /invoice/i);
  return result;
}

test('valid receivable PDF keeps a missing due date visibly uncertain', async () => {
  const result = await extractFixture('receivable_missing_due', { dueDate: field(null, 0) });
  assert.equal(result.direction.value, 'receivable');
  assert.equal(result.dueDate.value, null);
  assert.ok(result.uncertainFields.includes('dueDate'));
  assert.equal(result.reviewRequired, true);
});

test('valid supplier PDF is classified payable and cannot be silently treated as a receivable', async () => {
  const result = await extractFixture('payable', {
    direction: field('payable'), invoiceNumber: field('INV-P-2048'),
    customerName: field('Cedar Studio'),
  });
  assert.equal(result.direction.value, 'payable');
  assert.equal(result.reviewRequired, true);
});

test('valid PDF with unclear parties preserves uncertain direction', async () => {
  const result = await extractFixture('uncertain_direction', {
    direction: field('uncertain', 0.3), invoiceNumber: field('INV-U-3048'),
  });
  assert.equal(result.direction.value, 'uncertain');
  assert.ok(result.uncertainFields.includes('direction'));
});

test('valid zero-total PDF keeps the zero value for the save-time eligibility check', async () => {
  const result = await extractFixture('zero_total', {
    invoiceNumber: field('INV-Z-4048'), subtotal: field(0), tax: field(0),
    total: field(0), outstandingAmount: field(0),
  });
  assert.equal(result.total.value, 0);
  assert.equal(result.outstandingAmount.value, 0);
});

test('valid PDF with a printed rounding adjustment gets a review notice, not a false mismatch', async () => {
  const result = await extractFixture('rounding_adjustment', {
    invoiceNumber: field('INV-A-5048'), tax: field(17.99),
  });
  assert.ok(result.warnings.some((warning) => /one minor currency unit.*rounding adjustment/i.test(warning)));
  assert.equal(result.warnings.some((warning) => /Subtotal plus tax does not match total/i.test(warning)), false);
});
