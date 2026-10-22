import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_BYTES, MAX_ROWS, parseTally} from '../integrations/tally.mjs';

const voucher = (extra = '', fields = {}) => `<VOUCHER VCHTYPE="Sales"><DATE>${fields.date || '20261001'}</DATE><VOUCHERNUMBER>${fields.number || 'S-1'}</VOUCHERNUMBER><PARTYLEDGERNAME>Acme</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme</LEDGERNAME><AMOUNT>${fields.amount || '-100.00'}</AMOUNT></ALLLEDGERENTRIES.LIST>${extra}</VOUCHER>`;
const xml = body => `<ENVELOPE>${body}</ENVELOPE>`;

test('malformed XML and nested vouchers fail instead of importing a second hidden invoice', () => {
  for (const source of [
    '<ENVELOPE><VOUCHER VCHTYPE="Sales"></ENVELOPE>',
    '<ENVELOPE><VOUCHER VCHTYPE="Sales"/>',
    xml('<VOUCHER><DATE>20261001</DATE></VOUCHER>'),
    xml(voucher(voucher())),
    xml(`<VOUCHER VCHTYPE="Purchase">${voucher()}</VOUCHER>`),
    xml('<LEDGER NAME="Acme &unknown;"/>'),
    xml('<LEDGER NAME="Acme" NAME="Other"/>'),
    xml('<LEDGER NAME="Acme"><!-- malformed -- comment --></LEDGER>'),
    xml('<LEDGER NAME="Acme"><EMAIL>&#0;</EMAIL></LEDGER>'),
    '<![CDATA[outside]]><ENVELOPE/>',
    '<ENVELOPE></ENVELOPE>tail',
  ]) assert.throws(() => parseTally('bad.xml', source));
  const missing = parseTally('missing.xml', xml('<VOUCHER VCHTYPE="Sales"><PARTYLEDGERNAME>Acme</PARTYLEDGERNAME></VOUCHER>'));
  assert.ok(missing.errors.length, 'missing invoice tags must block confirmation');
  assert.throws(() => parseTally('duplicate.xml', xml(voucher('<DATE>20261002</DATE>'))), /Ambiguous XML field DATE/);
});

test('XML entities and greater-than attributes decode while unused GST and tax fields stay ignored', () => {
  const source = xml('<LEDGER NAME="Acme &gt; Co"><PARENT>Sundry Debtors</PARENT><GSTIN>bad-but-unused</GSTIN><TAXRATE>not-a-number</TAXRATE></LEDGER>' + voucher('<GSTIN>unused</GSTIN><TAXAMOUNT>broken</TAXAMOUNT>'));
  const result = parseTally('tax.xml', source);
  assert.equal(result.errors.length, 0);
  assert.equal(result.customers[0].name, 'Acme > Co');
  assert.equal(result.invoices[0].total, '100.00');
  assert.equal(result.invoices[0].gstin, undefined);
  assert.equal(result.customers[0].taxrate, undefined);
});

test('CSV quoted commas, escaped quotes and unused GST/tax fields preserve exact party and invoice totals', () => {
  const result = parseTally('sales.csv', 'Voucher Number,Party Ledger Name,Date,Amount,GSTIN,Tax Rate\r\nS-1,"Acme, ""North"" Ltd",20261001,"1,234.56",junk,ignored\r\n');
  assert.equal(result.errors.length, 0);
  assert.equal(result.invoices[0].customer, 'Acme, "North" Ltd');
  assert.equal(result.customers[0].name, 'Acme, "North" Ltd');
  assert.equal(result.invoices[0].total, '1234.56');
  assert.equal(result.invoices[0].gstin, undefined);
  assert.equal(result.invoices[0].taxrate, undefined);
});

test('invoice numbers may repeat for different customers without parser merging invoices', () => {
  const result = parseTally('sales.csv', 'Voucher Number,Customer,Date,Amount\nS-1,Acme,20261001,100\nS-1,Other,20261001,200');
  assert.equal(result.errors.length, 0);
  assert.equal(result.invoices.length, 2);
  assert.deepEqual(result.invoices.map(v => [v.number,v.customer]), [['S-1','Acme'],['S-1','Other']]);
});

test('workspace currency defaults are explicit and supported foreign currencies are preserved without conversion', () => {
  const result = parseTally('sales.csv', 'Voucher Number,Customer,Date,Amount,Currency\nS-1,Acme,20261001,100,\nS-2,Other,20261001,200,EUR', {workspaceCurrency:'USD'});
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.invoices.map(v => [v.total,v.currency]), [['100','USD'],['200','EUR']]);
  const foreign = parseTally('sales.xml', xml(voucher('<CURRENCYNAME>EUR</CURRENCYNAME>')), {workspaceCurrency:'USD'});
  assert.equal(foreign.invoices[0].currency, 'EUR');
  assert.equal(foreign.invoices[0].total, '100.00');
  assert.equal(parseTally('sales.xml', xml(voucher()), {workspaceCurrency:'USD'}).invoices[0].currency, 'USD');
  for (const currency of ['JPY','KWD','BHD','US Dollars']) {
    assert.ok(parseTally('currency.xml', xml(voucher(`<CURRENCYNAME>${currency}</CURRENCYNAME>`))).errors.some(error => error.includes('two-decimal currencies')));
  }
  const formatted = parseTally('sales.xml', xml(voucher('', {amount:'-USD 100 @ 83 = INR 8300'})));
  assert.ok(formatted.errors.length, 'ambiguous foreign amount must never become a base-currency total');
  assert.throws(() => parseTally('sales.xml', xml(voucher()), {workspaceCurrency:'JPY'}), /two-decimal currencies/);
});

test('file cap is measured in UTF-8 bytes and accepts a valid export exactly at the cap', () => {
  const prefix = 'Name,GSTIN\nAcme,';
  const atCap = prefix + 'x'.repeat(MAX_BYTES - Buffer.byteLength(prefix));
  const result = parseTally('large.csv', atCap);
  assert.equal(result.errors.length, 0);
  assert.equal(result.customers.length, 1);
  assert.throws(() => parseTally('large.csv', atCap + 'x'), /Maximum file size/);
  const unicode = prefix + 'é'.repeat(Math.floor((MAX_BYTES - Buffer.byteLength(prefix)) / 2) + 1);
  assert.ok(unicode.length < MAX_BYTES);
  assert.throws(() => parseTally('large.csv', unicode), /Maximum file size/);
});

test('source row limits include XML records and accept the exact CSV boundary', () => {
  const result = parseTally('ledgers.csv', 'Name\n' + Array.from({length:MAX_ROWS}, (_,i) => `Customer ${i}`).join('\n'));
  assert.equal(result.customers.length, MAX_ROWS);
  assert.equal(result.errors.length, 0);
  assert.throws(() => parseTally('ledgers.xml', xml('<LEDGER NAME="Acme"/>'.repeat(MAX_ROWS+1))), /Maximum 2000 rows/);
});

 test('NUL characters in CSV fields fail before a database request can be formed', () => {
  for (const source of ['Name,Email,GUID\nAcme,person@example.com,bad\0guid', 'Name,Email\nAcme,person\0@example.com']) {
    assert.throws(() => parseTally('bad.csv', source), /Invalid NUL character/);
  }
});
