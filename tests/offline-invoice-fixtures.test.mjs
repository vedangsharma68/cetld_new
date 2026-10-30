import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {parseOfflineInvoiceText} from '../ai/image-text.mjs';

test('F1 uppercase qualified dates stay uncertain alone and inside complete documents', () => {
  for (const qualifier of ['REVERSAL','DISBURSEMENT','PAYMENT','PRINT','SHIPPING','AUDIT','CANCELLATION','BANK','REFUND']) {
    for (const label of [qualifier, qualifier.toLowerCase(), qualifier[0] + qualifier.slice(1).toLowerCase()]) {
      for (const prefix of ['', 'Invoice No: Q-19\nBill To: Arbor Partners\nTotal: INR 118.00\n']) {
        const result = parseDraft(`${prefix}${label} DATE: 2026-10-20`);
        assert.equal(result.invoiceDate.value, null, label);
        assert.ok(result.uncertainFields.includes('invoiceDate'));
      }
    }
  }
});

test('F2 OCR gaps inside names cannot invent labels spanning a recognized colon label', () => {
  for (const [name, suffix] of [
    ['Cedar Grove   Distribution','GSTIN: 29ABCDE1234F1Z5'],
    ['Willow\tValley  Cooperative','Phone: 9876543210'],
    ['Summit  Ridge\tGroup','Address: 17 Park Lane'],
    ['Pinnacle  Supply Chain','GSTIN: 29ABCDE1234F1Z5'],
    ['Meadow  Valley Partners','Phone: 9876543210'],
    ['Riverbend\tSupply Partners','Address: 15 Lake Road'],
  ]) {
    const result = parseDraft(`Bill To: ${name} ${suffix}`);
    assert.equal(result.customerName.value, name.replace(/\s+/g, ' '), name);
    assert.ok(result.uncertainFields.includes('customerName'));
  }
});

test('F3 bare numeric endings stay in labelled names even beside identifiers and phones', () => {
  for (const name of ['Regional VAT 2031','Atelier GST 37','Balance 82','Amount 56','National Tax 2026','Studio Tax 24','Total 24']) {
    for (const suffix of ['', ' GSTIN 29ABCDE1234F1Z5', ' Phone 9876543210', ' GSTIN: 29ABCDE1234F1Z5', ' Phone: 9876543210']) {
      for (const label of ['Bill To', 'Billed To', 'Customer', 'Client', 'To']) {
        const result = parseDraft(`${label}: ${name}${suffix}`);
        assert.equal(result.customerName.value, name, label + ': ' + name + suffix);
        assert.equal(result.tax.value, null, name + ' is not a tax field');
        assert.equal(result.total.value, null, name + ' is not a total field');
        assert.ok(result.uncertainFields.includes('customerName'));
      }
    }
  }
});

const uncertainFields = [
  'invoiceNumber', 'customerName', 'invoiceDate', 'dueDate', 'subtotal', 'tax', 'total',
  'outstandingAmount', 'currency', 'clientPhone', 'clientPhoneRaw', 'clientEmail', 'notes', 'direction', 'lineItems',
];
const alwaysReviewWarnings = [
  'Offline OCR is a draft. Review every extracted value against the image before saving.',
  'Direction is uncertain; confirm whether your business issued this invoice.',
];
function assertConfidence(value) {
  assert.equal(typeof value, 'number');
  assert.ok(Number.isFinite(value) && value >= 0 && value <= .69, `invalid confidence: ${value}`);
}
function parseDraft(text, options = {}) {
  const result = parseOfflineInvoiceText(text, options);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.usedFallback, true);
  assert.equal(result.model, 'tesseract.js-eng-offline');
  assert.deepEqual(result.direction, {value:'uncertain', confidence:0});
  assert.deepEqual(result.uncertainFields, uncertainFields);
  for (const warning of alwaysReviewWarnings) assert.ok(result.warnings.includes(warning));
  for (const name of uncertainFields) {
    assert.ok(Object.hasOwn(result[name], 'value'), name);
    assert.ok(Object.hasOwn(result[name], 'confidence'), name);
    assertConfidence(result[name].confidence);
    if (result[name].value === null) assert.equal(result[name].confidence, 0, name);
  }
  assert.ok(Array.isArray(result.lineItems.value));
  for (const item of result.lineItems.value) {
    assert.equal(typeof item.description, 'string');
    for (const name of ['quantity', 'unitPrice', 'amount']) assert.ok(Number.isFinite(item[name]) && item[name] >= 0, name);
    assert.ok(Object.hasOwn(item, 'confidence'));
    assertConfidence(item.confidence);
  }
  const input = options.ocrConfidence;
  assert.equal(result.ocr.confidence, Number.isFinite(input) && input >= 0 && input <= 100 ? input : null);
  return result;
}
const itemValues = result => result.lineItems.value.map(({description, quantity, unitPrice, amount}) => ({description, quantity, unitPrice, amount}));

