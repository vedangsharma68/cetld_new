import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {access} from 'node:fs/promises';
import {createRequire} from 'node:module';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 12_000_000;
const MAX_TEXT_CHARS = 100_000;
const FIELD_CONFIDENCE_CAP = 0.69;
const MODEL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/tessdata');
const require = createRequire(import.meta.url);
const DEFAULT_OCR_TIMEOUT_MS = 8_000;
const UNCERTAIN_FIELDS = [
  'invoiceNumber', 'customerName', 'invoiceDate', 'dueDate', 'subtotal', 'tax', 'total',
  'outstandingAmount', 'currency', 'clientPhone', 'clientEmail', 'notes', 'direction', 'lineItems',
];
const CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'CHF']);

let workerPromise;
let ocrQueue = Promise.resolve();

async function assertOcrAssets() {
  const coreDirectory = path.dirname(require.resolve('tesseract.js-core/package.json'));
  await Promise.all([
    access(path.join(coreDirectory, 'tesseract-core-relaxedsimd.wasm')),
    access(path.join(MODEL_PATH, 'eng.traineddata')),
  ]);
}

function boundedOcr(operation, timeoutMs, onTimeout, signal) {
  if (signal?.aborted || timeoutMs <= 0) return Promise.reject(new Error('OCR execution deadline expired'));
  let timer;
  let abort;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.(); } catch { /* best-effort worker disposal */ }
        reject(new Error(`OCR exceeded its ${timeoutMs}ms execution limit`));
      }, timeoutMs);
    }),
    new Promise((_, reject) => {
      abort = () => { try { onTimeout?.(); } catch {} reject(new Error('OCR execution aborted')); };
      signal?.addEventListener('abort', abort, {once: true});
    }),
  ]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

function timeLeft(deadlineAt, timeoutMs) {
  return Number.isFinite(deadlineAt) ? Math.max(0, Math.min(timeoutMs, deadlineAt - Date.now())) : timeoutMs;
}

function fail(message) {
  throw new TypeError(`Invoice image OCR: ${message}`);
}

function checkedImage(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('bytes must be a Buffer or Uint8Array');
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) fail('image must be between 1 byte and 10 MiB');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let detected;
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detected = 'image/png';
  else if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) detected = 'image/jpeg';
  else if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') detected = 'image/webp';
  else fail('unsupported or invalid image signature (PNG, JPEG, or WebP required)');
  const supplied = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const normalized = supplied === 'image/jpg' ? 'image/jpeg' : supplied;
  if (normalized !== detected) fail('declared MIME type does not match image signature');
  return {data, detected};
}

function safeConfidence(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function field(value, confidence) {
  if (value === null || value === undefined) return {value: null, confidence: 0};
  return {value, confidence: confidence === null ? 0 : Math.min(FIELD_CONFIDENCE_CAP, Math.max(0.2, confidence / 100))};
}

function amountFromLine(lines, labelPattern) {
  const match = lines.map(line => line.match(labelPattern)).find(Boolean);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) ? value : null;
}

