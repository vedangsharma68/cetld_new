import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfInvoiceText } from '../ai/pdf-invoice-parser.mjs';

const bioplexText = `
Bioplex
we love chemistry
5 Rue Bader
Narbonne, Aude, 11100
Phone: +33 140 260294
INVOICE
INVOICE # BPXINV-00550
DATE: 23.05.2021
TO:
Roger Bigot
bonbono
4 Rue des Cites
Aubervilliers, Seine-Saint-Denis, 93300
Phone: +33 148 340990
SHIP TO:
Roger Bigot
bonbono
4 Rue des Cites
Aubervilliers, Seine-Saint-Denis, 93300
Phone: +33 148 340990
COMMENTS OR SPECIAL INSTRUCTIONS:
None
SALESPERSON P.O. NUMBER TERMS
Marianne de la Guillaume BPXPO-00536 Due after 30 days
QUANTITY DESCRIPTION UNIT PRICE TOTAL
10 Dextromethorphan polistirex
BPXPN -00057
12.45 124.50
25 Venlafaxine Hydrochloride
BPXPN -00012
16.00 400.00
25 Metoclopramide Hydrochloride (BPXPO -00537)
BPXPN -00002
9.99 249.75
10 Avobenzone, octinoxate (BPXPO -00538)
BPXPN -00027
4.45 44.50
10 Verapamil hydrochloride
BPXPN -00066
7.89 78.90
15 Tiagabine hydrochloride
BPXPN -00017
10.25 153.75
10 Ziprasidone hydrochloride (BPXPO -00537)
BPXPN -00044
34.99 349.90
10 Risperidone
BPXPN -00023
34.99 349.90
10 Metoprolol succinate
BPXPN -00067
34.99 349.90
10 Acetaminophen
BPXPN -00045
34.99 349.90
15 Sorafenib
BPXPN -00018
16.00 240.00
15 Telmisartan
BPXPN -00022
9.99 149.85
15 Famotidine
BPXPN -00068
4.45 66.75
15 Methylphenidate Hydrochloride
BPXPN -00005
7.89 118.35
100 Ibuprofen (BPXPO -00538) 0.99 99.00
BPXPN -00052
15 Metformin Hydrochloride (BPXPO -00538)
BPXPN -00046
2.15 32.25
15 Avobenzone, Octisalate and Octocrylene
BPXPN -00069
16.99 254.85
10 Carisoprodol
BPXPN -00070
34.99 349.90
10 Losartan Potassium
BPXPN -00047
34.99 349.90
10 Pentazocine Hydrochloride and Naloxone Hydrochloride
BPXPN -00051
34.99 349.90
25 Omeprazole
BPXPN -00071
9.99 249.75
25 Losartan Potassium
BPXPN -00019
4.45 111.25
10 Saline
BPXPN -00048
7.89 78.90
25 Titanium dioxide
BPXPN -00021
10.25 256.25
25 Bicalutamide (BPXPO -00538)
BPXPN -00049
2.15 53.75
15 Ampicillin sodium
BPXPN -00050
16.99 254.85
15 Octinoxate, Titanium Dioxide, Octisalate
BPXPN -00004
12.45 186.75
25 Cavia porcellus hair and cavia porcellus skin
BPXPN -00020
12.45 311.25
SUBTOTAL 5964.50
SALES TAX 596.45
SHIPPING & HANDLING 50.00
TOTAL DUE 6610.95
Make all checks payable to Bioplex
If you have questions, contact Marianne de la Guillaume, +33 140 260294,
marianne.guillaume @bioplex.fr
THANK YOU FOR YOUR BUSINESS!
`;

test('parses all 28 printed rows and reconciles subtotal, tax, shipping, and total', () => {
  const result = parsePdfInvoiceText(bioplexText);

  assert.ok(result);
  assert.equal(result.invoiceNumber.value, 'BPXINV-00550');
  assert.equal(result.customerName.value, 'Roger Bigot');
  assert.equal(result.invoiceDate.value, '2021-05-23');
  assert.equal(result.dueDate.value, null);
  assert.equal(result.subtotal.value, 5964.5);
  assert.equal(result.tax.value, 596.45);
  assert.equal(result.total.value, 6610.95);
  assert.equal(result.outstandingAmount.value, 6610.95);
  assert.equal(result.currency.value, null);
  assert.equal(result.clientPhone.value, '+33148340990');
  assert.equal(result.clientEmail.value, null);
  assert.equal(result.direction.value, 'uncertain');
  assert.equal(result.direction.confidence, 0);
  assert.equal(result.lineItems.value.length, 28);
  assert.equal(result.lineItems.value[0].description, 'Dextromethorphan polistirex');
  assert.deepEqual(
    [result.lineItems.value[0].quantity, result.lineItems.value[0].unitPrice, result.lineItems.value[0].amount],
    [10, 12.45, 124.5],
  );
  assert.deepEqual(
    [result.lineItems.value[14].description, result.lineItems.value[14].quantity, result.lineItems.value[14].unitPrice, result.lineItems.value[14].amount],
    ['Ibuprofen', 100, 0.99, 99],
  );
  assert.equal(Math.round(result.lineItems.value.reduce((sum, row) => sum + row.amount, 0) * 100), 596450);
  assert.deepEqual(Object.keys(result).sort(), [
    'clientEmail', 'clientPhone', 'currency', 'customerName', 'direction', 'dueDate', 'invoiceDate',
    'invoiceNumber', 'lineItems', 'notes', 'outstandingAmount', 'subtotal', 'tax', 'total',
  ].sort());
  for (const [key, value] of Object.entries(result)) {
    if (key === 'lineItems') continue;
    assert.deepEqual(Object.keys(value).sort(), ['confidence', 'value']);
  }
  for (const item of result.lineItems.value) {
    assert.deepEqual(Object.keys(item).sort(), ['amount', 'confidence', 'description', 'quantity', 'unitPrice']);
  }
});

test('classifies direction only when workspace identity matches an explicitly labeled invoice party', () => {
  const text = `
INVOICE
Invoice Number: INV-204
Invoice Date: 2026-01-03
FROM: Acme Studio
BILL TO: Northwind
QTY DESCRIPTION UNIT PRICE AMOUNT
2 Design consultation 50.00 100.00
Subtotal 100.00
Tax 18.00
Total 118.00
Amount Due 118.00
Currency: USD
`;

  const result = parsePdfInvoiceText(text, { businessName: 'Acme Studio' });
  assert.ok(result);
  assert.equal(result.direction.value, 'receivable');
  assert.equal(result.direction.confidence, 0.99);
  assert.equal(result.currency.value, 'USD');
  assert.equal(result.customerName.value, 'Northwind');
  assert.equal(result.lineItems.value.length, 1);
});

test('returns null when row amounts do not reconcile with the printed subtotal', () => {
  const mismatched = bioplexText.replace('12.45 124.50', '12.45 124.49');
  assert.equal(parsePdfInvoiceText(mismatched), null);
});

test('returns null when subtotal, tax, and explicit charges do not reconcile with total', () => {
  const mismatched = bioplexText.replace('SHIPPING & HANDLING 50.00', 'SHIPPING & HANDLING 49.00');
  assert.equal(parsePdfInvoiceText(mismatched), null);
});

