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
  'outstandingAmount', 'currency', 'clientPhone', 'clientPhoneRaw', 'clientEmail', 'notes', 'direction', 'lineItems',
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

function amountFromLine(spans, labels, warnings, fieldName) {
  const values = new Set(spans.filter(span => labels.includes(span.label) && span.value !== null && span.value >= 0)
    .map(span => span.value));
  if (values.size > 1) warnings.push(`Conflicting printed ${fieldName} amounts; confirm the value against the image.`);
  return values.size === 1 ? [...values][0] : null;
}

function parseLineItems(lines, confidence) {
  const excluded = /^(?:labour|labor|parts?|consumables?|subs*total|subtotal|tax|gst|vat|total|balance due|amount due|rounding)\s*total\b/i;
  const itemPattern = /^\s*(?<description>[\p{L}\p{N}][\p{L}\p{N} &'().,/+-]{0,119}?)\s+(?<quantity>\d+(?:\.\d{1,4})?)\s+\$?\s*(?<unitPrice>\d[\d,]*(?:\.\d{1,2})?)\s+\$?\s*(?<amount>\d[\d,]*(?:\.\d{1,2})?)\s*$/u;
  const headerIndex = lines.findIndex(line => /\b(?:item|description)\b/i.test(line) && /\b(?:qty|quantity|hours)\b/i.test(line) && /\b(?:unit\s*price|rate)\b/i.test(line) && /\b(?:amount|total)\b/i.test(line));
  if (headerIndex < 0) return [];
  const output = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const row = /\bsr\b/i.test(lines[headerIndex]) ? line.replace(/^\d+ /, '') : line;
    const match = row.match(itemPattern);
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
  // Collapse horizontal whitespace once, before matching. Keep raw OCR untouched.
  // This prevents adjacent optional separators from partitioning long whitespace runs.
  const rawLines = cleanText.split('\n');
  const normalize = line => line.replace(/[^\S\n]+/g, ' ').trim();
  const lines = rawLines.map(normalize).filter(Boolean);
  // Retain layout boundaries separately: collapsing them into punctuation would
  // break labels such as "Bill  To" and ordinary item-table whitespace.
  const fieldLines = rawLines.map(raw => {
    let text = '';
    const starts = [];
    for (const match of raw.matchAll(/\S+|[^\S\n]+/g)) {
      if (/^\s/.test(match[0])) {
        if (!text) continue;
        text += ' ';
        if (match[0].length > 1 || match[0].includes('\t')) starts.push(text.length);
      } else text += match[0];
    }
    return {text: text.trimEnd(), starts};
  }).filter(line => line.text);
  const confidence = safeConfidence(ocrConfidence);
  const warnings = [
    'Offline OCR is a draft. Review every extracted value against the image before saving.',
    'Direction is uncertain; confirm whether your business issued this invoice.',
  ];
  const dateQualifierSource = 'valid (?:until|through|till)|tax point|invoice|due|until|through|till|supply|order|receipt|expiry|expiration|print|printed|point|shipping|delivery|payment|dispatch|purchase|paid|received|service|transaction|posting|quote|quotation|validity|settlement|inspection|manufacturing|production|despatch|document|effective|approval|statement|billing|booking|value|renewal|shipment|audit|review';
  const dateWordSource = `${dateQualifierSource}|actual|expected|estimated|original|revised|scheduled|requested|promised|planned|confirmed|final|initial|ship|completion`;
  const dateLabelSource = `(?:(?:(?:${dateWordSource})(?: ?- ?| ))+date|[a-z]+ ?- ?date|date)`;
  const boundarySource = `(?:${dateLabelSource}|invoice (?:no\\.?|number|#)|bill(?:ed)? to|ship to|customer|client|(?:(?:billing|shipping|delivery|registered) )?address|GSTIN|GST no\\.?|phone|mobile)`;
  const labelPattern = new RegExp(`\\b(${boundarySource}|labou?r total|parts? total|consumables? total|taxable(?: subtotal)?|subtotal|(?:CGST|SGST|IGST|GST|sales tax|tax|VAT)(?: \\d{1,3}(?:\\.\\d{1,4})? ?%)?|grand total|total(?: due)?|balance due|amount due|outstanding(?: amount)?|rounding|currency(?: code)?)(?= |:|[₹$€£]|$)`, 'gi');
  // Whitespace alone is not evidence of a new field inside a printed name.
  // Undelimited identifiers/phones have recognizable payloads; other labels
  // need their explicit field delimiter.
  const fieldLabels = (line, starts = []) => {
    const known = [...line.matchAll(labelPattern)];
    const strongStarts = [...line.matchAll(/[|;] */g)].map(match => match.index + match[0].length);
    const layoutStarts = [...new Set([...starts, ...strongStarts])].sort((left, right) => left - right);
    const explicit = [];
    const lastColon = line.lastIndexOf(':');
    for (const start of layoutStarts) {
      if (start > lastColon) continue;
      // Complete labels outrank their internal OCR spacing, including unknown
      // phrases introduced by a pipe, semicolon or column gap.
      if ([...known, ...explicit].some(label => label.index < start && start < label.index + label[0].length)) continue;
      const match = line.slice(start).match(/^([a-z][a-z0-9 _./#()-]*?) *:(?= *\S)/i);
      if (!match) continue;
      const label = [match[1], match[1]];
      label.index = start;
      explicit.push(label);
    }
    const candidates = [...explicit, ...known.filter(match =>
      !explicit.some(label => match.index >= label.index && match.index < label.index + label[0].length))]
      .sort((left, right) => left.index - right.index);
    const labels = [];
    for (let index = candidates.length - 1; index >= 0; index--) {
      const match = candidates[index];
      const tail = line.slice(match.index + match[0].length, labels[0]?.index ?? line.length);
      const payload = tail.trim().replace(/(?: *[|;] *)+$/, '').trim();
      const structured = /^(?:GSTIN|GST no\.?)$/i.test(match[0])
        ? /^\d{2}[a-z]{5}\d{4}[a-z][a-z0-9]Z[a-z0-9]$/i.test(payload)
        : /^(?:phone|mobile)$/i.test(match[0])
          ? /^\+?\d[\d ()-]{8,}$/.test(payload)
          : /^currency(?: code)?$/i.test(match[0])
            ? CURRENCIES.has(payload.toUpperCase())
            : moneyPattern.test(payload);
      if (/^ *:/.test(tail) || structured) labels.unshift(match);
    }
    return labels;
  };
  const moneyPattern = /^(?:(?:INR|Rs\.?|USD|EUR|GBP|AED|SGD|AUD|CAD|CHF) ?|[₹$€£] ?)?(-?\d[\d,]*(?:\.\d{1,2})?)$/i;
  const totalLabels = ['grand total', 'total'];
  const dueLabels = ['amount due', 'total due', 'outstanding', 'outstanding amount'];
  const currencyEvidence = new Set();
  const spans = [];
  for (const {text: line, starts} of fieldLines) {
    const labels = fieldLabels(line, starts);
    for (let index = 0; index < labels.length; index++) {
      const match = labels[index];
      const label = (match[1] ?? match[2]).toLowerCase().replace(/ \d.*$/, '');
      // A field ends at the next recognized label or the end of this OCR line.
      // Full-span validation rejects numeric columns, suffixes and partial decimals.
      const payload = line.slice(match.index + match[0].length, labels[index + 1]?.index ?? line.length)
        .trim().replace(/^: ?/, '').replace(/(?: *[|;] *)+$/, '').trim();
      const printed = payload.match(moneyPattern)?.[1];
      const amount = printed === undefined ? null : Number(printed.replaceAll(',', ''));
      const value = amount !== null && Number.isFinite(amount) && Number.isSafeInteger(Math.round(amount * 100)) ? amount : null;
      spans.push({label, value});
      if (totalLabels.includes(label) || dueLabels.includes(label) || label === 'balance due' || label.startsWith('currency')) {
        for (const code of payload.matchAll(/\b(INR|USD|EUR|GBP|AED|SGD|AUD|CAD|CHF|Rs\.?)(?= |\d|$)/gi)) {
          currencyEvidence.add(/^Rs\.?$/i.test(code[1]) ? 'INR' : code[1].toUpperCase());
        }
      }
    }
  }
  const subtotal = amountFromLine(spans, ['subtotal', 'taxable', 'taxable subtotal'], warnings, 'subtotal');
  const components = ['cgst', 'sgst', 'igst'].map(label => amountFromLine(spans, [label], warnings, label.toUpperCase()));
  const conflictingComponent = ['cgst', 'sgst', 'igst'].some((label, index) => components[index] === null
    && spans.some(span => span.label === label && span.value !== null && span.value >= 0));
  const tax = conflictingComponent ? null : components.some(value => value !== null)
    ? Math.round(components.reduce((sum, value) => sum + (value ?? 0), 0) * 100) / 100
    : amountFromLine(spans, ['gst', 'sales tax', 'tax', 'vat'], warnings, 'tax');
  const total = spans.some(span => totalLabels.includes(span.label) && span.value !== null && span.value >= 0)
    ? amountFromLine(spans, totalLabels, warnings, 'total')
    : amountFromLine(spans, ['amount due', 'total due'], warnings, 'total');
  // Balance Due is the more specific remaining balance, including a paid zero.
  const hasBalance = spans.some(span => span.label === 'balance due' && span.value !== null && span.value >= 0);
  const outstandingAmount = amountFromLine(spans, hasBalance ? ['balance due'] : dueLabels, warnings, 'outstanding');
  if (hasBalance && outstandingAmount !== null && spans.some(span => dueLabels.includes(span.label)
    && span.value !== null && span.value >= 0 && span.value !== outstandingAmount)) {
    warnings.push('Printed Balance Due differs from other due amounts; review the balance.');
  }
  const rounding = spans.find(span => span.label === 'rounding' && span.value !== null)?.value ?? null;
  const currency = currencyEvidence.size === 1 && CURRENCIES.has([...currencyEvidence][0]) ? [...currencyEvidence][0] : null;

  let invoiceNumber = null;
  for (const line of lines) {
    // Invoice identifiers must be on the same line as their label.
    const label = line.match(/\binvoice ?(?:no\b\.?|number\b|#) ?[:#*=-]* ?/i);
    if (!label) continue;
    const tail = line.slice(label.index + label[0].length);
    const token = tail.match(/^([a-z0-9][a-z0-9/_.-]{0,79})(?= |$)/i)?.[1];
    if (!token || /^(?:GSTIN|phone|mobile|tel|date|due|invoice|customer|client|address|bill|ship|to)$/i.test(token)) continue;
    if (/^\d{2}[a-z]{5}\d{4}[a-z][a-z0-9]Z[a-z0-9]$/i.test(token) || /^(?:91)?[6-9]\d{9}$/.test(token)) continue;
    if (/^ ?(?:road|rd\.?|street|st\.?|lane|avenue|floor|building|plot)\b/i.test(tail.slice(token.length))) continue;
    if (/^\d/.test(line) && /\b(?:road|street|lane|avenue|floor|building|plot)\b/i.test(line)) continue;
    invoiceNumber = token;
    break;
  }
  const readCustomer = (pattern, bareTo = false) => {
    for (let index = 0; index < fieldLines.length; index++) {
      const match = fieldLines[index].text.match(pattern);
      if (!match) continue;
      const ownLine = Boolean(match[1].trim());
      const source = fieldLines[index + (ownLine ? 0 : 1)];
      const printed = ownLine ? match[1].trim() : source?.text;
      const offset = ownLine ? source.text.length - match[1].trimStart().length : 0;
      const starts = source?.starts.filter(start => start >= offset).map(start => start - offset);
      const boundary = printed ? fieldLabels(printed, starts)[0]?.index : undefined;
      const value = printed?.slice(0, boundary).split(/[|;]/)[0].trim();
      if (value && value.length <= 160 && /\p{L}/u.test(value) && !/[:@]/.test(value)
        && !(bareTo && (/^\d/.test(value) || /\b(?:road|street|warehouse|gate)\b/i.test(value)))) return value;
    }
    return null;
  };
  // Explicit billing labels anywhere take precedence over an anchored bare To.
  const customerName = readCustomer(/\b(?:bill(?:ed)? to|customer|client) ?: ?(.*)/i)
    ?? readCustomer(/^to ?: ?(.*)/i, true);
  // Header vocabulary is the explicit exception for unseparated business text.
  // Date qualifiers themselves are not enumerated: any remaining prefix makes
  // this a qualified label, including unknown and hyphenated phrases.
  const businessHeaderSource = String.raw`(?:(?:seller|business|company)(?: name| \d+)?|(?:[a-z0-9&'().-]+ )*(?:ltd\.?|limited|llp|llc|inc\.?|corp\.?|corporation|company|co\.?|enterprises|industries|textiles|trading|traders|fabrics|exports|imports|services|solutions|consultants|associates|partners|logistics|studio|retail))`;
  const businessHeader = new RegExp(`^${businessHeaderSource}$`, 'i');
  const positiveHeader = prefix => !prefix || businessHeader.test(prefix)
    || /^[A-Z][A-Z0-9&]{1,}$/.test(prefix)
    || /^(?:\d+ [\p{L}\p{N} .,'™/-]+, |[\p{L} . '™/-]+, [\p{L} . '™/-]+, )[\p{L} . '™/-]+ \d{5,6}$/u.test(prefix);
  const dates = {invoice: new Set(), bare: new Set(), due: new Set()};
  const dateLabels = /\b(date|due) ?:/gi;
  for (const {text: line, starts} of fieldLines) {
    const labels = fieldLabels(line, starts);
    for (const match of line.matchAll(dateLabels)) {
      const complete = labels.find(label => label.index + label[0].length === match.index + match[1].length);
      const recognized = complete?.[0].toLowerCase().replace(/ *- */g, ' ').replace(/ +/g, ' ');
      let kind = recognized === 'invoice date' ? 'invoice'
        : recognized === 'due date' || match[1].toLowerCase() === 'due' ? 'due' : null;
      if (kind && complete && complete.index > 0
        && !labels.some(label => label.index < complete.index)
        && !positiveHeader(line.slice(0, complete.index).trim())) kind = null;
      if (!kind) {
        const prefix = line.slice(0, match.index).split(/[|;:]/).at(-1).trim();
        // Only positive header evidence can make an unseparated Date bare.
        if (positiveHeader(prefix)) kind = 'bare';
      }
      if (!kind) continue;
      const printed = line.slice(match.index + match[0].length, match.index + match[0].length + 40)
        .match(/^ ?(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})(?= |$)/)?.[1];
      if (!printed) continue;
      const parts = printed.split(/[/-]/).map(Number);
      const [year, month, day] = parts[0] > 999 ? parts : [parts[2], parts[1], parts[0]];
      const date = new Date(Date.UTC(year, month - 1, day));
      if (year >= 1900 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) dates[kind].add(date.toISOString().slice(0, 10));
    }
  }
  const invoiceDates = dates.invoice.size ? dates.invoice : dates.bare;
  const invoiceDate = invoiceDates.size === 1 ? [...invoiceDates][0] : null;
  const dueDate = dates.due.size === 1 ? [...dates.due][0] : null;
  const lineItems = parseLineItems(lines, confidence);
  if (currency === null) warnings.push('Currency code was not explicitly printed; confirm the currency.');
  if (subtotal !== null && tax !== null && total !== null && Math.abs(Math.round(subtotal * 100) + Math.round(tax * 100) - Math.round(total * 100)) > 100) {
    warnings.push(rounding !== null && Number.isFinite(rounding) && Math.abs(subtotal + tax + rounding - total) < 0.005
      ? 'Printed rounding reconciles the subtotal, tax, and total; verify it against the image.'
      : 'Subtotal plus tax does not match total; check any printed rounding.');
  }
  if (lineItems.length === 0) warnings.push('No line items could be read reliably.');

  return {
    invoiceNumber: field(invoiceNumber, confidence),
    customerName: field(customerName, confidence),
    invoiceDate: field(invoiceDate, confidence),
    dueDate: field(dueDate, confidence),
    subtotal: field(subtotal, confidence),
    tax: field(tax, confidence),
    total: field(total, confidence),
    outstandingAmount: field(outstandingAmount, confidence),
    currency: field(currency, confidence),
    clientPhone: field(null, confidence),
    clientPhoneRaw: field(null, confidence),
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

