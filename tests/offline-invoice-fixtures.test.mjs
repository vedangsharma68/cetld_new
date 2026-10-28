import assert from 'node:assert/strict';
import test from 'node:test';
import {parseOfflineInvoiceText} from '../ai/image-text.mjs';

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
    const result = parseOfflineInvoiceText(text, {ocrConfidence:name.startsWith('inv4') ? 71 : 95});
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(key === 'lineItems' ? result[key].value.length : result[key].value, value, key);
    }
    assert.equal(result.reviewRequired, true);
    assert.deepEqual(result.direction, {value:'uncertain', confidence:0});
    assert.ok(result.warnings.some(warning => /Review every extracted value/.test(warning)));
    assert.ok(result.warnings.some(warning => /Direction is uncertain/.test(warning)));
    assert.equal(result.warnings.some(warning => /Currency code/.test(warning)), expected.currency === null);
    for (const [key, value] of Object.entries(result)) {
      if (value && typeof value === 'object' && 'confidence' in value && key !== 'ocr') assert.ok(value.confidence <= .69);
    }
    assert.ok(result.lineItems.value.every(item => item.confidence <= .69));
    assert.equal(result.ocr.text, text);
  });
}

test('bounded labels, valid dates, conflicting currencies and row shapes stay conservative', () => {
  const result = parseOfflineInvoiceText(`NotSubtotal: 99\nInvoice Date: 2026-02-30\nDue Date: 2026-11-04\nTotal: USD 10.00\nBalance Due: INR 0.00\nDescription Qty Rate Amount\nFuel surcharge 630.00\nPacking 1 2.00 2.00`);
  assert.equal(result.subtotal.value, null);
  assert.equal(result.invoiceDate.value, null);
  assert.equal(result.dueDate.value, '2026-11-04');
  assert.equal(result.currency.value, null);
  assert.equal(result.lineItems.value.length, 1);
  assert.equal(parseOfflineInvoiceText('x'.repeat(100000) + '\nTotal: INR 99.00').total.value, null);
});


test('clean and paid fixtures preserve item amounts without deriving a balance', () => {
  for (const [index, amounts] of [[0, [12000, 4750, 250]], [4, [18000, 7000]]]) {
    const result = parseOfflineInvoiceText(fixtures[index][1], {ocrConfidence:95});
    assert.deepEqual(result.lineItems.value.map(item => item.amount), amounts);
  }
  assert.equal(parseOfflineInvoiceText('Invoice Notes: sample').invoiceNumber.value, null);
  assert.equal(parseOfflineInvoiceText('Invoice No. AB-123').invoiceNumber.value, 'AB-123');
  assert.equal(parseOfflineInvoiceText('Due    Date: 2026-10-12').invoiceDate.value, null);
  assert.equal(parseOfflineInvoiceText('Total: Rs. 9.00').total.value, 9);
  assert.equal(parseOfflineInvoiceText('Total: USD 9.00').currency.value, 'USD');
});