// Literal OCR evidence wins over image-level expectations: inv2's number/date
// are absent; inv4 prints 9 October, not 19 October. Never reconstruct either.
const fixtures = [
  ['inv1-clean.png', `Aarav Traders Invoice No: INV-2026-0142

14 MG Road, Bengaluru, Karnataka 560001 Invoice Date: 2026-10-20

GSTIN: 29ABCDE1234F1Z5 Due Date: 2026-11-04

Phone: +91 98450 12345 Payment Terms: Net 15

Bill To:

Kabir Textiles

88 Silk Board, Bengaluru, Karnataka 560068

Email: kabir@kabirtextiles.example

Phone: +91 99870 55443

Description Qty Unit Price Amount

Cotton fabric roll 10 1,200.00 12,000.00

Polyester blend roll 5 950.00 4,750.00

Packing 1 250.00 250.00
Subtotal: 17,000.00
GST 18%: 3,060.00
Total: INR 20,060.00
Amount Due: INR 20,060.00

Notes: Deliver to warehouse gate 2

Thank you for your business!`, {invoiceNumber:'INV-2026-0142', customerName:'Kabir Textiles', invoiceDate:'2026-10-20', dueDate:'2026-11-04', subtotal:17000, tax:3060, total:20060, outstandingAmount:20060, currency:'INR', lineItems:3}],
  ['inv2-small-number.png', `Sharma & Sons Logistics Pvt Ltd oneness
Plot 7, Okhla Industrial Area, New Delhi 110020 Due: 03/11/2026
GSTIN: 0O7AAACS1234Q1Z9
Billed To: Mehta Fabrics
Lajpat Nagar II, New Delhi 110024
WhatsApp: +91 98733 22110
Sr Description Qty Rate Amount
1 Fabric transport Delhi-Jaipur 1 8,500.00 8,500.00
2 Loading/unloading 1 1,500.00 1,500.00
Taxable: 10,000.00
IGST 18%: 1,800.00
Grand Total: Rs 11,800.00`, {invoiceNumber:null, customerName:'Mehta Fabrics', invoiceDate:null, dueDate:'2026-11-03', subtotal:10000, tax:1800, total:11800, outstandingAmount:null, currency:'INR', lineItems:2}],
  ['inv3-surcharges.png', `BlueDart-Style Express (fictional) Invoice # BD-55231
21 Transport Hub, Mumbai, Maharashtra 400001 Date: 2026-10-18
GSTIN: 27AAACB1234G1ZK Due Date: 2026-11-17
Customer: Nisha Exports
Bandra Kurla Complex, Mumbai 400051
Email: accounts@nishaexports.example
Waybill Description Amount G.Total
8841 Express cargo 42kg 4,200.00 4,200.00
Fuel surcharge 630.00
Demand surcharge 210.00
8842 Express cargo 18kg 2,100.00 2,100.00
Fuel surcharge 315.00
Taxable subtotal: 7,455.00
GST 18%: 1,341.90
Total Due: Rs 8,796.90`, {invoiceNumber:'BD-55231', customerName:'Nisha Exports', invoiceDate:'2026-10-18', dueDate:'2026-11-17', subtotal:7455, tax:1341.9, total:8796.9, outstandingAmount:8796.9, currency:'INR', lineItems:0}],
  ['inv4-photo-rotated.png', `invoice
Goyal Kirana stores invoice #* GK/2026/0417
Sadar gazaar, Gurugra™, Haryana 122001 Date: 9-10-2026
To: Radha caterers» Gurugram
mob: 98100 44332
item qty Rate amount
Basmati rice 25k9 2 2,150.00 4,300.00
sunflower oil SL 6 640.00 3,840.00
Atta 4Ok9 3 420.00 1,260.00
Total: Rs 9,400.00`, {invoiceNumber:'GK/2026/0417', customerName:'Radha caterers» Gurugram', invoiceDate:'2026-10-09', dueDate:null, subtotal:null, tax:null, total:9400, outstandingAmount:null, currency:'INR', lineItems:3}],
  ['inv5-paid-stamp.png', `Pixel Works Studio Invoice No: PW-0091
301 Cyber Hub, Pune, Maharashtra 411001 Date: 2026-09-28
Due Date: 2026-10-12
Client: Vertex Marketing LLP
Andheri East, Mumbai 400069
Description Qty Rate Amount
Logo redesign 1 18,000.00 18,000.00
Brand guidelines 1 7,000.00 7,000.00
Subtotal: 25,000.00
Total: INR 25,000.00
Balance Due: INR 0.00`, {invoiceNumber:'PW-0091', customerName:'Vertex Marketing LLP', invoiceDate:'2026-09-28', dueDate:'2026-10-12', subtotal:25000, tax:null, total:25000, outstandingAmount:0, currency:'INR', lineItems:2}],
  ['inv6-ambiguous-currency.png', `Northwind Consulting Invoice No: NW-3310
Date: 2026-10-15
Due Date: 2026-10-30
Client: Harbor Retail Group
Description Hours Rate Amount
Strategy workshop 8 $150.00 $1,200.00
Follow-up analysis 4 $125.00 $500.00
Total: $1,700.00`, {invoiceNumber:'NW-3310', customerName:'Harbor Retail Group', invoiceDate:'2026-10-15', dueDate:'2026-10-30', subtotal:null, tax:null, total:1700, outstandingAmount:null, currency:null, lineItems:2}],
  ['inv7-not-invoice.png', `CAFE MOCHA (fictional)
MENU

Espresso Rs 120
Cappuccino Rs 180
Cold Brew Rs 220
Blueberry Muffin Rs 150
Veg Sandwich Rs 200
Pasta Alfredo Rs 320

Open 8am - 10pm, all days`, {invoiceNumber:null, customerName:null, invoiceDate:null, dueDate:null, subtotal:null, tax:null, total:null, outstandingAmount:null, currency:null, lineItems:0}],
];

