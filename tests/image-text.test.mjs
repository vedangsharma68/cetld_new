import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {parseOfflineInvoiceText} from '../ai/image-text.mjs';
import {extractInvoice} from '../ai/extraction.mjs';

const workshopInvoiceText = `Tax Invoice
Job #: 53926
ABC Electrical Registration WPFS88
ABN. 71 165 417 000
Item Description Quantity Unit Price Total
LABOUR 3.00 $130.00 $390.00
Labour Total $390.00
OIL FILTER 1.00 $20.00 $20.00
AIR HOSE 1.00 $37.11 $37.71
AIR FILTER 1.00 $15.00 $15.00
Parts Total $72.71
OIL 1.00 $10.00 $10.00
Consumables Total $10.00
Subtotal $430.61
Rounding $-0.01
GST $42.10
Total $472.70
Payment Terms: C.O.D. Balance Due $472.70`;

test('offline invoice parsing reads labelled totals and preserves raw OCR text for review', () => {
  const result = parseOfflineInvoiceText(workshopInvoiceText, {ocrConfidence: 82});

  assert.equal(result.subtotal.value, 430.61);
  assert.equal(result.tax.value, 42.10);
  assert.equal(result.total.value, 472.70);
  assert.equal(result.outstandingAmount.value, 472.70);
  assert.equal(result.ocr.text, workshopInvoiceText);
  assert.equal(result.ocr.confidence, 82);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.currency.value, null, 'a dollar symbol alone must not infer AUD or USD');
  assert.equal(result.direction.value, 'uncertain');
  assert.ok(['subtotal', 'tax', 'total', 'outstandingAmount', 'currency', 'direction'].every(field => result.uncertainFields.includes(field)));
  assert.ok(result.warnings.some(warning => /review/i.test(warning)));
});

test('offline invoice parsing extracts detail rows without mistaking section totals for items', () => {
  const result = parseOfflineInvoiceText(workshopInvoiceText, {ocrConfidence: 82});

  assert.deepEqual(result.lineItems.value.map(({description, quantity, unitPrice, amount}) => ({description, quantity, unitPrice, amount})), [
    {description: 'LABOUR', quantity: 3, unitPrice: 130, amount: 390},
    {description: 'OIL FILTER', quantity: 1, unitPrice: 20, amount: 20},
    {description: 'AIR HOSE', quantity: 1, unitPrice: 37.11, amount: 37.71},
    {description: 'AIR FILTER', quantity: 1, unitPrice: 15, amount: 15},
    {description: 'OIL', quantity: 1, unitPrice: 10, amount: 10},
  ]);
  assert.ok(result.uncertainFields.includes('lineItems'));
});

test('offline invoice parsing leaves unlabelled money and invalid OCR confidence uncertain', () => {
  const result = parseOfflineInvoiceText('Amounts: $91.00 and $99.00', {ocrConfidence: Number.NaN});

  assert.equal(result.total.value, null);
  assert.equal(result.subtotal.value, null);
  assert.equal(result.tax.value, null);
  assert.equal(result.ocr.confidence, null);
  assert.ok(result.uncertainFields.includes('total'));
  assert.equal(result.reviewRequired, true);
});

test('the supplied image reaches review with printed totals before provider timeout', {skip: !process.env.CETLD_TEST_IMAGE_PATH}, async () => {
  const bytes = await readFile(process.env.CETLD_TEST_IMAGE_PATH);
  let providerCalls = 0;
  const result = await extractInvoice({
    bytes, mimeType: 'image/png', fileName: 'workshop-invoice.png', businessName: 'CETLD QA',
    provider: {generateStructured: async () => {providerCalls += 1; throw new Error('provider should not be called');}},
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.subtotal.value, 430.61);
  assert.equal(result.tax.value, 42.1);
  assert.equal(result.total.value, 472.7);
  assert.equal(result.outstandingAmount.value, 472.7);
  assert.equal(result.lineItems.value.length, 5);
  assert.equal(result.currency.value, null);
  assert.equal(result.direction.value, 'uncertain');
  assert.equal(result.reviewRequired, true);
  assert.equal(result.ocr, undefined);
});
