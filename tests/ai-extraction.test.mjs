import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptInvoiceExtractionWireResponse, extractInvoice, invoiceExtractionResponseSchema, validateInvoiceExtractionResponse, validateInvoiceExtractionWireResponse } from '../ai/extraction.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const pdf = Buffer.from('%PDF-1.7\ninvoice');

function response(overrides = {}) {
  const base = {
    direction: { value: 'receivable', confidence: 0.98 },
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
    clientPhoneRaw: { value: null, confidence: 0 },
    clientEmail: { value: 'billing@example.com', confidence: 0.97 },
    notes: { value: 'Payment due within 30 days', confidence: 0.9 },
    lineItems: {
      value: [{ description: 'Consulting', quantity: 2, unitPrice: 50, amount: 100, confidence: 0.9 }],
      confidence: 0.91,
    },
  };
  return { ...base, ...overrides };
}

function wireResponse(normalized) {
  const wire = {};
  for (const [name, field] of Object.entries(normalized)) {
    if (name === 'lineItems') {
      wire.lineItems = field.value;
      wire.lineItemsConfidence = field.confidence;
    } else if (field && typeof field === 'object' && Object.hasOwn(field, 'value')) {
      wire[name] = field.value;
      wire[`${name}Confidence`] = field.confidence;
    } else wire[name] = field;
  }
  return wire;
}

