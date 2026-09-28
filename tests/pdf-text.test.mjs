import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractPdfText} from '../ai/pdf-text.mjs';
import {extractInvoice} from '../ai/extraction.mjs';

test('invalid or image-only PDF bytes leave text extraction unavailable', async () => {
  assert.equal(await extractPdfText(Buffer.from('%PDF- invalid')), null);
});

test('PDF text parsing is bounded even when the parser never resolves', async () => {
  let destroyed = false;
  const started = Date.now();
  const text = await extractPdfText(Buffer.from('%PDF-1.7'), {
    timeoutMs: 5,
    getDocumentImpl: () => ({promise: new Promise(() => {}), destroy: async () => {destroyed = true;}}),
  });
  assert.equal(text, null);
  assert.equal(destroyed, true);
  assert.ok(Date.now() - started < 1000);
});

test('supplied two-page invoice is extracted from printed text without a provider', {skip: !process.env.CETLD_TEST_PDF_PATH}, async () => {
  const bytes = await readFile(process.env.CETLD_TEST_PDF_PATH);
  const text = await extractPdfText(bytes);
  assert.match(text, /BPXINV-00550/);
  assert.match(text, /Page 2 of 2/);
  assert.equal((text.match(/BPXPN\s*-\s*\d{5}/g) || []).length, 28);
  let providerCalls = 0;
  const result = await extractInvoice({
    provider: {generateStructured: async () => {providerCalls += 1; throw new Error('provider should not be called');}},
    bytes, mimeType: 'application/pdf', fileName: 'invoice-0-4.pdf', businessName: 'CETLD QA',
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.model, 'verified-pdf-text');
  assert.equal(result.invoiceNumber.value, 'BPXINV-00550');
  assert.equal(result.lineItems.value.length, 28);
  assert.equal(result.subtotal.value, 5964.5);
  assert.equal(result.tax.value, 596.45);
  assert.equal(result.total.value, 6610.95);
  assert.equal(result.currency.value, null);
  assert.equal(result.dueDate.value, null);
});
