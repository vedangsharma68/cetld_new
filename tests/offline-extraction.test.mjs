import {documentWithText} from './fixtures/invoice-document.mjs';
import {parseOfflineInvoiceText} from '../ai/image-text.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {extractInvoiceOffline} from '../ai/extraction.mjs';
import {parsePdfInvoiceText} from '../ai/pdf-invoice-parser.mjs';

const text=`INVOICE
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
Currency: USD`;

// A real, self-contained PDF with an optional text layer; no fixtures, URLs,
// fonts or provider keys need to be downloaded to run these tests.

test('real text-layer PDF uses extractPdfText + parsePdfInvoiceText without a provider and requires owner direction',async()=>{
  assert.ok(parsePdfInvoiceText(text,{businessName:'Acme Studio'}));
  const result=await extractInvoiceOffline({bytes:documentWithText(text),mimeType:'application/pdf',businessName:'Acme Studio'});
  assert.equal(result.extractionRoute,'offline');assert.equal(result.model,'offline-pdf-text');
  assert.equal(result.invoiceNumber.value,'INV-204');assert.equal(result.total.value,118);
  assert.equal(result.invoiceDate.value,'2026-01-03');assert.equal(result.currency.value,'USD');
  assert.equal(result.lineItems.value.length,1);
  assert.equal(result.direction.value,'uncertain');assert.equal(result.direction.confidence,0);
});

test('real PDF with no text layer returns the photo-instead rejection without any provider fallback',async()=>{
  await assert.rejects(extractInvoiceOffline({bytes:documentWithText(''),mimeType:'application/pdf'}),error=>{
    assert.equal(error.code,'OFFLINE_PDF_NO_TEXT');
    assert.equal(error.message,'This PDF has no readable text. Send a photo of the invoice instead.');return true;
  });
});

test('real local OCR reads a generated invoice using bundled English assets and keeps its confidence cap',async()=>{
  const lines=['Invoice No: OFFLINE-123','Bill To: Northwind','Invoice Date: 2026-10-20','Due Date: 2026-11-04','Total: INR 100.00'];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="700"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="sans-serif" font-size="42">${lines.map((line,i)=>`<text x="70" y="${90+i*100}">${line}</text>`).join('')}</g></svg>`;
  const bytes=await sharp(Buffer.from(svg)).png().toBuffer();
  const result=await extractInvoiceOffline({bytes,mimeType:'image/png'});
  assert.equal(result.invoiceNumber.value,'OFFLINE-123');assert.equal(result.total.value,100);
  assert.equal(result.invoiceDate.value,'2026-10-20');assert.equal(result.dueDate.value,'2026-11-04');
  assert.equal(result.currency.value,'INR');assert.ok(result.total.confidence<=.69);
  assert.equal(result.direction.value,'uncertain');assert.equal(result.reviewRequired,true);
});


test('conflicting inline PDF currency evidence requires owner resolution instead of accepting the first code',async()=>{
  const result=await extractInvoiceOffline({bytes:documentWithText(text.replace('Currency: USD','Currency: USD Currency: INR')),mimeType:'application/pdf'});
  assert.ok(result.conflictingFields.includes('currency'));
  assert.deepEqual(result.conflictingValues.currency.sort(),['INR','USD']);
});

test('PDF rupee symbols alone cannot silently resolve local review currency',async()=>{
  const result=await extractInvoiceOffline({bytes:Buffer.from('%PDF-1.4 fixture'),mimeType:'application/pdf',
    pdfTextExtractor:async()=>text.replace('Total 118.00','Total ₹118.00').replace('Currency: USD','')});
  assert.equal(result.currency.value,null);assert.equal(result.currency.confidence,0);
});


test('serial-number columns and normalized OCR spacing retain every row from the updated dependency parser',async()=>{
  const printed='Invoice No: INV-SR\nBill To: Northwind\nInvoice Date: 2026-10-20\nTotal: INR 100\nSr Description Qty Rate Amount\n1 Cotton   fabric 2 50 100';
  const result=await extractInvoiceOffline({bytes:Buffer.from([137,80,78,71,13,10,26,10,0]),mimeType:'image/png',
    imageExtractor:async()=>parseOfflineInvoiceText(printed,{ocrConfidence:99})});
  assert.equal(result.lineItems.value[0].description,'Cotton fabric');
  assert.equal(result.unresolvedFields.includes('lineItems'),false);
});