for (const [name, text, expected] of fixtures) {
  test(`offline OCR fixture: ${name}`, () => {
    const result = parseDraft(text, {ocrConfidence:name.startsWith('inv4') ? 71 : 95});
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(key === 'lineItems' ? result[key].value.length : result[key].value, value, key);
    }
    assert.equal(result.reviewRequired, true);
    assert.deepEqual(result.direction, {value:'uncertain', confidence:0});
    assert.ok(result.warnings.some(warning => /Review every extracted value/.test(warning)));
    assert.ok(result.warnings.some(warning => /Direction is uncertain/.test(warning)));
    assert.equal(result.warnings.some(warning => /Currency code/.test(warning)), expected.currency === null);
    assert.equal(result.ocr.text, text);
  });
}

test('bounded labels, valid dates, conflicting currencies and row shapes stay conservative', () => {
  const result = parseDraft(`NotSubtotal: 99\nInvoice Date: 2026-02-30\nDue Date: 2026-11-04\nTotal: USD 10.00\nBalance Due: INR 0.00\nDescription Qty Rate Amount\nFuel surcharge 630.00\nPacking 1 2.00 2.00`);
  assert.equal(result.subtotal.value, null);
  assert.equal(result.invoiceDate.value, null);
  assert.equal(result.dueDate.value, '2026-11-04');
  assert.equal(result.currency.value, null);
  assert.equal(result.lineItems.value.length, 1);
  assert.equal(parseDraft('x'.repeat(100000) + '\nTotal: INR 99.00').total.value, null);
});


test('every fixture pins exact item descriptions, quantities, prices and amounts', () => {
  const expected = [
    [
      {description:'Cotton fabric roll', quantity:10, unitPrice:1200, amount:12000},
      {description:'Polyester blend roll', quantity:5, unitPrice:950, amount:4750},
      {description:'Packing', quantity:1, unitPrice:250, amount:250},
    ],
    [
      {description:'Fabric transport Delhi-Jaipur', quantity:1, unitPrice:8500, amount:8500},
      {description:'Loading/unloading', quantity:1, unitPrice:1500, amount:1500},
    ],
    [],
    [
      {description:'Basmati rice 25k9', quantity:2, unitPrice:2150, amount:4300},
      {description:'sunflower oil SL', quantity:6, unitPrice:640, amount:3840},
      {description:'Atta 4Ok9', quantity:3, unitPrice:420, amount:1260},
    ],
    [
      {description:'Logo redesign', quantity:1, unitPrice:18000, amount:18000},
      {description:'Brand guidelines', quantity:1, unitPrice:7000, amount:7000},
    ],
    [
      {description:'Strategy workshop', quantity:8, unitPrice:150, amount:1200},
      {description:'Follow-up analysis', quantity:4, unitPrice:125, amount:500},
    ],
    [],
  ];
  fixtures.forEach((fixture, index) => assert.deepEqual(itemValues(parseDraft(fixture[1], {ocrConfidence:95})), expected[index], fixture[0]));
});

