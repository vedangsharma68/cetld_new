import assert from 'node:assert/strict';
import test from 'node:test';
import {invoiceWire} from './invoice-wire-fixture.mjs';
import {readFile} from 'node:fs/promises';
import {extractInvoiceFromImage, parseOfflineInvoiceText} from '../ai/image-text.mjs';
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

test('offline OCR reads split Indian tax and rupee amounts without inferring currency', () => {
  const result = parseOfflineInvoiceText('Subtotal ₹1,000.00\nCGST 9% ₹90.00\nSGST 9% ₹90.00\nTotal ₹1,180.00', {ocrConfidence: 85});
  assert.equal(result.subtotal.value, 1000);
  assert.equal(result.tax.value, 180);
  assert.equal(result.total.value, 1180);
  assert.equal(result.currency.value, null);
  assert.ok(result.uncertainFields.includes('tax'));
});

test('offline OCR leaves absent tax blank on a tax-free document', () => {
  const result = parseOfflineInvoiceText('Subtotal ₹100.00\nTotal ₹100.00', {ocrConfidence: 85});
  assert.equal(result.subtotal.value, 100);
  assert.equal(result.tax.value, null);
  assert.equal(result.total.value, 100);
  assert.equal(result.reviewRequired, true);
});

const tinyPng = Buffer.from([137,80,78,71,13,10,26,10,0]);

test('OCR startup rejection releases the queue for the next image', async () => {
  await assert.rejects(extractInvoiceFromImage({bytes: tinyPng, mimeType: 'image/png',
    preprocessor: async bytes => bytes, workerFactory: async () => { throw Object.assign(new Error('missing wasm'), {code: 'ENOENT'}); },
    timeoutMs: 30}), /missing wasm/);
  const result = await extractInvoiceFromImage({bytes: tinyPng, mimeType: 'image/png', preprocessor: async bytes => bytes,
    workerFactory: async () => ({recognize: async () => ({data: {text: 'Total 10.00', confidence: 80}}), terminate: async () => {}}), timeoutMs: 30});
  assert.equal(result.total.value, 10);
});

test('hung OCR worker is terminated and cannot poison later queued jobs', async () => {
  let terminated = 0;
  await assert.rejects(extractInvoiceFromImage({bytes: tinyPng, mimeType: 'image/png', preprocessor: async bytes => bytes,
    workerFactory: async () => ({recognize: async () => new Promise(() => {}), terminate: async () => { terminated++; }}),
    timeoutMs: 20}), /execution limit/);
  assert.ok(terminated >= 1);
  const result = await extractInvoiceFromImage({bytes: tinyPng, mimeType: 'image/png', preprocessor: async bytes => bytes,
    workerFactory: async () => ({recognize: async () => ({data: {text: 'Subtotal 9.00\nTotal 9.00', confidence: 90}}), terminate: async () => {}}), timeoutMs: 30});
  assert.equal(result.total.value, 9);
});

test('OCR queue wait and preprocessing share the deadline and clean up on cancellation', async () => {
  let releaseRecognition, markRecognitionStarted;
  const recognitionStarted = new Promise(resolve => { markRecognitionStarted = resolve; });
  const first = extractInvoiceFromImage({bytes: tinyPng, mimeType: 'image/png', preprocessor: async bytes => bytes,
    workerFactory: async () => ({recognize: async () => new Promise(resolve => { releaseRecognition = resolve; markRecognitionStarted(); }), terminate: async () => {}}),
    timeoutMs: 5_000});
  await recognitionStarted;
  let secondStarted = false;
  await assert.rejects(extractInvoiceFromImage({bytes: tinyPng, mimeType: 'image/png', preprocessor: async bytes => bytes,
    workerFactory: async () => { secondStarted = true; return {}; }, timeoutMs: 5}), /execution limit|deadline/);
  assert.equal(secondStarted, false);
  releaseRecognition?.({data:{text:'Total 1.00',confidence:80}});
  await first;

  const controller = new AbortController();
  let cleaned = false, workerStarted = false, markPreprocessingStarted;
  const preprocessingStarted = new Promise(resolve => { markPreprocessingStarted = resolve; });
  const preprocessing = extractInvoiceFromImage({bytes: tinyPng, mimeType: 'image/png', signal: controller.signal, timeoutMs: 5_000,
    preprocessor: (_bytes,{signal}) => new Promise((_resolve,reject) => {
      signal.addEventListener('abort',()=>{cleaned=true;reject(new Error('cleaned'));},{once:true});
      markPreprocessingStarted();
    }),
    workerFactory: async () => { workerStarted=true; return {}; }});
  await preprocessingStarted;
  controller.abort();
  await assert.rejects(preprocessing, /aborted|cleaned/);
  assert.equal(cleaned, true);
  assert.equal(workerStarted, false);
});

