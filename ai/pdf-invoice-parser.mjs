const SUPPORTED_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'CHF']);
const MONEY = String.raw`(?:[$€£]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;
const ROW_MONEY_PAIR = new RegExp(`^(.*?)\\s+(${MONEY})\\s+(${MONEY})\\s*$`);
const AMOUNT_PAIR_ONLY = new RegExp(`^\\s*(${MONEY})\\s+(${MONEY})\\s*$`);

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalizedName = (value) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function asCents(token) {
  if (!token) return null;
  const wrappedNegative = /^\s*\(.*\)\s*$/.test(token);
  const normalized = token.replace(/[()$€£,\sA-Z]/gi, '');
  if (!/^[-+]?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) * (wrappedNegative ? -1 : 1);
}

function lastMoneyCents(line) {
  const matches = [...line.matchAll(new RegExp(MONEY, 'g'))];
  return matches.length ? asCents(matches.at(-1)[0]) : null;
}

function wrapped(value, confidence = 0.99) {
  return { value, confidence: value === null ? 0 : confidence };
}

function scalarFields(values) {
  return Object.fromEntries([
    'invoiceNumber', 'customerName', 'invoiceDate', 'dueDate', 'subtotal', 'tax', 'total',
    'outstandingAmount', 'currency', 'clientPhone', 'clientEmail', 'notes', 'direction', 'paymentStatus',
  ].map((key) => [key, wrapped(values[key] ?? null, key === 'direction' && values[key] === 'uncertain' ? 0 : 0.99)]));
}

function isSummary(line) {
  return /^\s*(?:SUB\s*TOTAL|SUBTOTAL|SALES\s+TAX|(?:STATE|LOCAL)\s+TAX|TAX|VAT|GST|HST|SHIPPING|HANDLING|FREIGHT|DELIVERY|SERVICE\s+FEE|SURCHARGE|OTHER\s+CHARGES|DISCOUNT|COUPON|GRAND\s+TOTAL|INVOICE\s+TOTAL|TOTAL\b|AMOUNT\s+DUE|BALANCE\s+DUE|REMAINING\s+DUE)\b/i.test(line);
}

function looksLikeCode(line) {
  const compact = line.trim().replace(/\s*([-/])\s*/g, '$1');
  return /^[A-Z0-9]+(?:[-/][A-Z0-9]+)+$/i.test(compact) && /[A-Z]/i.test(compact) && /\d/.test(compact);
}

function cleanDescription(value) {
  return clean(value)
    .replace(/\s*\(\s*[A-Z][A-Z0-9]*\s*-\s*[A-Z0-9-]+\s*\)/gi, '')
    .replace(/\b[A-Z][A-Z0-9]*\s*-\s*[A-Z0-9-]+\b/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function quantityAndDescription(prefix) {
  const match = prefix.trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) return null;
  const quantity = Number(match[1]);
  const description = cleanDescription(match[2]);
  if (!Number.isFinite(quantity) || quantity <= 0 || !description) return null;
  return { quantity, description };
}

function parseLineItems(lines, headerIndex) {
  const value = [];
  let pending = null;
  const add = (row, unitToken, amountToken) => {
    const unitCents = asCents(unitToken);
    const amountCents = asCents(amountToken);
    if (!row || unitCents === null || amountCents === null || unitCents < 0 || amountCents < 0) return false;
    const expected = Math.round(row.quantity * unitCents);
    if (Math.abs(expected - amountCents) > 1) return false;
    value.push({
      description: row.description,
      quantity: row.quantity,
      unitPrice: unitCents / 100,
      amount: amountCents / 100,
      confidence: 0.99,
    });
    return true;
  };

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (isSummary(line)) break;
    if (/^\d{1,3}$/.test(line) || looksLikeCode(line)) continue;

    const amountOnly = line.match(AMOUNT_PAIR_ONLY);
    if (amountOnly) {
      if (!pending || !add(pending, amountOnly[1], amountOnly[2])) return null;
      pending = null;
      continue;
    }

    const inline = line.match(ROW_MONEY_PAIR);
    if (inline && inline[1].trim()) {
      const row = quantityAndDescription(inline[1]);
      if (row) {
        if (pending || !add(row, inline[2], inline[3])) return null;
        continue;
      }
    }

    const row = quantityAndDescription(line);
    if (row) {
      if (pending) return null;
      pending = row;
      continue;
    }
    if (pending) pending.description = cleanDescription(`${pending.description} ${line}`);
  }

  if (pending || value.length === 0 || value.length > 100) return null;
  return value.every((item) => item.description.length > 0 && item.description.length <= 500) ? value : null;
}

function findLine(lines, pattern) {
  return lines.find((line) => pattern.test(line)) ?? null;
}

function labeledText(lines, pattern) {
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return clean(match[1]);
  }
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const source = clean(value).replace(/[,]/g, '');
  let year; let month; let day;
  let match = source.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) [, year, month, day] = match;
  else {
    match = source.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
    if (match) {
      const first = Number(match[1]); const second = Number(match[2]);
      if (first > 12) { day = match[1]; month = match[2]; year = match[3]; }
      else if (second > 12) { month = match[1]; day = match[2]; year = match[3]; }
      else if (source.includes('.')) { day = match[1]; month = match[2]; year = match[3]; }
      else return null;
    } else {
      const named = source.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/)
        ?? source.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/);
      if (!named) return null;
      const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      if (/^\d/.test(named[1])) {
        day = named[1]; month = String(months.findIndex((name) => name.startsWith(named[2].toLowerCase())) + 1); year = named[3];
      } else {
        month = String(months.findIndex((name) => name.startsWith(named[1].toLowerCase())) + 1); day = named[2]; year = named[3];
      }
    }
  }
  const y = Number(year); const m = Number(month); const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function partyBlock(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*SHIP\s+TO\b/i.test(lines[index])) continue;
    const match = lines[index].match(pattern);
    if (!match) continue;
    const block = [clean(match[1])].filter(Boolean);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (/^(?:SHIP\s+TO|COMMENTS?|SPECIAL\s+INSTRUCTIONS|SALESPERSON|P\.?O\.?\s+NUMBER|TERMS|QUANTITY|QTY|INVOICE|SUBTOTAL|TOTAL)\b/i.test(line)) break;
      if (line) block.push(line);
    }
    return block;
  }
  return [];
}

function partyName(block) {
  for (const line of block) {
    if (/^(?:PHONE|TEL|MOBILE|EMAIL|E-?MAIL)\s*:/i.test(line) || /@/.test(line) || /^\+?[\d().\s-]{8,}$/.test(line)) continue;
    if (/\b\d{4,}\b/.test(line) || /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|suite|unit|zip|postal)\b/i.test(line)) continue;
    return clean(line).replace(/[,;:]$/, '') || null;
  }
  return null;
}

function explicitPhone(block) {
  for (const line of block) {
    const match = line.match(/(?:PHONE|TEL|MOBILE|CONTACT)\s*:?\s*(\+\s*[\d().\s-]+)/i);
    if (!match) continue;
    const value = `+${match[1].replace(/\D/g, '')}`;
    if (/^\+[1-9]\d{7,14}$/.test(value)) return value;
  }
  return null;
}

function explicitEmail(block) {
  for (const line of block) {
    const match = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0];
  }
  return null;
}

function notesValue(lines) {
  const index = lines.findIndex((line) => /^(?:COMMENTS?|SPECIAL\s+INSTRUCTIONS|NOTES?)\b/i.test(line));
  if (index < 0) return null;
  const first = clean(lines[index].replace(/^(?:COMMENTS?|SPECIAL\s+INSTRUCTIONS|NOTES?)(?:\s+OR\s+SPECIAL\s+INSTRUCTIONS)?\s*[:#-]?/i, ''));
  const notes = first ? [first] : [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (/^(?:SALESPERSON|P\.?O\.?\s+NUMBER|TERMS|QUANTITY|QTY|SUBTOTAL|TOTAL)\b/i.test(lines[cursor])) break;
    if (lines[cursor]) notes.push(lines[cursor]);
  }
  const value = clean(notes.join(' '));
  return !value || /^(?:none|n\/?a|no comments?)\.?$/i.test(value) ? null : value;
}

function totals(lines) {
  let subtotal = null; let tax = null; let charges = 0; let hasCharges = false; let discounts = 0;
  let total = null; let totalRank = -1; let outstanding = null;
  for (const line of lines) {
    const amount = lastMoneyCents(line);
    if (amount === null) continue;
    if (/^\s*(?:SUB\s*TOTAL|SUBTOTAL)\b/i.test(line)) subtotal = amount;
    else if (/^\s*(?:SALES\s+TAX|(?:STATE|LOCAL)\s+TAX|TAX|VAT|GST|HST)\b/i.test(line)) tax = (tax ?? 0) + amount;
    else if (/^\s*(?:SHIPPING|HANDLING|FREIGHT|DELIVERY|SERVICE\s+FEE|SURCHARGE|OTHER\s+CHARGES)\b/i.test(line)) { charges += amount; hasCharges = true; }
    else if (/^\s*(?:DISCOUNT|COUPON)\b/i.test(line)) discounts += Math.abs(amount);

    let rank = -1;
    if (/^\s*(?:AMOUNT|BALANCE|REMAINING)\s+DUE\b/i.test(line)) rank = 5;
    else if (/^\s*(?:GRAND\s+TOTAL|INVOICE\s+TOTAL)\b/i.test(line)) rank = 4;
    else if (/^\s*TOTAL\s+DUE\b/i.test(line)) rank = 3;
    else if (/^\s*TOTAL\b/i.test(line)) rank = 2;
    if (rank >= 0 && rank >= totalRank) { total = amount; totalRank = rank; }
    if (/^\s*(?:AMOUNT|BALANCE|REMAINING)\s+DUE\b|^\s*TOTAL\s+DUE\b/i.test(line)) outstanding = amount;
  }
  if (subtotal === null || total === null) return null;
  return { subtotal, tax, charges, hasCharges, discounts, total, outstanding };
}

function findCurrency(lines) {
  const explicit = lines.map((line) => line.match(/\bCURRENCY\s*[:=]?\s*(INR|USD|EUR|GBP|AED|SGD|AUD|CAD|CHF)\b/i)?.[1]).find(Boolean)
    ?? lines.map((line) => line.match(/(?:^|\s)(INR|USD|EUR|GBP|AED|SGD|AUD|CAD|CHF)\s*\d[\d,.]*|\d[\d,.]*\s*(INR|USD|EUR|GBP|AED|SGD|AUD|CAD|CHF)(?:\s|$)/i)).find(Boolean);
  if (!explicit) return null;
  const code = typeof explicit === 'string' ? explicit : explicit[1] ?? explicit[2];
  return SUPPORTED_CURRENCIES.has(code.toUpperCase()) ? code.toUpperCase() : null;
}

function classifyDirection(lines, businessName, buyerBlock, sellerBlock) {
  const wanted = normalizedName(businessName);
  if (!wanted) return 'uncertain';
  const matches = (block) => block.some((line) => normalizedName(line) === wanted);
  if (matches(sellerBlock)) return 'receivable';
  if (matches(buyerBlock)) return 'payable';
  const payableTo = findLine(lines, /^\s*MAKE\s+ALL\s+CHECKS\s+PAYABLE\s+TO\b/i);
  if (payableTo && normalizedName(payableTo.replace(/^.*?\bTO\b/i, '')) === wanted) return 'receivable';
  return 'uncertain';
}

/**
 * Deterministically extract clearly printed invoice text and table facts.
 * Returns null unless line rows and monetary arithmetic reconcile exactly.
 */
export function parsePdfInvoiceText(text, { businessName = '' } = {}) {
  if (typeof text !== 'string' || text.length < 30 || text.length > 500_000) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(clean);
  const headerIndex = lines.findIndex((line) => /\b(?:QUANTITY|QTY)\b/i.test(line)
    && /\bDESCRIPTION\b/i.test(line) && /\b(?:UNIT\s+PRICE|PRICE)\b/i.test(line)
    && /\b(?:TOTAL|AMOUNT)\b/i.test(line));
  if (headerIndex < 0) return null;
  const lineItems = parseLineItems(lines, headerIndex);
  const parsedTotals = totals(lines);
  if (!lineItems || !parsedTotals) return null;
  const lineSum = lineItems.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  if (lineSum !== parsedTotals.subtotal) return null;
  const expectedTotal = parsedTotals.subtotal + (parsedTotals.tax ?? 0) + parsedTotals.charges - parsedTotals.discounts;
  if (expectedTotal !== parsedTotals.total) return null;

  const buyerBlock = partyBlock(lines, /^\s*(?:(?:BILL|SOLD|INVOICE)\s+TO|CUSTOMER|CLIENT|TO)\s*:?\s*(.*)$/i);
  const sellerBlock = partyBlock(lines, /^\s*(?:FROM|BILL\s+FROM|SOLD\s+BY|ISSUED\s+BY|SELLER|SUPPLIER|VENDOR)\s*:?\s*(.*)$/i);
  const clientPhone = explicitPhone(buyerBlock);
  const clientEmail = explicitEmail(buyerBlock);

  const invoiceNumber = labeledText(lines, /^\s*INVOICE\s*(?:NUMBER|NO\.?|#)\s*[:#-]?\s*(.+)$/i);
  const invoiceDateText = labeledText(lines, /^\s*(?:INVOICE\s+)?DATE\s*[:#-]?\s*(.+)$/i);
  const dueDateText = labeledText(lines, /^\s*(?:DUE\s+DATE|PAYMENT\s+DUE|DUE\s+BY)\s*[:#-]?\s*(.+)$/i);
  const extraCharges = lines.filter((line) => /^\s*(?:SHIPPING|HANDLING|FREIGHT|DELIVERY|SERVICE\s+FEE|SURCHARGE|OTHER\s+CHARGES)\b/i.test(line))
    .map((line) => clean(line)).join('; ');
  const note = notesValue(lines);

  const values = {
    invoiceNumber,
    customerName: partyName(buyerBlock),
    invoiceDate: parseDate(invoiceDateText),
    dueDate: parseDate(dueDateText),
    subtotal: parsedTotals.subtotal / 100,
    tax: parsedTotals.tax === null ? null : parsedTotals.tax / 100,
    total: parsedTotals.total / 100,
    outstandingAmount: parsedTotals.outstanding === null ? null : parsedTotals.outstanding / 100,
    currency: findCurrency(lines),
    clientPhone,
    clientEmail,
    notes: [note, extraCharges || null].filter(Boolean).join('; ') || null,
    direction: classifyDirection(lines, businessName, buyerBlock, sellerBlock),
    paymentStatus: /\b(?:part(?:ial(?:ly)?)?\s+paid|not\s+paid|unpaid|payment\s+(?:pending|expected))\b/i.test(text)
      ? 'ambiguous'
      : parsedTotals.outstanding === 0 || /\b(?:paid(?:\s+in\s+full)?|payment\s+received)\b/i.test(text) ? 'paid' : 'unpaid',
  };

  return {
    ...scalarFields(values),
    lineItems: { value: lineItems, confidence: 0.99 },
  };
}