test('complete monetary spans reject numeric prefixes, table columns and partial decimals', () => {
  for (const text of ['Total: 1 20,000.00', 'Total: INR 1,20,000.000', 'Subtotal: 1 20.00', 'Tax: 1 20.00']) {
    const result = parseDraft(text);
    assert.equal(result.total.value, null);
    assert.equal(result.subtotal.value, null);
    assert.equal(result.tax.value, null);
  }
  assert.equal(parseDraft('Total: INR 1,20,000.00').total.value, 120000);
  const row = parseDraft('Description Qty Rate Amount\nTotal 1 20.00 20.00');
  assert.equal(row.total.value, null);
  assert.deepEqual(itemValues(row), [{description:'Total', quantity:1, unitPrice:20, amount:20}]);
  assert.equal(parseDraft('Description Qty Rate Amount\nTotal 1 20.00 20.00\nTotal: INR 20.00').total.value, 20);
});

test('shared-line labels retain independent amounts and contradictory totals remain unresolved', () => {
  const shared = parseDraft('Subtotal: INR 100.00 Grand Total: INR 118.00');
  assert.equal(shared.subtotal.value, 100);
  assert.equal(shared.total.value, 118);
  assert.equal(shared.currency.value, 'INR');
  assert.equal(parseDraft('Subtotal: 100.00').total.value, null);
  for (const separator of ['\n', ' ']) {
    for (const amounts of [[100, 120], [120, 100]]) {
      const result = parseDraft(`Total: INR ${amounts[0]}.00${separator}Grand Total: INR ${amounts[1]}.00\nAmount Due: INR 100.00`);
      assert.equal(result.total.value, null);
      assert.ok(result.warnings.some(warning => /Conflicting printed total/.test(warning)));
    }
    assert.equal(parseDraft(`Total: INR 100.00${separator}Grand Total: INR 100.00`).total.value, 100);
  }
  const due = parseDraft('Total Due: 120.00');
  assert.equal(due.total.value, 120);
  assert.equal(due.outstandingAmount.value, 120);
});

test('Balance Due wins over Amount Due in either order, including a paid zero', () => {
  for (const separator of ['\n', ' ']) {
    for (const amounts of [['Amount Due: INR 100.00', 'Balance Due: INR 0.00'], ['Balance Due: INR 0.00', 'Amount Due: INR 100.00']]) {
      const result = parseDraft(amounts.join(separator));
      assert.equal(result.outstandingAmount.value, 0);
      assert.equal(result.total.value, 100);
      assert.ok(result.warnings.some(warning => /Balance Due differs/.test(warning)));
    }
  }
  const conflict = parseDraft('Balance Due: INR 0.00\nBalance Due: INR 50.00');
  assert.equal(conflict.outstandingAmount.value, null);
  assert.ok(conflict.warnings.some(warning => /Conflicting printed outstanding/.test(warning)));
});

test('all explicit currency occurrences contribute, including multiple occurrences per line', () => {
  for (const text of [
    'Total: USD 10.00 Balance Due: INR 0.00',
    'Balance Due: INR 0.00 Total: USD 10.00',
    'Currency: USD Currency: INR',
    'Currency: INR\nCurrency: USD',
    'Total: USD 10.00 INR 0.00',
    'Currency: USD Total: INR 10.00',
  ]) {
    const result = parseDraft(text);
    assert.equal(result.currency.value, null, text);
    assert.ok(result.warnings.some(warning => /Currency code/.test(warning)));
  }
  assert.equal(parseDraft('Currency: INR Currency: INR Total: Rs. 10.00 Balance Due: INR 0.00').currency.value, 'INR');
  assert.equal(parseDraft('Total: USD 9.00').currency.value, 'USD');
  assert.equal(parseDraft('Total: Rs. 9.00').total.value, 9);
});

test('billing/customer labels take priority and bare To cannot select a shipping address', () => {
  for (const text of [
    'Ship To:\nWarehouse gate two\nBill To: Real Buyer',
    'To:\n14 MG Road\nBill To: Real Buyer',
    'To: Shipping Buyer\nBill To: Real Buyer',
    'Ship To: Warehouse gate two\nClient: Real Buyer',
    'Customer:\nPhone: 9876543210\nBill To: Real Buyer',
  ]) assert.equal(parseDraft(text).customerName.value, 'Real Buyer', text);
  for (const text of ['Ship To:\nWarehouse gate two', 'To:\n14 MG Road', 'To: Warehouse gate two']) assert.equal(parseDraft(text).customerName.value, null, text);
  assert.equal(parseDraft('To: Radha Caterers').customerName.value, 'Radha Caterers');
});

