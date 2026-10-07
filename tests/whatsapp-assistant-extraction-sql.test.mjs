import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {extractInvoice, validateInvoiceExtractionWireResponse} from '../ai/extraction.mjs';
import {validateAssistantInvoice} from '../ai/invoice-ops.mjs';
import {DEFAULT_EXTRACTION_MODEL} from '../ai/provider.mjs';

const phone = '+919871367051';
const media = {bytes: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), mimeType: 'image/png', fileName: 'invoice.png'};

function invoiceWire(patch = {}) {
  const facts = {invoiceNumber:'PRINTED-118', customerName:'Fixture customer', invoiceDate:'2026-10-01', dueDate:null,
    subtotal:100, tax:18, total:118, outstandingAmount:118, currency:'USD', clientPhone:'+14155550244',
    clientPhoneRaw:null, clientEmail:null, notes:null, direction:'receivable', currencySource:null, addressHint:null, paymentTerms:null};
  return {...Object.fromEntries(Object.entries(facts).flatMap(([name,value]) => [[name,value], [`${name}Confidence`,value === null ? 0 : .99]])),
    lineItems:[{description:'Fixture service',quantity:1,unitPrice:100,amount:100,confidence:.99}], lineItemsConfidence:.99, ...patch};
}

async function fixture(wire, {providerError} = {}) {
  const f = await createOfflineSqlNetwork(), ownerId = randomUUID();
  await f.db.query('insert into auth.users(id) values($1)', [ownerId]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId = (await f.db.query('select (public.create_workspace($1,$2)).id', ['Fixture studio',randomUUID()])).rows[0].id;
  const verification = (await f.db.query('select * from public.owner_start_whatsapp_verification($1,$2)', [workspaceId,phone])).rows[0];
  await f.db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
  assert.equal((await f.db.query('select public.whatsapp_verify_owner_code($1,$2) value', [phone,verification.code])).rows[0].value.ok, true);
  const binding = (await f.db.query('select * from public.whatsapp_resolve_verified_owner($1)', [phone])).rows[0];
  const scope = {workspaceId,customerId:binding.customer_id,phone};
  let extractionCalls = 0;
  const handler = createWhatsAppBoundMessageHandler({supabase:f.supabase, authorizeScope:async () => true,
    clock:() => new Date('2026-10-07T00:00:00Z'), logger:{error(){},warn(){}},
    providerFactory:options => ({async generateStructured(request) {
      extractionCalls++;
      assert.equal(options.requestPurpose, 'extraction');
      assert.equal(options.primaryModel, DEFAULT_EXTRACTION_MODEL);
      assert.equal(request.name, 'invoice_extraction');
      assert.equal(request.messages[0].content[1].type, 'image_url');
      if (providerError) throw providerError;
      return {data:request.validate(structuredClone(wire)), model:'gemini-3.5-flash-lite', usedFallback:false};
    }}),
    // Run the actual extraction wire adaptation and validation without OCR or
    // any external provider request. Real pending, invoice and file stores run.
    extract:input => extractInvoice({...input,imageExtractor:async () => null}),
    channelFactory:() => ({async ask() { throw Error('Incomplete review must not reach the planner'); }}),
  });
  const pending = createWhatsAppPendingActionStore({supabase:f.supabase});
  return {...f,scope,handler,pending,get extractionCalls(){return extractionCalls;},
    async turn(sourceMessageId = 'wire-photo') { return handler({...scope,message:'log this invoice',messageId:sourceMessageId,media}); },
    async assertNoInvoiceWrites() {
      for (const table of ['invoices','invoice_files','payments']) assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0);
      assert.equal(f.requests.some(request => request.url.includes('/storage/v1/object/')), false);
      assert.deepEqual(f.errors, []);
    }};
}

test('successful real extraction with contradictory high-confidence money remains an incomplete SQL review', async () => {
  const wire = invoiceWire({subtotal:90,tax:10,lineItems:[{description:'Service',quantity:1,unitPrice:90,amount:90,confidence:.99}]});
  const extracted = validateInvoiceExtractionWireResponse(wire);
  assert.equal(extracted.total.confidence, .99);
  assert.ok(extracted.uncertainFields.includes('total'));
  assert.throws(() => validateAssistantInvoice({invoiceNumber:wire.invoiceNumber, clientName:wire.customerName,
    invoiceDate:wire.invoiceDate,dueDate:null,subtotal:wire.subtotal,tax:wire.tax,total:wire.total,
    outstanding:wire.outstandingAmount,currency:wire.currency,direction:'receivable'}),
  {code:'INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX'});
  const f = await fixture(wire);
  try {
    assert.match(await f.turn('inconsistent-source'), /subtotal plus tax does not match the total.*Nothing was saved/);
    const review = await f.pending.loadInvoiceReview(f.scope);
    assert.equal(review.action.stage, 'incomplete');
    assert.equal(review.action.sourceMessageId, 'inconsistent-source');
    assert.equal(review.action.failureCode, 'INVOICE_REVIEW_INCOMPLETE');
    assert.equal(review.action.invoice.invoiceNumber, 'PRINTED-118');
    assert.equal(review.action.invoice.clientName, 'Fixture customer');
    assert.equal(review.action.invoice.subtotal, 90);
    assert.equal(review.action.invoice.tax, 10);
    assert.equal(review.action.invoice.total, 118);
    assert.ok(review.action.missingFields.includes('total'));
    assert.ok(review.action.validationIssues.includes('INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX'));
    assert.match(await f.handler({...f.scope,message:'yes',messageId:'confirm-inconsistent'}), /can’t confirm an incomplete/);
    await f.assertNoInvoiceWrites();
    assert.equal(f.extractionCalls, 1);
  } finally { await f.close(); }
});