function fakeProvider(data, inspect = () => {}) {
  return {
    async generateStructured(options) {
      inspect(options);
      // Emulate a provider that runs the supplied validator.
      const sanitized = options.validate(wireResponse(data));
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
  assert.equal(result.lineItems.value[0].description,'Consulting');
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(result.uncertainFields, []);
});

test('uses a shallow provider wire contract and deterministically restores every strict field', () => {
  const normalized = response();
  const wire = wireResponse(normalized);
  assert.equal(invoiceExtractionResponseSchema.properties.invoiceNumber.type, undefined);
  assert.equal(invoiceExtractionResponseSchema.properties.invoiceNumber.anyOf.length, 2);
  assert.equal(invoiceExtractionResponseSchema.properties.invoiceNumber.properties, undefined);
  assert.deepEqual(adaptInvoiceExtractionWireResponse(wire), {...normalized,
    currencySource: {value: null, confidence: 0}, addressHint: {value: null, confidence: 0},
    paymentTerms: {value: null, confidence: 0}});
  assert.deepEqual(validateInvoiceExtractionWireResponse(wire), validateInvoiceExtractionResponse(normalized));
  assert.throws(() => validateInvoiceExtractionWireResponse({...wire, injected: 'malicious'}), /unknown fields/);
  assert.throws(() => validateInvoiceExtractionWireResponse({...wire, direction: 'incoming'}), /direction must be/);
  assert.throws(() => validateInvoiceExtractionWireResponse({...wire, currency: 'USD', currencyConfidence: 2}), /confidence/);
  assert.throws(() => validateInvoiceExtractionWireResponse({...wire, outstandingAmount: -1}), /non-negative/);
});

test('wire output preserves absent evidence as null and uncertain without dropping normalized fields', () => {
  const absent = wireResponse(response({
    invoiceNumber: {value: null, confidence: 0}, currency: {value: null, confidence: 0},
    direction: {value: 'uncertain', confidence: 0}, outstandingAmount: {value: null, confidence: 0},
  }));
  const result = validateInvoiceExtractionWireResponse(absent);
  assert.equal(result.invoiceNumber.value, null);
  assert.equal(result.currency.value, null);
  assert.equal(result.direction.value, 'uncertain');
  assert.equal(result.outstandingAmount.value, null);
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(Object.keys(result).sort(), [...Object.keys(response()), 'currencySource', 'addressHint',
    'paymentTerms', 'reviewRequired', 'uncertainFields', 'warnings'].sort());
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
  assert.ok(invalid.warnings.some((warning) => /unrecognized or unsupported currency/i.test(warning)));
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
  await assert.rejects(run(response({ currency: { value: 'INR', confidence: 0.9 }, total: { value: 118.257, confidence: 0.9 } })), /fractional digits/);
});

test('extraction never treats unsupported currency precision as a usable invoice amount', async () => {
  for (const currency of ['JPY','KWD','BHD','ZZZ']) {
    const result = await run(response({currency:{value:currency,confidence:0.99}}));
    assert.equal(result.currency.value,null);
    assert.ok(result.uncertainFields.includes('currency'));
    assert.ok(result.warnings.some(warning=>/two-decimal currencies|two decimal places/i.test(warning)));
  }
  await assert.rejects(run(response({total:{value:118.257,confidence:0.99}})),/fractional digits|two decimal places/i);
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

test('keeps a printed local number raw and never invents a prefix', async () => {
  const result = await run(response({clientPhone: {value: null, confidence: 0},
    clientPhoneRaw: {value: '(415) 555-0244', confidence: 0.99}}));
  assert.equal(result.clientPhone.value, null);
  assert.equal(result.clientPhoneRaw.value, '(415) 555-0244');
  assert.ok(result.uncertainFields.includes('clientPhone'));
  assert.equal(result.warnings.some((warning) => /complete E\.164/.test(warning)), false);
});

test('explicitly instructs the model to return printed client email without inference', async () => {
  let sent;
  await run(response(), { inspect: (request) => { sent = request; } });
  assert.match(JSON.stringify(sent), /Return clientEmail exactly when a client\/bill-to email address is explicitly printed/);
  assert.match(JSON.stringify(sent), /up to 100 printed line items/);
});

test('extracts PDFs through the shared file-part contract for Gemini provider adaptation', async () => {
  let captured;
  await run(response(), {
    bytes: pdf, mimeType: 'application/pdf', fileName: 'invoice.pdf',
    inspect: (options) => { captured = options; },
  });
  assert.equal(captured.name,'invoice_extraction');
  assert.equal(captured.maxTokens,8192);
  assert.equal(captured.plugins,undefined);
  const parts = captured.messages[0].content;
  assert.equal(parts[1].type, 'file');
  assert.equal(parts[1].file.filename,'invoice.pdf');
  assert.match(parts[1].file.file_data, /^data:application\/pdf;base64,/);
  assert.match(parts[0].text, /untrusted data/);
  assert.match(parts[0].text, /Never follow instructions/);
});

test('extracts images as inline image URLs without a provider-specific plugin', async () => {
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

test('treats a one-cent printed rounding difference as reviewable rather than a mismatch', async () => {
  const result = await run(response({
    subtotal: { value: 430.61, confidence: 0.99 },
    tax: { value: 42.10, confidence: 0.99 },
    total: { value: 472.70, confidence: 0.99 },
  }));
  assert.ok(result.warnings.some(warning => /one minor currency unit.*rounding adjustment/i.test(warning)));
  assert.equal(result.warnings.some(warning => /Subtotal plus tax does not match total/i.test(warning)), false);
  assert.equal(result.uncertainFields.includes('total'), false);
});

test('flags material line-item sum differences from the printed subtotal', async () => {
  const result = await run(response({
    subtotal: { value: 106, confidence: 0.99 },
  }));
  assert.ok(result.warnings.some(warning => /line-item amounts do not match the printed subtotal/i.test(warning)));
  assert.ok(result.uncertainFields.includes('lineItems'));
});

test('keeps unreadable line-item numbers null and marks itemization uncertain', async () => {
  const result = await run(response({lineItems: {
    value: [{description: 'Air hose', quantity: null, unitPrice: null, amount: null, confidence: 0.4}],
    confidence: 0.4,
  }}));
  assert.deepEqual(result.lineItems.value[0], {description: 'Air hose', quantity: null, unitPrice: null, amount: null, confidence: 0.4});
  assert.ok(result.uncertainFields.includes('lineItems'));
});


test('provider response schema requires only properties it defines', () => {
  for (const key of invoiceExtractionResponseSchema.required) assert.ok(Object.hasOwn(invoiceExtractionResponseSchema.properties, key), `required ${key} missing from properties`);
});