test('an expired image deadline starts neither preprocessing nor OCR', async () => {
  let starts=0;
  await assert.rejects(extractInvoiceFromImage({bytes: tinyPng,mimeType:'image/png',deadlineAt:Date.now()-1,
    preprocessor:async bytes=>{starts++;return bytes;},workerFactory:async()=>{starts++;return {};}}),/deadline/);
  assert.equal(starts,0);
});

test('OCR failure reaches vision extraction with all required invoice fields', async () => {
  let visionCalls = 0;
  const raw = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientPhoneRaw','clientEmail','notes','direction']
    .map(name => [name, {value: ({invoiceNumber:'INV-8',customerName:'Buyer',invoiceDate:'2026-10-01',total:25,currency:'INR',direction:'receivable'})[name] ?? null, confidence: .99}]));
  raw.lineItems = {value: [], confidence: .99};
  const result = await extractInvoice({bytes: tinyPng, mimeType: 'image/png', fileName: 'invoice.png', businessName: 'Seller',
    imageExtractor: async () => { throw Object.assign(new Error('wasm unavailable'), {code: 'ENOENT'}); },
    provider: {generateStructured: async ({validate}) => { visionCalls++; return {data: validate(invoiceWire(raw)), model: 'vision', usedFallback: false}; }}});
  assert.equal(visionCalls, 1);
  assert.equal(result.invoiceNumber.value, 'INV-8');
  assert.equal(result.direction.value, 'receivable');
});

test('subtotal and total from real offline parsing do not short-circuit vision extraction', async () => {
  let visionCalls = 0;
  const offline = parseOfflineInvoiceText('Subtotal 100.00\nTax 18.00\nTotal 118.00', {ocrConfidence: 96});
  const raw = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientPhoneRaw','clientEmail','notes','direction']
    .map(name => [name, {value: ({invoiceNumber:'INV-9',customerName:'Buyer Co',invoiceDate:'2026-10-01',subtotal:100,tax:18,total:118,currency:'INR',direction:'receivable'})[name] ?? null, confidence: .98}]));
  raw.lineItems = {value: [], confidence: .8};
  const result = await extractInvoice({bytes: tinyPng, mimeType: 'image/png', fileName: 'invoice.png', businessName: 'Seller',
    imageExtractor: async () => offline,
    provider: {generateStructured: async ({messages, validate}) => {
      visionCalls++;
      assert.equal(messages[0].content[1].type, 'image_url');
      return {data: validate(invoiceWire(raw)), model: 'vision', usedFallback: false};
    }}});
  assert.equal(visionCalls, 1);
  assert.equal(result.invoiceNumber.value, 'INV-9');
  assert.equal(result.currency.value, 'INR');
});

test('the supplied image reaches review with printed totals before provider timeout', {skip: !process.env.CETLD_TEST_IMAGE_PATH}, async () => {
  const bytes = await readFile(process.env.CETLD_TEST_IMAGE_PATH);
  let providerCalls = 0;
  const result = await extractInvoice({
    bytes, mimeType: 'image/png', fileName: 'workshop-invoice.png', businessName: 'CETLD QA',
    provider: {generateStructured: async () => {providerCalls += 1; throw new Error('provider should not be called');}},
  });
  assert.equal(providerCalls, 1);
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