test('uncertain real extraction money is retained without promoting a proposal or saving', async t => {
  for (const [patch, issue] of [
    [{subtotalConfidence:.4}, 'UNCERTAIN_SUBTOTAL'],
    [{taxConfidence:.4}, 'UNCERTAIN_TAX'],
    [{currency:null,currencyConfidence:0,taxConfidence:.4}, 'UNCERTAIN_TAX'],
    [{totalConfidence:.4}, 'UNCERTAIN_TOTAL'],
    [{outstandingAmountConfidence:.4}, 'UNCERTAIN_OUTSTANDING_AMOUNT'],
    [{lineItemsConfidence:.4}, 'UNCERTAIN_LINE_ITEMS'],
    [{lineItems:[{description:'Service',quantity:1,unitPrice:100,amount:100,confidence:.4}]}, 'UNCERTAIN_LINE_ITEMS'],
    [{outstandingAmount:200}, 'INVALID_OUTSTANDING_AMOUNT'],
    [{outstandingAmount:100}, 'PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD'],
  ]) await t.test(issue + JSON.stringify(patch), async () => {
    const f = await fixture(invoiceWire(patch));
    try {
      assert.match(await f.turn(), /partial review.*clearer photo.*Nothing was saved/);
      const review = await f.pending.loadInvoiceReview(f.scope);
      assert.equal(review.action.stage, 'incomplete');
      assert.equal(review.action.sourceMessageId, 'wire-photo');
      assert.ok(review.action.validationIssues.includes(issue));
      await f.assertNoInvoiceWrites();
    } finally { await f.close(); }
  });
});

test('printed shipping and inconsistent sample0852 items cannot bypass strict invoice math', async () => {
  const wire = invoiceWire({invoiceNumber:'SAMPLE-0852', customerName:'Jane Doe', subtotal:100,tax:10,total:115,
    outstandingAmount:115,currency:null,currencyConfidence:0,addressHint:'United Kingdom',addressHintConfidence:.99,
    notes:'Printed shipping: 5',notesConfidence:.99,
    lineItems:[0,7,14,21].map((unitPrice,index) => ({description:`Printed item ${index+1}`,quantity:1,
      unitPrice,amount:[15,18,21,24][index],confidence:.99}))});
  const f = await fixture(wire);
  try {
    assert.match(await f.turn('sample0852-source'), /subtotal plus tax does not match the total.*corrected invoice.*Nothing was saved/);
    const review = (await f.pending.loadInvoiceReview(f.scope)).action;
    assert.equal(review.stage, 'incomplete');
    assert.equal(review.sourceMessageId, 'sample0852-source');
    assert.equal(review.invoice.clientName, 'Jane Doe');
    assert.equal(review.invoice.total, 115);
    assert.equal(review.invoice.subtotal, 100);
    assert.equal(review.invoice.tax, 10);
    assert.equal(review.invoice.notes, 'Printed shipping: 5');
    assert.deepEqual(review.invoice.lineItems, wire.lineItems);
    assert.ok(review.validationIssues.includes('INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX'));
    assert.ok(review.validationIssues.includes('UNCERTAIN_LINE_ITEMS'));
    await f.assertNoInvoiceWrites();
  } finally { await f.close(); }
});

test('missing optional extraction facts and currency alone preserve inferred currency auto-save', async () => {
  const wire = invoiceWire({currency:null,currencyConfidence:0,lineItems:[],lineItemsConfidence:0,
    outstandingAmount:null,outstandingAmountConfidence:0});
  const extracted = validateInvoiceExtractionWireResponse(wire);
  assert.ok(extracted.uncertainFields.includes('total'));
  assert.ok(extracted.uncertainFields.includes('subtotal'));
  const f = await fixture(wire);
  try {
    const answer = await f.turn('inferred-currency-source');
    assert.match(answer, /^Logged invoice/);
    assert.match(answer, /assumed workspace default INR/);
    const rows = (await f.db.query('select * from invoices')).rows;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].total_amount), 118);
    assert.equal(rows[0].currency, 'INR');
    assert.equal(rows[0].metadata.subtotal, 100);
    assert.equal(rows[0].metadata.tax, 18);
    assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('missing customer from actual wire retains known total and requests the correct fact', async () => {
  const f = await fixture(invoiceWire({customerName:null,customerNameConfidence:0}));
  try {
    assert.match(await f.turn('missing-customer-source'), /confirm the customer name.*Nothing was saved/);
    const review = await f.pending.loadInvoiceReview(f.scope);
    assert.equal(review.action.stage, 'incomplete');
    assert.equal(review.action.sourceMessageId, 'missing-customer-source');
    assert.deepEqual(review.action.missingFields, ['customerName']);
    assert.equal(review.action.invoice.total, 118);
    await f.assertNoInvoiceWrites();
  } finally { await f.close(); }
});

test('real extraction provider outage is distinguishable and retains the attachment source', async () => {
  const f = await fixture(invoiceWire(), {providerError:Object.assign(Error('isolated unavailable provider'),{code:'PROVIDER_UNAVAILABLE'})});
  try {
    assert.match(await f.turn('provider-failed-source'), /extraction service is unavailable.*Nothing was saved/);
    const review = await f.pending.loadInvoiceReview(f.scope);
    assert.equal(review.action.stage, 'canceled');
    assert.equal(review.action.failureCode, 'EXTRACTION_UNAVAILABLE');
    assert.equal(review.action.sourceMessageId, 'provider-failed-source');
    await f.assertNoInvoiceWrites();
  } finally { await f.close(); }
});
