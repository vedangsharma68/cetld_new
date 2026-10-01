import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveInvoiceDueDate, inferInvoiceCurrency} from '../ai/invoice-photo-inference.mjs';

const field = (value, confidence = .99) => ({value, confidence});

test('Summit US addresses infer USD and Net 30 derives the due date', () => {
  const extracted = {currency: field(null, 0), addressHint: field('Austin TX 78701; San Francisco CA 94105'),
    paymentTerms: field('Terms: Net 30')};
  const inferred = inferInvoiceCurrency(extracted, 'Subtotal $6,190.00', 'INR');
  assert.equal(inferred.currency, 'USD');
  assert.match(inferred.source, /US/i);
  assert.deepEqual(deriveInvoiceDueDate('2026-07-20', null, 'Terms: Net 30'),
    {dueDate: '2026-08-19', source: 'derived from Net 30'});
});

test('GST and Indian PIN infer INR', () => {
  const result = inferInvoiceCurrency({currency: field(null, 0), addressHint: field('GSTIN 27ABCDE1234F1Z5, Mumbai 400001')}, '₹11,800', 'USD');
  assert.equal(result.currency, 'INR');
  assert.equal(result.assumed, false);
});

test('ambiguous dollar uses a dollar workspace default and is flagged assumed', () => {
  assert.deepEqual(inferInvoiceCurrency({currency: field(null, 0)}, 'Total $100', 'CAD'),
    {currency: 'CAD', source: 'ambiguous $ symbol; assumed CAD', assumed: true});
});

test('explicit unsupported currencies are never mapped to another currency', () => {
  const result = inferInvoiceCurrency({currency: field('JPY')}, 'Total ¥1000', 'INR');
  assert.equal(result.currency, null);
  assert.equal(result.unsupportedCurrency, 'JPY');
  assert.equal(result.assumed, false);
});

test('due date helper supports printed, receipt, due-in, and absent terms', () => {
  assert.deepEqual(deriveInvoiceDueDate('2026-07-20', '2026-07-21', 'Net 30'), {dueDate: '2026-07-21', source: 'printed'});
  assert.equal(deriveInvoiceDueDate('2026-07-20', null, 'Due on receipt').dueDate, '2026-07-20');
  assert.equal(deriveInvoiceDueDate('2026-07-20', null, 'Due in 15 days').dueDate, '2026-08-04');
  assert.deepEqual(deriveInvoiceDueDate('2026-07-20', null, ''), {dueDate: null, source: 'not shown'});
});
