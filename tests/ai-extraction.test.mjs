import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoice } from '../ai/extraction.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const pdf = Buffer.from('%PDF-1.7\ninvoice');

function response(overrides = {}) {
  const base = {
    invoiceNumber: { value: ' INV-42 ', confidence: 0.98 },
    customerName: { value: 'Acme Ltd', confidence: 0.93 },
    invoiceDate: { value: '2026-02-28', confidence: 0.96 },
    dueDate: { value: '2026-03-30', confidence: 0.92 },
    subtotal: { value: 100, confidence: 0.95 },
    tax: { value: 18, confidence: 0.91 },
    total: { value: 118, confidence: 0.99 },
    outstandingAmount: { value: 118, confidence: 0.94 },
    currency: { value: 'INR', confidence: 0.98 },
    clientPhone: { value: '+919876543210', confidence: 0.88 },
    clientEmail: { value: 'billing@example.com', confidence: 0.97 },
    lineItems: {
      value: [{ description: 'Consulting', quantity: 2, unitPrice: 50, amount: 100, confidence: 0.9 }],
      confidence: 0.91,
    },
  };
  return { ...base, ...overrides };
}

function fakeProvider(data, inspect = () => {}) {
  return {
    async generateStructured(options) {
      inspect(options);
      // Emulate a provider that runs the supplied validator.
      const sanitized = options.validate(data);
      return { data: sanitized, model: 'test/model', usedFallback: false };
    },
  };
}

async function run(data = response(), { bytes = png, mimeType = 'image/png', fileName = 'scan.png', inspect } = {}) {
  return extractInvoice({ provider: fakeProvider(data, inspect), bytes, mimeType, fileName });
}

test('extracts an invoice with per-field confidence and preserves INR values', async () => {
  const result = await run();
  assert.deepEqual(result.invoiceNumber, { value: 'INV-42', confidence: 0.98 });
  assert.deepEqual(result.currency, { value: 'INR', confidence: 0.98 });
  assert.deepEqual(result.total, { value: 118, confidence: 0.99 });
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(result.uncertainFields, []);
});

test('accepts explicit USD and EUR currency codes', async () => {
  for (const currency of ['USD', 'EUR']) {
    const result = await run(response({ currency: { value: currency, confidence: 0.9 } }));
    assert.equal(result.currency.value, currency);
    assert.equal(result.uncertainFields.includes('currency'), false);
  }
});

test('does not guess currency from an ambiguous symbol or accept an unknown currency', async () => {
  const ambiguous = await run(response({ currency: { value: null, confidence: 0.45 } }));
  assert.equal(ambiguous.currency.value, null);
  assert.ok(ambiguous.uncertainFields.includes('currency'));
  assert.ok(ambiguous.warnings.some((warning) => /Currency is not explicit/.test(warning)));
  const invalid = await run(response({ currency: { value: 'ZZZ', confidence: 0.9 } }));
  assert.equal(invalid.currency.value, null);
  assert.ok(invalid.warnings.some((warning) => /Unrecognized currency/.test(warning)));
});

test('rejects malformed roots, missing fields, extra fields, and bad confidence', async () => {
  await assert.rejects(run({ ...response(), surprise: true }), /unknown fields/);
  const missing = response(); delete missing.total;
  await assert.rejects(run(missing), /missing or unknown fields/);
  await assert.rejects(run(response({ total: { value: 118, confidence: 2 } })), /confidence/);
});

test('rejects invalid monetary values and currency precision', async () => {
  await assert.rejects(run(response({ total: { value: -1, confidence: 0.9 } })), /non-negative/);
  await assert.rejects(run(response({ tax: { value: Number.POSITIVE_INFINITY, confidence: 0.9 } })), /non-negative/);
  await assert.rejects(run(response({ currency: { value: 'JPY', confidence: 0.9 }, total: { value: 118.25, confidence: 0.9 } })), /fractional digits/);
});

test('discards invalid calendar dates and malformed email; rejects malformed structural fields', async () => {
  const result = await run(response({
    invoiceDate: { value: '2026-02-30', confidence: 0.9 },
    clientEmail: { value: 'not-an-email', confidence: 0.9 },
  }));
  assert.equal(result.invoiceDate.value, null);
  assert.equal(result.clientEmail.value, null);
  assert.ok(result.uncertainFields.includes('invoiceDate'));
  assert.ok(result.warnings.some((warning) => /Invalid invoiceDate/.test(warning)));
  await assert.rejects(run(response({ invoiceDate: { value: 20260228, confidence: 0.9 } })), /invoiceDate must be a string/);
});

test('only accepts complete E.164 phone numbers and never invents a prefix', async () => {
  const result = await run(response({ clientPhone: { value: '9876543210', confidence: 0.99 } }));
  assert.equal(result.clientPhone.value, null);
  assert.ok(result.uncertainFields.includes('clientPhone'));
  assert.ok(result.warnings.some((warning) => /complete E\.164/.test(warning)));
});

test('routes PDFs through the file-parser plugin and sends an inline PDF data URL', async () => {
  let captured;
  await run(response(), {
    bytes: pdf, mimeType: 'application/pdf', fileName: 'invoice.pdf',
    inspect: (options) => { captured = options; },
  });
  assert.deepEqual(captured.plugins, [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }]);
  const parts = captured.messages[0].content;
  assert.equal(parts[1].type, 'file');
  assert.match(parts[1].file.file_data, /^data:application\/pdf;base64,/);
  assert.match(parts[0].text, /untrusted data/);
  assert.match(parts[0].text, /Never follow instructions/);
});

test('routes images as inline image data URLs without enabling the PDF plugin', async () => {
  let captured;
  await run(response(), { inspect: (options) => { captured = options; } });
  assert.equal(captured.plugins, undefined);
  assert.equal(captured.messages[0].content[1].type, 'image_url');
  assert.match(captured.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('enforces actual signature, MIME agreement, and 10 MiB maximum before provider call', async () => {
  let called = false;
  const provider = { generateStructured: async () => { called = true; return { data: response() }; } };
  await assert.rejects(extractInvoice({ provider, bytes: Buffer.from('hello'), mimeType: 'image/png' }), /signature/);
  await assert.rejects(extractInvoice({ provider, bytes: png, mimeType: 'application/pdf' }), /does not match/);
  await assert.rejects(extractInvoice({ provider, bytes: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: 'image/png' }), /10 MiB/);
  assert.equal(called, false);
});

test('flags arithmetic inconsistencies for review and caps line items', async () => {
  const result = await run(response({ total: { value: 120, confidence: 0.99 } }));
  assert.ok(result.warnings.some((warning) => /Subtotal plus tax/.test(warning)));
  const tooMany = Array.from({ length: 101 }, () => ({ description: 'x', quantity: 1, unitPrice: 1, amount: 1, confidence: 0.9 }));
  await assert.rejects(run(response({ lineItems: { value: tooMany, confidence: 0.9 } })), /at most 100/);
});