test('invoice identifiers cannot consume next-line labels, address prose, GSTINs or phone numbers', () => {
  for (const text of [
    'Invoice No:\nGSTIN 29ABCDE1234F1Z5',
    'Invoice No:\nPhone 9876543210',
    '14 Invoice No. 23 Road, Delhi',
    'Invoice No: GSTIN 29ABCDE1234F1Z5',
    'Invoice No: Phone 9876543210',
    'Invoice No: 29ABCDE1234F1Z5',
    'Invoice No: 9876543210',
    'Invoice No: 919876543210',
    'Invoice Notes: sample',
  ]) assert.equal(parseDraft(text).invoiceNumber.value, null, text);
  assert.equal(parseDraft('Invoice No. AB-123').invoiceNumber.value, 'AB-123');
  assert.equal(parseDraft('Invoice No: 12345').invoiceNumber.value, '12345', 'numeric invoice identifiers remain supported');
  assert.equal(parseDraft('Invoice No:\nPhone 9876543210\nInvoice No: INV-123').invoiceNumber.value, 'INV-123');
});

test('qualified date labels cannot become a bare invoice Date', () => {
  for (const label of ['Due-Date', 'Due - Date', 'Due    Date', 'Due\t\tDate']) {
    const result = parseDraft(`${label}: 2026-11-04`);
    assert.equal(result.dueDate.value, '2026-11-04', label);
    assert.equal(result.invoiceDate.value, null, label);
  }
  for (const label of ['Payment Date', 'Payment-Date', 'Delivery Date', 'Shipment Date', 'Settlement Date']) {
    const result = parseDraft(`${label}: 2026-11-04`);
    assert.equal(result.invoiceDate.value, null, label);
    assert.equal(result.dueDate.value, null, label);
  }
  const shared = parseDraft('Acme Ltd Date: 2026-10-20 Due - Date: 2026-11-04 Payment Date: 2026-10-22');
  assert.equal(shared.invoiceDate.value, '2026-10-20');
  assert.equal(shared.dueDate.value, '2026-11-04');
  assert.equal(parseDraft('Invoice-Date: 2026-10-20').invoiceDate.value, '2026-10-20');
  assert.equal(parseDraft('Invoice Date: 2026-02-30').invoiceDate.value, null);
});

test('otherwise valid headerless rows stay unread; headers, continuations and the item cap remain bounded', () => {
  const rows = 'Cotton fabric roll 10 1,200.00 12,000.00\nPacking 1 250.00 250.00';
  assert.deepEqual(parseDraft(rows).lineItems.value, []);
  assert.deepEqual(parseDraft(`Description Qty UnitPrice Amount\n${rows}\nFuel surcharge 630.00`).lineItems.value.map(item => item.description), ['Cotton fabric roll', 'Packing']);
  const many = parseDraft('Description Qty Rate Amount\n' + 'Packing 1 2.00 2.00\n'.repeat(150), {ocrConfidence:100});
  assert.equal(many.lineItems.value.length, 100);
});

test('all confidence inputs preserve the complete always-review contract', () => {
  for (const ocrConfidence of [undefined, null, NaN, Infinity, -1, 0, 1, 71, 95, 100, 101, '95']) {
    const result = parseDraft(fixtures[0][1], {ocrConfidence});
    if (!(Number.isFinite(ocrConfidence) && ocrConfidence >= 0 && ocrConfidence <= 100)) {
      for (const name of uncertainFields) assert.equal(result[name].confidence, 0, name);
      assert.ok(result.lineItems.value.every(item => item.confidence === 0));
    }
  }
});

