import {SUPPORTED_TWO_DECIMAL_CURRENCIES} from '../currency-contract.mjs';

const supported = new Set(SUPPORTED_TWO_DECIMAL_CURRENCIES);
const DOLLAR_CURRENCIES = new Set(['USD', 'CAD', 'AUD', 'SGD']);
const COUNTRY_RULES = [
  ['INR', /\b(?:india|indian|gstin?|pan)\b|\+91\b|\b[1-9]\d{5}\b/i, 'Indian details'],
  ['USD', /\b(?:united states|usa|u\.s\.a\.?|u\.s\.)\b|\+1\b|\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+\d{5}(?:-\d{4})?\b/i, 'US address or phone details'],
  ['GBP', /\b(?:united kingdom|great britain|england|scotland|wales)\b|\+44\b/i, 'UK details'],
  ['AED', /\b(?:united arab emirates|uae|dubai|abu dhabi)\b|\+971\b/i, 'UAE details'],
  ['SGD', /\bsingapore\b|\+65\b/i, 'Singapore details'],
  ['AUD', /\baustralia\b|\+61\b/i, 'Australian details'],
  ['CAD', /\bcanada\b|\+1\b[^\n]*(?:canada|\b(?:ON|QC|BC|AB|MB|SK|NS|NB|NL|PE)\b)/i, 'Canadian details'],
  ['CHF', /\b(?:switzerland|swiss)\b|\+41\b/i, 'Swiss details'],
  ['EUR', /\b(?:euro|european union|germany|france|italy|spain|ireland|netherlands|belgium|austria|portugal)\b/i, 'European details'],
];
const CODE = /(?:^|[^A-Z])(INR|USD|EUR|GBP|AED|SGD|AUD|CAD|CHF|JPY|KWD|BHD)(?=$|[^A-Z])/i;

function evidenceText(extracted, rawText) {
  const values = Object.values(extracted || {}).flatMap(item => {
    const value = item && typeof item === 'object' && 'value' in item ? item.value : item;
    return typeof value === 'string' ? [value] : [];
  });
  return `${values.join('\n')}\n${String(rawText || '')}`;
}

/** Deterministically infer currency without overriding explicit printed evidence. */
export function inferInvoiceCurrency(extracted, rawText = '', defaultCurrency = 'INR') {
  const text = evidenceText(extracted, rawText);
  const explicit = String(extracted?.currency?.value || '').trim().toUpperCase();
  const code = explicit || text.match(CODE)?.[1]?.toUpperCase();
  if (code) {
    if (!supported.has(code)) return {currency: null, source: `unsupported printed currency ${code}`, unsupportedCurrency: code, assumed: false};
    return {currency: code, source: extracted?.currencySource?.value || `printed currency code ${code}`, assumed: false};
  }
  if (/¥/u.test(text)) return {currency: null, source: 'unsupported printed currency symbol ¥', unsupportedCurrency: 'JPY', assumed: false};
  for (const [currency, pattern, source] of COUNTRY_RULES) {
    if (pattern.test(text)) return {currency, source, assumed: false};
  }
  const symbols = [['INR', /₹/u, '₹ symbol'], ['EUR', /€/u, '€ symbol'], ['GBP', /£/u, '£ symbol'], ['AED', /د\.?إ|د\.إ/u, 'AED symbol'], ['CHF', /\bCHF\b/i, 'CHF code']];
  for (const [currency, pattern, source] of symbols) if (pattern.test(text)) return {currency, source, assumed: false};
  if (/\$/.test(text)) {
    const fallback = DOLLAR_CURRENCIES.has(String(defaultCurrency).toUpperCase()) ? String(defaultCurrency).toUpperCase() : 'USD';
    return {currency: fallback, source: `ambiguous $ symbol; assumed ${fallback}`, assumed: true};
  }
  const fallback = supported.has(String(defaultCurrency).toUpperCase()) ? String(defaultCurrency).toUpperCase() : 'INR';
  return {currency: fallback, source: `currency not shown; assumed workspace default ${fallback}`, assumed: true};
}

export function deriveInvoiceDueDate(invoiceDate, dueDate, terms) {
  if (dueDate) return {dueDate, source: 'printed'};
  if (!invoiceDate || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return {dueDate: null, source: 'not shown'};
  const text = String(terms || '');
  const days = /\bnet\s*(\d{1,3})\b/i.exec(text)?.[1] ?? /\bdue\s+in\s+(\d{1,3})\s+days?\b/i.exec(text)?.[1];
  if (/\bdue\s+on\s+receipt\b/i.test(text)) return {dueDate: invoiceDate, source: 'derived from Due on receipt'};
  if (days !== undefined) {
    const date = new Date(`${invoiceDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(days));
    return {dueDate: date.toISOString().slice(0, 10), source: `derived from ${/net/i.test(text) ? 'Net ' : 'Due in '}${Number(days)}`};
  }
  return {dueDate: null, source: 'not shown'};
}

export function todayInKolkata(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
}
