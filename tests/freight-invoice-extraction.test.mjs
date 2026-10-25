import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePdfInvoiceText,printedInvoiceNumber} from '../ai/pdf-invoice-parser.mjs';
import {validateInvoiceExtractionResponse,extractInvoice,invoiceExtractionPrompt} from '../ai/extraction.mjs';
import {reviewDraft} from '../automation/whatsapp/assistant-handler.mjs';
import {invoiceWire} from './invoice-wire-fixture.mjs';
import {freightInvoiceText,freightInvoicePdf} from './fixtures/freight-invoice-text.mjs';

const businessName='INTERNATIONAL PARCEL SERVICES';
test('freight invoice number, continuation surcharge, tax and rounding reconcile without a due date',()=>{
 const parsed=parsePdfInvoiceText(freightInvoiceText,{businessName});
 assert.ok(parsed);
 assert.equal(parsed.invoiceNumber.value,'CR-25260643');
 assert.equal(parsed.invoiceDate.value,'2026-03-31');
 assert.equal(parsed.customerName.value,'KHEVAN CONSULTANTS OPC PVT LTD');
 assert.equal(parsed.direction.value,'receivable');
 assert.deepEqual(parsed.lineItems.value.map(row=>row.amount),[5033.60,450.45]);
 assert.match(parsed.lineItems.value[1].description,/DEMAND SURCHARGE/);
 assert.equal(parsed.subtotal.value,5484.05);assert.equal(parsed.tax.value,987.13);
 assert.equal(parsed.total.value,6471);assert.equal(parsed.currency.value,'INR');
 assert.equal(parsed.dueDate.value,null);
 const extracted=validateInvoiceExtractionResponse(parsed);
 assert(!extracted.uncertainFields.includes('lineItems'));
 const draft=reviewDraft(extracted,'pdf-1');
 assert.deepEqual(draft.missingFields,[]);assert.deepEqual(draft.validationIssues,[]);
 assert.equal(draft.invoice.dueDate,null);
});

test('the parser generalizes to other numbers, amount values, and extra continuation charges',()=>{
 const changed=freightInvoiceText.replace('CR-25260643','AB/2027-0099').replaceAll('5033.60','100.00')
  .replace('3520.00 0.00 1513.60','80.00 0.00 20.00').replace('315.00 135.45 450.45','8.00 2.00 10.00\nREMOTE AREA FEE 4.00 1.00 5.00')
  .replaceAll('5484.05','115.00').replace('987.13','20.70').replace('0.18','0.30').replace('6471.00','136.00');
 const parsed=parsePdfInvoiceText(changed,{businessName});
 assert.ok(parsed);assert.equal(parsed.invoiceNumber.value,'AB/2027-0099');
 assert.deepEqual(parsed.lineItems.value.map(row=>row.amount),[100,10,5]);
 assert.equal(parsed.subtotal.value,115);
});

test('omitted charge and non-reconciling components are never promoted to verified text',()=>{
 for(const text of [freightInvoiceText.replace('DEMAND\nSURCHARGE 315.00 135.45 450.45\n',''),
  freightInvoiceText.replace('315.00 135.45','314.00 135.45'),
  freightInvoiceText.replace('Rounded off: 0.18','Rounded off: 0.19')])assert.equal(parsePdfInvoiceText(text),null);
 const parsed=parsePdfInvoiceText(freightInvoiceText,{businessName});
 parsed.lineItems.value.pop();
 const draft=reviewDraft(validateInvoiceExtractionResponse(parsed));
 assert(draft.validationIssues.includes('UNCERTAIN_LINE_ITEMS'));
});

test('printed identity survives an unrecognized table and placeholder provider output is discarded',()=>{
 assert.equal(printedInvoiceNumber('Unrecognized table\nInvoice No.: ZX-123/45'), 'ZX-123/45');
 assert.equal(printedInvoiceNumber('Invoice No.: A-1\nInvoice No.: A-2'),null);
 for(const placeholder of ['AUTO','auto','N/A','unknown','not shown','TBD']){
  const parsed=parsePdfInvoiceText(freightInvoiceText,{businessName});
  parsed.invoiceNumber.value=placeholder;
  const result=validateInvoiceExtractionResponse(parsed);
  assert.equal(result.invoiceNumber.value,null);assert(result.uncertainFields.includes('invoiceNumber'));
  assert(reviewDraft(result).missingFields.includes('invoiceNumber'));
 }
 assert.match(invoiceExtractionPrompt(),/continuation rows/);
});


test('real PDF text extraction reads every freight row before calling a provider',async()=>{
 let calls=0;
 const result=await extractInvoice({bytes:freightInvoicePdf(),mimeType:'application/pdf',businessName,
  provider:{async generateStructured(){calls++;throw Error('Reconciled text must be deterministic');}}});
 assert.equal(calls,0);assert.equal(result.model,'verified-pdf-text');
 assert.equal(result.invoiceNumber.value,'CR-25260643');assert.equal(result.dueDate.value,null);
 assert.deepEqual(result.lineItems.value.map(row=>row.amount),[5033.6,450.45]);
});

test('printed number overrides a provider omission even when table parsing falls back',async()=>{
 const parsed=parsePdfInvoiceText(freightInvoiceText,{businessName});
 parsed.invoiceNumber={value:'AUTO',confidence:.99};
 parsed.dueDate={value:'2026-04-30',confidence:.99};
 let calls=0;
 const result=await extractInvoice({bytes:freightInvoicePdf(freightInvoiceText.replace('G.Total','Row total')),mimeType:'application/pdf',businessName,
  provider:{async generateStructured(options){calls++;return {data:options.validate(invoiceWire(parsed)),model:'fixture'};}}});
 assert.equal(calls,1);assert.equal(result.invoiceNumber.value,'CR-25260643');
 assert.equal(result.dueDate.value,null,'A provider cannot invent a date absent from the PDF');
});


test('a rupee symbol never overrides a printed currency code or admits an unsupported currency',()=>{
 assert.equal(parsePdfInvoiceText(freightInvoiceText+'\nCurrency: USD',{businessName}).currency.value,'USD');
 assert.equal(parsePdfInvoiceText(freightInvoiceText+'\nCurrency: JPY',{businessName}).currency.value,null);
});

test('fallback preserves an explicitly printed bare Due date',async()=>{
 const parsed=parsePdfInvoiceText(freightInvoiceText,{businessName});
 parsed.dueDate={value:'2026-04-30',confidence:.99};
 const result=await extractInvoice({bytes:freightInvoicePdf(freightInvoiceText.replace('G.Total','Row total')+'\nDue 30 April 2026'),mimeType:'application/pdf',businessName,
  provider:{async generateStructured(options){return {data:options.validate(invoiceWire(parsed)),model:'fixture'};}}});
 assert.equal(result.dueDate.value,'2026-04-30');
});
