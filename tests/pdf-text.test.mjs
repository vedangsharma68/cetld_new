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

test('supplied two-page invoice reaches AI as bounded selectable text with all item rows', {skip: !process.env.CETLD_TEST_PDF_PATH}, async () => {
  const bytes = await readFile(process.env.CETLD_TEST_PDF_PATH);
  const text = await extractPdfText(bytes);
  assert.match(text, /BPXINV-00550/);
  assert.match(text, /Page 2 of 2/);
  assert.equal((text.match(/BPXPN\s*-\s*\d{5}/g) || []).length, 28);
  let sent;
  const marker = new Error('captured');
  await assert.rejects(extractInvoice({
    provider: {generateStructured: async options => {sent = options.messages; throw marker;}},
    bytes, mimeType: 'application/pdf', fileName: 'invoice-0-4.pdf', businessName: 'CETLD QA',
  }), error => error === marker);
  assert.equal(typeof sent[0].content, 'string');
  assert.match(sent[0].content, /BPXINV-00550/);
  assert.match(sent[0].content, /Cavia porcellus hair/);
});