test('adversarial bounded OCR finishes under an external process deadline', () => {
  // A synchronous regex cannot be interrupted by node:test or OCR timers.
  // The subprocess timeout also catches a future event-loop blocking regression.
  const parserUrl = new URL('../ai/image-text.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {parseOfflineInvoiceText} from ${JSON.stringify(parserUrl)};
    const probes = [
      'Taxable' + ' '.repeat(99990) + 'x',
      'Taxable' + '\\t'.repeat(99990) + 'x',
      'Total: ' + '9'.repeat(99990),
      'Total: 1' + ','.repeat(99980) + 'x',
      'Due' + ' '.repeat(99970) + 'Date: 2026-11-04',
      'Description Qty Rate Amount\\n' + 'Item ' + '9'.repeat(99950) + ' x',
      'Total: '.repeat(14000),
    ];
    for (const text of probes) {
      const result = parseOfflineInvoiceText(text, {ocrConfidence:95});
      assert.equal(result.reviewRequired, true);
      assert.equal(result.direction.value, 'uncertain');
      assert.ok(result.ocr.text.length <= 100000);
      assert.equal(result.total.value, null);
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {timeout:5000, stdio:'pipe'});
});


test('v3 money boundaries preserve adjacent identity/date labels and pipe-separated fields', () => {
  for (const suffix of ['Due Date: 2026-11-04', 'Invoice No: INV-1', '| Balance Due: INR 0.00']) {
    assert.equal(parseDraft(`Total: INR 118.00 ${suffix}`).total.value, 118, suffix);
  }
  const conflict = parseDraft('Total: INR 100.00\nGrand Total: INR 120.00 Due Date: 2026-11-04');
  assert.equal(conflict.total.value, null);
  assert.ok(conflict.warnings.some(warning => /Conflicting printed total/.test(warning)));
  assert.equal(parseDraft('Total: 1 20,000.00 Due Date: 2026-11-04').total.value, null);
  assert.equal(parseDraft('Description Qty Rate Amount\nTotal 1 20.00 20.00').total.value, null);
});

test('v3 explicit billing names allow company digits/road words and stop at the next field', () => {
  for (const name of ['3M India Ltd', 'Road Runner Logistics']) {
    assert.equal(parseDraft(`Bill To: ${name}`).customerName.value, name);
  }
  const shared = parseDraft('Bill To: Real Buyer Invoice Date: 2026-10-20');
  assert.equal(shared.customerName.value, 'Real Buyer');
  assert.equal(shared.invoiceDate.value, '2026-10-20');
  assert.equal(parseDraft('Ship To:\nWarehouse gate two\nBill To: Real Buyer').customerName.value, 'Real Buyer');
  assert.equal(parseDraft('To:\n14 MG Road').customerName.value, null);
});

test('v3 invoice totals remain independent of remaining due values', () => {
  for (const dueLabel of ['Total Due', 'Amount Due']) {
    const result = parseDraft(`Total: INR 100.00\n${dueLabel}: INR 50.00\nBalance Due: INR 50.00`);
    assert.equal(result.total.value, 100);
    assert.equal(result.outstandingAmount.value, 50);
    assert.ok(!result.warnings.some(warning => /conflict|differs/i.test(warning)));
  }
  assert.equal(parseDraft('Total Due: INR 50.00').total.value, 50);
  const conflict = parseDraft('Total: INR 100.00\nGrand Total: INR 120.00\nTotal Due: INR 50.00');
  assert.equal(conflict.total.value, null);
  assert.ok(conflict.warnings.some(warning => /Conflicting printed total/.test(warning)));
});

test('v3 ordinary header text permits bare Date while genuine qualifiers stay excluded', () => {
  assert.equal(parseDraft('Acme Ltd Date: 2026-10-20').invoiceDate.value, '2026-10-20');
  for (const label of ['Payment Date', 'Delivery Date', 'Due-Date', 'Due - Date', 'Settlement Date']) {
    assert.equal(parseDraft(`${label}: 2026-11-04`).invoiceDate.value, null, label);
  }
});


test('complete monetary fields retain numeric pipe continuations', () => {
  for (const text of ['Description Qty Rate Amount\nTotal 1 | 20.00 | 20.00', 'Total: 1 |20,000.00', 'Total: INR 12.00 || 3.00', 'Total: 8 | 9 Invoice No: X-1']) {
    assert.equal(parseOfflineInvoiceText(text).total.value, null, text);
  }
  const draft = parseOfflineInvoiceText('Total: INR 118.00 | Balance Due: INR 0.00');
  assert.equal(draft.total.value, 118);
  assert.equal(draft.outstandingAmount.value, 0);
});

test('date qualifiers use invoice-label allowlist semantics', () => {
  for (const label of ['Expiry Date', 'Print Date', 'Tax Point Date', 'Shipping Date', 'Delivery Date', 'Payment Date', 'Inspection Date', 'Renewal-Date']) {
    assert.equal(parseOfflineInvoiceText(`Acme Ltd\n${label}: 2026-10-20`).invoiceDate.value, null, label);
  }
  assert.equal(parseOfflineInvoiceText('Acme Ltd Date: 2026-10-20').invoiceDate.value, '2026-10-20');
});

test('customer boundaries consume complete date and identity labels', () => {
  for (const label of ['Shipping Date', 'Delivery Date', 'Invoice-Date', 'Tax Point Date', 'Inspection Date', 'Invoice #', 'Total', 'Subtotal', 'Currency', 'Phone', 'GSTIN']) {
    assert.equal(parseOfflineInvoiceText(`Bill To: Real Buyer ${label}: 2026-10-20`).customerName.value, 'Real Buyer', label);
  }
});

test('all date and invoice identity boundaries preserve total conflicts', () => {
  for (const label of ['Date', 'Payment Date', 'Invoice #', 'Invoice No', 'Inspection Date']) {
    const single = parseOfflineInvoiceText(`Total: INR 118.00 ${label}: INV-1`);
    assert.equal(single.total.value, 118, label);
    const conflict = parseOfflineInvoiceText(`Total: INR 100.00\nGrand Total: INR 120.00 ${label}: 2026-10-20`);
    assert.equal(conflict.total.value, null, label);
    assert.ok(conflict.warnings.some(w => /Conflicting printed total/.test(w)), label);
  }
});
test('complete adjacent labels preserve amounts and expose conflicting totals without truncating numeric columns', () => {
  for (const suffix of ['Bill To: Real Buyer', 'Billed To: Another Buyer', 'Valid Until Date: 2026-10-20',
    '; Balance Due: INR 0.00', ';; Balance Due: INR 0.00', '|; Balance Due: INR 0.00',
    'Address: 14 MG Road', 'Billing Address: 14 MG Road', 'Valid Through Date: 2026-10-20', 'GSTIN 29ABCDE1234F1Z5', 'Tax Point Date: 2026-10-20']) {
    const standalone = parseOfflineInvoiceText(`Total: INR 118.00 ${suffix}`);
    assert.equal(standalone.total.value, 118, suffix);
    const conflict = parseOfflineInvoiceText(`Total: INR 100.00\nGrand Total: INR 120.00 ${suffix}`);
    assert.equal(conflict.total.value, null, suffix);
    assert.ok(conflict.warnings.some(w => /Conflicting printed total/.test(w)), suffix);
  }
  for (const suffix of ['|20,000.00', ';20,000.00', '|| 20.00 | 20.00', ';; 20.00 ; 20.00', '|; 20.00']) {
    assert.equal(parseOfflineInvoiceText(`Total: 1 ${suffix}`).total.value, null, suffix);
  }
});

test('billing names stop before complete adjacent labels with and without colons', () => {
  for (const suffix of ['Date: 2026-10-20', 'Address: 14 MG Road', 'Shipping Address: 14 MG Road', 'Valid Until Date: 2026-10-20', 'GSTIN 29ABCDE1234F1Z5',
    'GSTIN: 29ABCDE1234F1Z5', 'Tax Point Date: 2026-10-20', 'Shipping Date: 2026-10-20',
    'Delivery Date: 2026-10-20', 'Invoice-Date: 2026-10-20', 'Phone 9876543210', 'Ship To: Warehouse']) {
    assert.equal(parseOfflineInvoiceText(`Bill To: Real Buyer ${suffix}`).customerName.value, 'Real Buyer', suffix);
  }
});

test('bare Date accepts ordinary headers while complete qualified date labels remain excluded', () => {
  for (const header of ['Acme Textiles', 'ACME', 'Seller Name', 'North Star Trading', 'Acme Ltd', 'Seller 42']) {
    assert.equal(parseOfflineInvoiceText(`${header} Date: 2026-10-20`).invoiceDate.value, '2026-10-20', header);
  }
  assert.equal(parseOfflineInvoiceText('Custom-Event-Date: 2026-10-20').invoiceDate.value, null);
  for (const label of ['Valid Until', 'Valid Through', 'Supply', 'Order', 'Receipt', 'Expiry', 'Print', 'Tax Point',
    'Shipping', 'Delivery', 'Payment', 'Dispatch', 'Purchase', 'Transaction', 'Posting', 'Audit', 'Review']) {
    for (const separator of [' ', '-', ' - ']) {
      for (const header of ['', 'Acme Textiles ']) {
        assert.equal(parseOfflineInvoiceText(`${header}${label}${separator}Date: 2026-10-20`).invoiceDate.value, null, `${header}${label}${separator}Date`);
      }
    }
  }
});

test('ordinary words inside explicit customer names are never field boundaries', () => {
  for (const name of ['Acme Tax Advisors','Acme Currency Exchange','Client First Ltd','Customer Success Partners',
    'Fresh GST Consultants','Harbor Shipping Address Services','North Invoice Design','Phone House Trading',
    'Mobile Works Ltd','Total Care Partners','Delivery Date Planners','Address Book Company','VAT Consulting Group','Tax 2026 Advisors','Total 24 Care Ltd','Tax 2026 Address Services']) {
    assert.equal(parseOfflineInvoiceText(`Bill To: ${name}`).customerName.value,name,name);
    for (const suffix of ['GSTIN 29ABCDE1234F1Z5','Phone 9876543210','Mobile: +919876543210','Tax: INR 18.00','Currency INR']) {
      assert.equal(parseOfflineInvoiceText(`Bill To: ${name} ${suffix}`).customerName.value,name,`${name} / ${suffix}`);
    }
  }
});

test('recognized multiword labels retain both total candidates in every shared-line order', () => {
  for (const label of ['Payment Received Date','Expected Delivery Date','Original Invoice Date','Estimated Ship Date',
    'Revised Payment Received Date','Actual Service Completion Date','Scheduled Dispatch Date','Requested Delivery Date']) {
    for (const separator of [' ',' | ',' ; ']) for (const reverse of [false,true]) {
      const amounts = [`Total: INR 100.00`, `Grand Total: INR 120.00${separator}${label}: 2026-10-20`];
      const result = parseOfflineInvoiceText((reverse ? amounts.reverse() : amounts).join('\n'));
      assert.equal(result.total.value,null,label);
      assert.ok(result.warnings.some(w=>/Conflicting printed total/.test(w)),label);
      assert.equal(parseOfflineInvoiceText(`Total: INR 118.00${separator}${label}: 2026-10-20`).total.value,118,label);
    }
  }
});

test('recognized multiword labels consume their complete phrase after customer spans', () => {
  for (const name of ['Real Buyer','Customer Success Partners','Tax Exchange Shipping Ltd']) {
    for (const label of ['Payment Received Date','Expected Delivery Date','Original Invoice Date','Estimated Ship Date',
      'Revised Payment Received Date','Actual Service Completion Date','Scheduled Dispatch Date','Requested Delivery Date']) {
      assert.equal(parseOfflineInvoiceText(`Bill To: ${name} ${label}: 2026-10-20`).customerName.value,name,label);
    }
  }
});

test('unknown complete labels use explicit layout separators and preserve money and customer spans', () => {
  for (const label of ['Unlisted Warranty Window','Novel Fulfilment Checkpoint','Custom Event Date','Warehouse Intake Reference','Warehouse Stage 2 Reference','Warehouse Ref. #2','Custom Stage/Phase_2']) {
    for (const separator of [' | ',' ; ','  ','\t']) {
      const result=parseOfflineInvoiceText(`Total: INR 100.00\nGrand Total: INR 120.00${separator}${label}: abc-2026`);
      assert.equal(result.total.value,null,label);
      assert.ok(result.warnings.some(w=>/Conflicting printed total/.test(w)),label);
      assert.equal(parseOfflineInvoiceText(`Total: INR 118.00${separator}${label}: abc-2026`).total.value,118,label);
      assert.equal(parseOfflineInvoiceText(`Bill To: Real Buyer${separator}${label}: abc-2026`).customerName.value,'Real Buyer',label);
      const spaced=label.replaceAll(' ','  ');
      assert.equal(parseOfflineInvoiceText(`Total: INR 118.00${separator}${spaced}: abc-2026`).total.value,118,spaced);
      assert.equal(parseOfflineInvoiceText(`Bill To: Real Buyer${separator}${spaced}: abc-2026`).customerName.value,'Real Buyer',spaced);
    }
  }
});

test('qualified dates never promote through a bare Date suffix while business headers remain valid', () => {
  for (const qualifier of ['Cancellation','Bank','Estimated Ship','Reconciliation','Provisional Settlement',
    'Vendor Audit','Unlisted Retention','Original Invoice','Payment Received','Zorblax','Provisional42','Unlisted Invoice','Provisional Event Invoice']) {
    for (const separator of [' ','-',' - ']) {
      const label=qualifier.split(' ').join(separator)+separator+'Date';
      assert.equal(parseOfflineInvoiceText(`${label}: 2026-10-20`).invoiceDate.value,null,label);
      if (qualifier.includes(' ') && !qualifier.endsWith('Invoice')) assert.equal(parseOfflineInvoiceText(`${label.toUpperCase()}: 2026-10-20`).invoiceDate.value,null,label);
      assert.equal(parseOfflineInvoiceText(`Seller: Acme Ltd | ${label}: 2026-10-20`).invoiceDate.value,null,label);
      for (const boundary of [' | ',' ; ','  ','\t']) {
        assert.equal(parseOfflineInvoiceText(`Bill To: Real Buyer${boundary}${label}: 2026-10-20`).invoiceDate.value,null,label);
      }
    }
  }
  for (const header of ['', 'Acme Textiles ', 'ACME ', 'Seller Name ', 'North Star Trading ', 'Seller 42 ', 'Blue Finch Consultants ', 'Meridian Industries ', 'Hill View LLP ', 'ZQRT ', 'Business Name ', '18 Harbour Road, Chennai 600001 ']) {
    assert.equal(parseOfflineInvoiceText(`${header}Date: 2026-10-20`).invoiceDate.value,'2026-10-20',header);
  }
  assert.equal(parseOfflineInvoiceText('Invoice Date: 2026-10-20').invoiceDate.value,'2026-10-20');
  assert.equal(parseOfflineInvoiceText('Due Date: 2026-10-20').invoiceDate.value,null);
});