function parseLineItems(lines, confidence) {
  const excluded = /^(?:labour|labor|parts?|consumables?|subs*total|subtotal|tax|gst|vat|total|balance due|amount due|rounding)\s*total\b/i;
  const itemPattern = /^\s*(?<description>[\p{L}\p{N}][\p{L}\p{N} &'().,/+-]{0,119}?)\s+(?<quantity>\d+(?:\.\d{1,4})?)\s+\$?\s*(?<unitPrice>\d[\d,]*(?:\.\d{1,2})?)\s+\$?\s*(?<amount>\d[\d,]*(?:\.\d{1,2})?)\s*$/u;
  const headerIndex = lines.findIndex(line => /\bitem\b/i.test(line) && /\bdescription\b/i.test(line) && /\bquantity\b/i.test(line) && /\bunit\s*price\b/i.test(line) && /\btotal\b/i.test(line));
  if (headerIndex < 0) return [];
  const output = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const match = line.match(itemPattern);
    if (!match || excluded.test(match.groups.description.trim())) continue;
    const quantity = Number(match.groups.quantity);
    const unitPrice = Number(match.groups.unitPrice.replaceAll(',', ''));
    const amount = Number(match.groups.amount.replaceAll(',', ''));
    if (![quantity, unitPrice, amount].every(Number.isFinite) || quantity < 0 || unitPrice < 0 || amount < 0) continue;
    if (![unitPrice, amount].every(value => Number.isSafeInteger(Math.round(value * 100)))) continue;
    output.push({description: match.groups.description.trim(), quantity, unitPrice, amount, confidence: confidence === null ? 0 : Math.min(FIELD_CONFIDENCE_CAP, confidence / 100)});
    if (output.length >= 100) break;
  }
  return output;
}

/** Parse only explicitly labelled invoice totals and table-like line rows from OCR text. */
export function parseOfflineInvoiceText(text, {ocrConfidence} = {}) {
  if (typeof text !== 'string') fail('OCR text must be a string');
  const cleanText = text.replace(/\r\n?/g, '\n').slice(0, MAX_TEXT_CHARS);
  const lines = cleanText.split('\n');
  const confidence = safeConfidence(ocrConfidence);
  const money = String.raw`[₹$€£]?\s*(-?\d[\d,]*(?:\.\d{1,2})?)`;
  const subtotal = amountFromLine(lines, new RegExp(`^\\s*subtotal\\s*:?\\s*${money}\\s*$`, 'i'));
  const components = ['CGST', 'SGST', 'IGST'].map(label => amountFromLine(lines,
    new RegExp(`^\\s*${label}(?:\\s+\\d+(?:\\.\\d+)?\\s*%)?\\s*:?\\s*${money}\\s*$`, 'i'))).filter(value => value !== null);
  const tax = components.length ? Math.round(components.reduce((sum, value) => sum + value, 0) * 100) / 100
    : amountFromLine(lines, new RegExp(`^\\s*(?:GST|sales\\s+tax|tax|VAT)(?:\\s+\\d+(?:\\.\\d+)?\\s*%)?\\s*:?\\s*${money}\\s*$`, 'i'));
  const total = amountFromLine(lines, new RegExp(`^\\s*total\\s*:?\\s*${money}\\s*$`, 'i'));
  const outstandingAmount = amountFromLine(lines, new RegExp(`\\b(?:balance\\s+due|amount\\s+due|outstanding(?:\\s+amount)?)\\s*:?\\s*${money}`, 'i'));
  const printedRounding = lines.map(line => line.match(/^\s*rounding\s*:?\s*[₹$€£]?\s*(-?\d[\d,]*(?:\.\d{1,2})?)\s*$/i)?.[1]).find(Boolean);
  const rounding = printedRounding === undefined ? null : Number(printedRounding.replaceAll(',', ''));
  const explicitCurrency = cleanText.match(/\bcurrency(?:\s+code)?\s*[:=-]\s*(INR|USD|EUR|GBP|AED|SGD|AUD|CAD|CHF)\b/i)?.[1]?.toUpperCase() || null;
  const currency = explicitCurrency && CURRENCIES.has(explicitCurrency) ? explicitCurrency : null;
  const lineItems = parseLineItems(lines, confidence);
  const warnings = [
    'Offline OCR is a draft. Review every extracted value against the image before saving.',
    'Direction is uncertain; confirm whether your business issued this invoice.',
  ];
  if (currency === null) warnings.push('Currency code was not explicitly printed; confirm the currency.');
  if (subtotal !== null && tax !== null && total !== null && Math.abs(subtotal + tax - total) > 0.005) {
    warnings.push(rounding !== null && Number.isFinite(rounding) && Math.abs(subtotal + tax + rounding - total) < 0.005
      ? 'Printed rounding reconciles the subtotal, tax, and total; verify it against the image.'
      : 'Subtotal plus tax does not match total; check any printed rounding.');
  }
  if (lineItems.length === 0) warnings.push('No line items could be read reliably.');

  return {
    invoiceNumber: field(null, confidence),
    customerName: field(null, confidence),
    invoiceDate: field(null, confidence),
    dueDate: field(null, confidence),
    subtotal: field(subtotal, confidence),
    tax: field(tax, confidence),
    total: field(total, confidence),
    outstandingAmount: field(outstandingAmount, confidence),
    currency: field(currency, confidence),
    clientPhone: field(null, confidence),
    clientEmail: field(null, confidence),
    notes: field(null, confidence),
    direction: {value: 'uncertain', confidence: 0},
    lineItems: {
      value: lineItems,
      confidence: lineItems.length && confidence !== null ? Math.min(FIELD_CONFIDENCE_CAP, confidence / 100) : 0,
    },
    uncertainFields: [...UNCERTAIN_FIELDS],
    warnings: [...new Set(warnings)],
    reviewRequired: true,
    ocr: {text: cleanText, confidence},
    model: 'tesseract.js-eng-offline',
    usedFallback: true,
  };
}

async function getWorker(workerFactory, timeoutMs, signal) {
  if (workerFactory) {
    const startingWorker = Promise.resolve().then(workerFactory);
    return boundedOcr(startingWorker, timeoutMs, () => {
      startingWorker.then(worker => worker?.terminate?.()).catch(() => {});
    }, signal);
  }
  if (!workerPromise) {
    workerPromise = assertOcrAssets().then(() => import('tesseract.js')).then(({createWorker}) => createWorker('eng', 1, {
        langPath: MODEL_PATH,
        gzip: false,
        cacheMethod: 'none',
      }));
    const startingWorker = workerPromise;
    workerPromise = boundedOcr(startingWorker, timeoutMs, () => {
      workerPromise = null;
      // A worker that finishes starting after the deadline must not remain alive.
      startingWorker.then(worker => worker?.terminate?.()).catch(() => {});
    }, signal).catch(error => {
      if (workerPromise) workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function preprocessImage(bytes, preprocessor, {signal, deadlineAt, timeoutMs}) {
  const remaining = timeLeft(deadlineAt, timeoutMs);
  if (signal?.aborted || remaining <= 0) throw new Error('Image preprocessing deadline expired');
  if (preprocessor) return boundedOcr(Promise.resolve().then(() => preprocessor(bytes, {signal, deadlineAt})), remaining, null, signal);
  const sharpModule = await import('sharp');
  const sharp = sharpModule.default;
  const image = sharp(bytes, {failOn: 'error', limitInputPixels: MAX_PIXELS});
  const destroy = () => image.destroy();
  const metadata = await boundedOcr(image.metadata(), timeLeft(deadlineAt, timeoutMs), destroy, signal);
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || metadata.width * metadata.height > MAX_PIXELS) {
    fail('image dimensions exceed the 12 megapixel OCR limit');
  }
  const scale = Math.min(3, Math.max(1, 2200 / Math.max(metadata.width, metadata.height)));
  try {
    return await boundedOcr(image.resize(Math.round(metadata.width * scale), Math.round(metadata.height * scale), {kernel: 'lanczos3'})
      .grayscale().normalize().sharpen().png().toBuffer(), timeLeft(deadlineAt, timeoutMs), destroy, signal);
  } finally { image.destroy(); }
}

/** Run fully local English OCR and return conservative, always-reviewable invoice fields. */
export async function extractInvoiceFromImage({bytes, mimeType, workerFactory, preprocessor,
  timeoutMs = DEFAULT_OCR_TIMEOUT_MS, signal, deadlineAt} = {}) {
  const {data, detected} = checkedImage(bytes, mimeType);
  const effectiveDeadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + timeoutMs;
  const processed = await preprocessImage(data, preprocessor, {signal, deadlineAt: effectiveDeadline, timeoutMs});
  const run = async () => {
    let worker;
    try {
      const remaining = timeLeft(effectiveDeadline, timeoutMs);
      worker = await getWorker(workerFactory, remaining, signal);
      if (signal?.aborted || timeLeft(effectiveDeadline, timeoutMs) <= 0) throw new Error('OCR execution deadline expired');
      const result = await boundedOcr(worker.recognize(processed), timeLeft(effectiveDeadline, timeoutMs), () => {
        workerPromise = null;
        Promise.resolve(worker.terminate?.()).catch(() => {});
      }, signal);
      return parseOfflineInvoiceText(result?.data?.text || '', {ocrConfidence: result?.data?.confidence});
    } finally {
      if (worker) {
        workerPromise = null;
        await boundedOcr(Promise.resolve(worker.terminate?.()), Math.min(timeLeft(effectiveDeadline, timeoutMs), 1_000)).catch(() => {});
      }
    }
  };
  const queueWait = boundedOcr(ocrQueue, timeLeft(effectiveDeadline, timeoutMs), null, signal);
  const task = queueWait.then(run);
  ocrQueue = task.then(() => undefined, () => undefined);
  const parsed = await task;
  parsed.ocr.mimeType = detected;
  return parsed;
}
