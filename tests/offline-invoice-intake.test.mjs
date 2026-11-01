import {fixture,imageExtractor} from './fixtures/private-invoice.mjs';
import test from 'node:test';
import {createAIHandler} from '../ai/routes.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createOwnerSafetyTools} from '../automation/whatsapp/owner-agent.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {extractInvoiceOffline} from '../ai/extraction.mjs';
import {extractInvoiceFromImage} from '../ai/image-text.mjs';
import {correctOfflineReview} from '../ai/offline-invoice-review.mjs';
import {parseInvoiceCorrection} from '../automation/whatsapp/assistant-handler.mjs';

const phone='+919871367051';
const text=`Invoice No: INV-2026-0142
Bill to: Kabir Textiles
Invoice Date: 2026-10-20
Due Date: 2026-11-04
Subtotal: INR 17000
Tax: INR 3060
Total: INR 20060
Balance Due: INR 20060
Description Qty Rate Amount
Cotton 2 5000 10000
Silk 1 5000 5000
Dyes 2 1000 2000`;
const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
const pdf=Buffer.from('%PDF-1.7\nfixture');
const env={EXTRACTION_ROUTE:'offline',WHATSAPP_APP_SECRET:'offline-test-buttons-secret'};
const logger={info(){},warn(){},error(){}};
const deny=()=>{assert.fail('No provider factory, model classifier, or external fetch may run');};

test('round7 owner handler retains rejected competing totals and blocks confirmation in either order', async () => {
  for (const continuation of ['₹7.25', 'Rs.7.25', 'EUR7.25', '7.250', '?? 7']) {
    for (const [left, right] of [[' | ', ' / '], [' ; ', ' | '], [' / ', ' ; ']]) {
      for (const position of ['before', 'after', 'same line']) {
        const f=await fixture();
        try {
          const rejected=`Grand Total 21370${right}${continuation}${left}Packing 8`;
          let document=text.replace('Bill to: Kabir Textiles', `Bill to: Kabir Textiles${left}${rejected}`);
          if (position !== 'before') document=text.replace('Total: INR 20060\n','').replace('Bill to: Kabir Textiles',
            position === 'after' ? 'Total: INR 20060\nBill to: Kabir Textiles' : `Bill to: Kabir Textiles${left}Total: INR 20060`)
            .replace('Bill to: Kabir Textiles', `Bill to: Kabir Textiles${left}${rejected}`);
          f.setPrinted(document);
          const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
          const {action}=await f.pending.loadInvoiceReview(f.scope);
          assert.equal(action.stage,'incomplete',document);
          assert.ok(action.unresolvedFields.includes('total'),document);
          assert.ok(action.missingFields.includes('total'));
          assert.equal(reply.buttons,undefined);
          for (const evidence of ['21370',continuation,'20060']) assert.ok(reply.answer.includes(evidence),reply.answer);
          assert.match((await f.turn('yes')).answer,/Confirmation is unavailable/);
          assert.equal(await f.count(),0);
        } finally {await f.close();}
      }
    }
  }
});

test('round7 owner handler retains rejected optional monetary occurrences alongside valid values', async () => {
  for (const label of ['Subtotal','Tax','Balance Due']) {
    const f=await fixture();
    try {
      f.setPrinted(text.replace('Bill to: Kabir Textiles',`Bill to: Kabir Textiles | ${label} 21370 / ₹7.25 ; Packing 8`));
      const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      const {action}=await f.pending.loadInvoiceReview(f.scope);
      const field={Subtotal:'subtotal',Tax:'tax','Balance Due':'outstandingAmount'}[label];
      assert.ok(action.unresolvedFields.includes(field),label);
      assert.equal(action.stage,'incomplete');
      assert.equal(reply.buttons,undefined);
      assert.match(reply.answer,/21370/);
      assert.match(reply.answer,/₹7.25/);
      assert.equal(await f.count(),0);
    } finally {await f.close();}
  }
});

test('round7 owner handler retains all candidates in three-plus mixed-separator chains', async () => {
  for (const [left, middle, right] of [[' | ', ' / ', ' ; '], [' ; ', ' | ', ' / '], [' / ', ' ; ', ' | ']]) {
    for (const amounts of [[21370,22490], [22490,21370], [21370,22490,23630]]) {
      for (const separateFirst of [true,false]) {
        const f=await fixture();
        try {
          const chain=amounts.map((amount,i)=>`${i % 2 ? 'Total' : 'Grand Total'} ${amount}${middle}Packing${i % 2 ? ':' : ''} 8`).join(right);
          let document=text.replace('Bill to: Kabir Textiles',`Bill to: Kabir Textiles${left}${chain}`);
          if (separateFirst) document=document.replace('Total: INR 20060\n','').replace('Bill to:', 'Total: INR 20060\nBill to:');
          f.setPrinted(document);
          const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
          const {action}=await f.pending.loadInvoiceReview(f.scope);
          assert.equal(action.invoice.total,null);
          assert.ok(action.conflictingFields.includes('total'),document);
          assert.deepEqual([...action.printedEvidence.total.candidates].sort((a,b)=>a-b),[20060,...amounts].sort((a,b)=>a-b));
          assert.equal(action.stage,'incomplete');
          assert.equal(reply.buttons,undefined);
          for (const amount of [20060,...amounts]) assert.ok(reply.answer.includes(String(amount)),reply.answer);
          assert.equal(await f.count(),0);
        } finally {await f.close();}
      }
    }
  }
});

for (const colon of [true, false]) {
  test(`round5 owner handler retains conflicts across unknown ${colon ? 'colon' : 'colonless'} segments`, async () => {
    const cases = [];
    for (const unknown of ['Demurrage Reserve', 'Packing Allowance', 'Security Retention']) {
      for (const [left, right] of [[' / ', ' / '], [' | ', ' ; '], [' ; ', ' / '], [' / ', ' | ']]) {
        const field = `${unknown}${colon ? ':' : ''} 20060`;
        cases.push(`Bill to: Kabir Textiles${left}Grand Total 21000${right}${field}`);
        cases.push(`Bill to: Kabir Textiles${left}${field}${right}Grand Total 21000`);
      }
    }
    for (const unknown of ['Discount', 'Shipping', 'Amount Paid']) {
      for (const separator of [' / ', ' | ', ' ; ']) {
        cases.push(`Bill to: Kabir Textiles${separator}Grand Total 21000${separator}${unknown}${colon ? ':' : ''} ${colon ? 20060 : 5}`);
      }
    }
    for (const buyerLine of cases) {
      const f=await fixture();
      try {
        f.setPrinted(text.replace('Bill to: Kabir Textiles', buyerLine));
        const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
        const {action}=await f.pending.loadInvoiceReview(f.scope);
        assert.equal(action.invoice.total,null,buyerLine);
        assert.equal(action.stage,'incomplete',buyerLine);
        assert.ok(action.conflictingFields.includes('total'),buyerLine);
        assert.deepEqual([...action.printedEvidence.total.candidates].sort((a,b)=>a-b),[20060,21000],buyerLine);
        assert.equal(reply.buttons,undefined,buyerLine);
        assert.match(reply.answer,/21000/);
        assert.match(reply.answer,/20060/);
        assert.equal(await f.count(),0);
      } finally {await f.close();}
    }
  });
}

test('round4 owner handler exposes separated total conflicts and blocks signed confirmation', async () => {
  for (const separator of [' | ', ' ; ', ' / ']) {
    const f=await fixture();
    try {
      f.setPrinted(text.replace('Bill to: Kabir Textiles', `Bill to: Kabir Textiles${separator}Grand Total 21000`));
      const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      const {action}=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(action.invoice.total,null);
      assert.equal(action.stage,'incomplete');
      assert.ok(action.conflictingFields.includes('total'));
      assert.deepEqual([...action.printedEvidence.total.candidates].sort((a,b)=>a-b),[20060,21000]);
      assert.equal(reply.buttons,undefined);
      assert.match(reply.answer,/21000/);
      assert.match(reply.answer,/20060/);
      assert.equal(await f.count(),0);
    } finally {await f.close();}
  }
});

test('round4 owner handler blocks unknown shared-line qualified invoice dates', async () => {
  for (const qualifier of ['CLEARANCE','Reassessment','warehouse release']) {
    const f=await fixture();
    try {
      f.setPrinted(text.replace('Bill to: Kabir Textiles\nInvoice Date:',`Bill to: Kabir Textiles ${qualifier} INVOICE DATE:`));
      const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      const {action}=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(action.invoice.invoiceDate,null);
      assert.equal(action.stage,'incomplete');
      assert.ok(action.missingFields.includes('invoiceDate'));
      assert.equal(reply.buttons,undefined);
      assert.equal(await f.count(),0);
    } finally {await f.close();}
  }
});

test('round4 owner handler preserves OCR-spaced names before payment date fields', async () => {
  for (const name of ['Acme  Trading Co','Birch Hollow\tSupply Co','Maple   Ridge Works']) {
    const f=await fixture();
    try {
      f.setPrinted(text.replace('Bill to: Kabir Textiles',`Bill to: ${name} PAYMENT DATE: 2026-10-15`));
      const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      const {action}=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(action.invoice.clientName,name.replace(/\s+/g,' '));
      assert.equal(action.invoice.invoiceDate,'2026-10-20');
      assert.equal(action.stage,'proposal');
      assert.equal(reply.buttons.length,2);
      assert.equal(await f.count(),0);
    } finally {await f.close();}
  }
});

test('F1 real owner handler cannot confirm a PAYMENT DATE as invoice issuance', async () => {
  const f=await fixture();
  try {
    f.setPrinted(text.replace('Invoice Date: 2026-10-20','PAYMENT DATE: 2026-10-20'));
    const reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    const review=await f.pending.loadInvoiceReview(f.scope);
    assert.equal(review.action.invoice.invoiceDate,null);
    assert.equal(review.action.stage,'incomplete');
    assert.ok(review.action.missingFields.includes('invoiceDate'));
    assert.equal(reply.buttons,undefined);
    assert.equal(await f.count(),0);
  } finally { await f.close(); }
});

test('local owner review uses signed single-confirm buttons, preserves all printed values and keeps DB gates',async t=>{
  const f=await fixture();try{
    await t.test('photo preserves printed candidates and direction gates buttons and bare yes',async()=>{
      const reply=await f.turn('log this invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(reply.buttons,undefined);
      for(const value of ['INV-2026-0142','Kabir Textiles','2026-10-20','2026-11-04','20060','INR','Cotton','Silk','Dyes']) assert.ok(reply.answer.includes(value),value);
      assert.match(reply.answer,/direction: uncertain/);
      assert.match(reply.answer,/issued this invoice/);
      const review=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(review.action.extractionRoute,'offline');
      assert.equal(review.action.invoice.invoiceDate,'2026-10-20');
      assert.equal(review.action.invoice.dueDate,'2026-11-04');
      assert.deepEqual(review.action.missingFields,['direction']);
      for(const key of ['invoiceDate','dueDate','direction','currency','lineItems']) assert.ok(review.action.confirmationFields.includes(key),key);
      assert.equal(review.action.printedEvidence.total.value,20060);
      assert.match(review.action.printedEvidence.total.text,/Total: INR 20060/);
      assert.deepEqual(review.action.assumptions,[]);
      assert.equal(await f.count(),0);
      assert.match((await f.turn('yes')).answer,/Confirmation is unavailable/);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.stage,'incomplete');
      for(const wording of ['Did we issue this invoice?','We did not issue this invoice','Maybe we issued this invoice','Someone said we issued this invoice','We sent payment for this invoice']){
        assert.equal((await f.turn(wording)).buttons,undefined);
        assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.invoice.direction,'uncertain');
      }
    });
    let proposal,staleButtons;
    await t.test('one issuance reply resolves direction and exposes Confirm/Cancel with every value',async()=>{
      proposal=await f.turn('We issued this invoice');
      
      assert.deepEqual(proposal.buttons.map(button=>button.title),['Confirm','Cancel']);
      assert.match(proposal.answer,/invoice date: 2026-10-20 \(printed\)/);
      assert.match(proposal.answer,/due date: 2026-11-04 \(printed\)/);
      assert.match(proposal.answer,/Tap Confirm or Cancel/);
      assert.ok(proposal.answer.length<=1024);
      const row=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(row.action.stage,'proposal');
      assert.equal(await f.count(),0);
      staleButtons=proposal.buttons;
    });
    await t.test('printed-value correction re-presents values, preserves evidence and invalidates old buttons',async()=>{
      proposal=await f.turn('set due date to 2026-11-10');
      assert.equal(proposal.buttons.length,2);
      assert.match(proposal.answer,/due date: 2026-11-10 \(printed: 2026-11-04\) \(owner supplied\)/);
      const stale=await f.turn('Confirm',{interactionId:staleButtons[0].id});
      assert.match(stale.answer,/expired or changed/);
      assert.equal(await f.count(),0);
    });
    await t.test('one explicit Confirm tap saves exactly the presented candidates through proposal -> saving -> saved',async()=>{
      const reply=await f.turn('Confirm',{interactionId:proposal.buttons[0].id});
      assert.match(reply.answer,/Saved invoice/);
      assert.equal(await f.count(),1);
      const saved=(await f.db.query('select *, issue_date::text as issue_date, due_date::text as due_date from invoices')).rows[0];
      assert.equal(saved.issue_date,'2026-10-20');assert.equal(saved.due_date,'2026-11-10');
      assert.equal(Number(saved.total_amount),20060);assert.equal(saved.currency,'INR');
      assert.equal(saved.metadata.printed_invoice_number,'INV-2026-0142');
      assert.equal(saved.metadata.line_items.length,3);
      const row=(await f.db.query("select action from whatsapp_pending_actions where action->>'stage'='saved'")).rows[0];
      assert.equal(row.action.extractionRoute,'offline');
      assert.equal(row.action.printedEvidence.dueDate.value,'2026-11-04');
      assert.equal(row.action.ownerProvidedFacts.dueDate.value,'2026-11-10');
      assert.equal(row.action.ownerReviewConfirmation.kind,'button');
      assert.equal(row.action.ownerReviewConfirmation.confirmedInvoice.dueDate,'2026-11-10');
      const contact=await f.pending.loadPendingAction(f.scope);
      if (contact?.action?.type==='invoice_debtor_phone') await f.pending.consumePendingAction({...contact,...f.scope});
    });
    await t.test('missing printed date asks explicitly and equivalent text confirm saves only after correction',async()=>{
      f.setPrinted(text.replace('Invoice Date: 2026-10-20\n','').replaceAll('INV-2026-0142','INV-MISSING-DATE'));
      let reply=await f.turn('log invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.match(reply.answer,/invoice date: not shown/);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.invoice.invoiceDate,null);
      await f.turn('We issued this invoice');
      assert.match((await f.turn('yes')).answer,/missing or ambiguous invoice date/);
      reply=await f.turn('set invoice date to 2026-10-20');
      assert.equal(reply.buttons.length,2);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.invoice.invoiceDate,'2026-10-20');
      assert.match((await f.turn('yes')).answer,/Saved invoice/);
      assert.equal(await f.count(),2);
      const contact=await f.pending.loadPendingAction(f.scope);
      if (contact?.action?.type==='invoice_debtor_phone') await f.pending.consumePendingAction({...contact,...f.scope});
    });
    await t.test('conflicting printed totals and unresolved currency block confirm until deterministic correction',async()=>{
      f.setPrinted(text.replaceAll('INV-2026-0142','INV-CONFLICT').replace('INR 20060','USD 20060')+'\nTotal: INR 21000');
      await f.turn('log invoice',{media:{bytes:png,mimeType:'image/png'}});
      await f.turn('We issued this invoice');
      let review=await f.pending.loadInvoiceReview(f.scope);
      assert.ok(review.action.missingFields.includes('total'));assert.ok(review.action.missingFields.includes('currency'));
      assert.equal((await f.turn('yes')).buttons,undefined);assert.equal(await f.count(),2);
      await f.turn('set total to 20060 INR');
      review=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(review.action.stage,'proposal');
      const reply=await f.turn('cancel');
      assert.match(reply.answer,/canceled/i);assert.equal(await f.count(),2);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.stage,'canceled');
    });
    await t.test('scanned PDF has exact photo-instead reply, no provider and nothing saved',async()=>{
      f.setPdfText(null);
      const reply=await f.turn('log invoice',{media:{bytes:pdf,mimeType:'application/pdf'}});
      assert.equal(reply.answer,'This PDF has no readable text. Send a photo of the invoice instead.');
      assert.equal(await f.count(),2);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.stage,'canceled');
    });
    await t.test('text-layer PDF parses locally and cancellation tap discards its proposal',async()=>{
      f.setPdfText(text.replaceAll('INV-2026-0142','INV-PDF-TEXT'));
      let reply=await f.turn('log invoice',{media:{bytes:pdf,mimeType:'application/pdf'}});
      assert.match(reply.answer,/INV-PDF-TEXT/);assert.match(reply.answer,/2026-11-04/);
      reply=await f.turn('We issued this invoice');
      assert.equal(reply.buttons.length,2);
      assert.match((await f.turn('Cancel',{interactionId:reply.buttons[1].id})).answer,/canceled/i);
      assert.equal(await f.count(),2);
    });
    await t.test('long reviews preserve all values and use text confirmation within WhatsApp limits',async()=>{
      f.setPrinted('Invoice No: INV-LONG\nBill To: Northwind\nInvoice Date: 2026-10-20\nTotal: INR 1500\nDescription Qty Rate Amount\n'+
        Array.from({length:15},(_,i)=>`Detailed service description number ${i} 1 100 100`).join('\n'));
      await f.turn('log invoice',{media:{bytes:png,mimeType:'image/png'}});
      const reply=await f.turn('We issued this invoice');
      assert.equal(reply.buttons,undefined);assert.match(reply.answer,/Reply yes to confirm/);
      for(let i=0;i<15;i++)assert.ok(reply.answer.includes(`Detailed service description number ${i}`));
      assert.ok(reply.answer.length>1024&&reply.answer.length<=3790);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.stage,'proposal');
      assert.equal(await f.count(),2);await f.turn('cancel');
    });
    await t.test('oversized reviews retain evidence but block confirmation instead of accepting unseen values',async()=>{
      f.setPrinted('Invoice No: INV-TOO-LONG\nBill To: Northwind\nInvoice Date: 2026-10-20\nTotal: INR 6000\nDescription Qty Rate Amount\n'+
        Array.from({length:60},(_,i)=>`Detailed service description number ${i} 1 100 100`).join('\n'));
      const reply=await f.turn('log invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.match(reply.answer,/too much printed detail/);assert.equal(reply.buttons,undefined);
      await f.turn('We issued this invoice');await f.turn('yes');
      const review=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(review.action.stage,'incomplete');assert.equal(review.action.invoice.lineItems.length,60);
      assert.equal(await f.count(),2);
    });
    await t.test('unreadable printed table rows cannot silently become an empty approved list',async()=>{
      f.setPrinted('Invoice No: INV-UNREADABLE-ITEM\nBill To: Northwind\nInvoice Date: 2026-10-20\nTotal: INR 100\nDescription Qty Rate Amount\nSmudged service ??? 1 ?? 100');
      let reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(reply.buttons,undefined);assert.match(reply.answer,/printed line items could not be read/);
      reply=await f.turn('yes');assert.equal(reply.buttons,undefined);
      const review=await f.pending.loadInvoiceReview(f.scope);
      assert.ok(review.action.missingFields.includes('lineItems'));
      assert.match(review.action.printedEvidence.lineItems.text,/Smudged service/);
      assert.equal(review.action.assumptions.some(value=>value.includes('line item list is empty')),false);
      assert.equal(await f.count(),2);
    });
    await t.test('printed payment markings remain visible and cannot be erased by a candidate correction',async()=>{
      f.setPrinted(text.replaceAll('INV-2026-0142','INV-PAID-REVIEW')+'\nPAID IN FULL');
      let reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(reply.buttons,undefined);assert.match(reply.answer,/Printed payment evidence:.*PAID/);
      reply=await f.turn('set due date to 2026-11-10');assert.equal(reply.buttons,undefined);
      const review=await f.pending.loadInvoiceReview(f.scope);
      assert.ok(review.action.validationIssues.includes('PAYMENT_RECORD_REQUIRES_REVIEW'));
      assert.equal((await f.turn('yes')).buttons,undefined);assert.equal(await f.count(),2);
    });
    await t.test('invalid printed due date blocks confirmation and is preserved as evidence until corrected',async()=>{
      f.setPrinted(text.replaceAll('INV-2026-0142','INV-INVALID-DUE').replace('Due Date: 2026-11-04','Due Date: 2026-02-30'));
      let reply=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(reply.buttons,undefined);assert.match(reply.answer,/2026-02-30/);
      const review=await f.pending.loadInvoiceReview(f.scope);
      assert.ok(review.action.missingFields.includes('dueDate'));assert.equal(review.action.invoice.dueDate,null);
      assert.equal(review.action.assumptions.some(value=>value.includes('due date was not shown')),false);
      reply=await f.turn('set due date to 2026-11-04');assert.equal(reply.buttons.length,2);
      await f.turn('cancel');assert.equal(await f.count(),2);
    });
    await t.test('explicit issuance in the owner caption enables one Confirm tap with no separate field turns',async()=>{
      f.setPrinted(text.replaceAll('INV-2026-0142','INV-ISSUED-CAPTION'));
      const reply=await f.turn('We issued this invoice. Please log it.',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(reply.buttons.length,2);assert.match(reply.answer,/direction: receivable/);
      assert.equal(await f.count(),2);
      assert.match((await f.turn('Confirm',{interactionId:reply.buttons[0].id})).answer,/Saved invoice/);
      assert.equal(await f.count(),3);
    });
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('offline intent edits never construct a provider or attempt a model classifier',async()=>{
  const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:null})};
  const handler=createWhatsAppBoundMessageHandler({audience:'owner',supabase:{from:()=>q,rpc:async()=>({data:false})},env:{EXTRACTION_ROUTE:'offline'},providerFactory:deny,
    authorizeScope:async()=>true,pendingActionStoreFactory:()=>({loadInvoiceReview:async()=>null,loadPendingAction:async()=>null}),
    invoiceStoreFactory:()=>({findInvoices:async()=>[]}),logger});
  assert.equal(await handler({workspaceId:'w',customerId:'c',phone,message:'chnge the bil details',messageId:'intent'}),
    'What would you like to change, and what should the new value be?');
  assert.match(await handler({workspaceId:'w',customerId:'c',phone,message:'set total to 100 INR',messageId:'edit'}),/find a recent invoice/);
});

for(const route of [undefined,'OFFLINE','offline ','local',''])test(`local extraction is mandatory for ${JSON.stringify(route)}`,async()=>{
  const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:null})};
  let providerCalls=0,extractions=0;
  const handler=createWhatsAppBoundMessageHandler({audience:'owner',supabase:{from:()=>q,rpc:async()=>({data:false})},env:route===undefined?{}:{EXTRACTION_ROUTE:route},
    authorizeScope:async()=>true,providerFactory:()=>{providerCalls++;return {};},
    pendingActionStoreFactory:()=>({beginInvoiceReview:async()=>({id:1,action:{stage:'extracting'}}),transitionInvoiceReview:async()=>({})}),
    extract:deny,extractOffline:async()=>{extractions++;throw Error('local extraction boundary');},logger});
  await handler({workspaceId:'w',customerId:'c',phone,message:'log invoice',messageId:'default',media:{bytes:png,mimeType:'image/png'}});
  assert.equal(providerCalls,0);assert.equal(extractions,1);
});


test('offline correction RPC preserves evidence, binding, version and the existing save-stage rules',async()=>{
  const f=await fixture();try{
    await f.turn('log invoice',{media:{bytes:png,mimeType:'image/png'}});
    const row=await f.pending.loadInvoiceReview(f.scope),sourceMessageId='guard-owner-issuance';
    await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner','We issued this invoice','normal','received',$4,$4)",[f.scope.workspaceId,f.scope.customerId,phone,sourceMessageId]);
    const next=correctOfflineReview(row.action,'We issued this invoice',{parseCorrection:parseInvoiceCorrection,messageId:sourceMessageId});
    const correct=action=>f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId});
    const bad=structuredClone(next);bad.printedEvidence.total.value=1;
    await assert.rejects(correct(bad),/pending action/);
    assert.equal((await f.pending.loadInvoiceReview(f.scope)).version,row.version);
    assert.equal(await f.pending.correctOfflineInvoiceReview({...row,...f.scope,workspaceId:randomUUID(),action:next,sourceMessageId}),null);
    await assert.rejects(f.pending.correctOfflineInvoiceReview({...row,...f.scope,action:next,sourceMessageId:'not-a-persisted-owner-turn'}),/pending action/);
    const stageSkip={...next,stage:'saved'};await assert.rejects(correct(stageSkip),/pending action/);
    const accepted=await correct(next);assert.equal(accepted.action.stage,'proposal');
    assert.equal(await correct(next),null,'old review version cannot be corrected again');
    await assert.rejects(f.pending.transitionInvoiceReview({...accepted,...f.scope,fromStage:'proposal',action:{...accepted.action,stage:'saved'}}),/pending action/);
    const signature='public.whatsapp_correct_offline_invoice_review(bigint,bigint,uuid,uuid,text,jsonb,text)';
    for(const role of ['anon','authenticated'])assert.equal((await f.db.query('select has_function_privilege($1,$2,$3) allowed',[role,signature,'execute'])).rows[0].allowed,false);
    assert.equal(await f.count(),0);
  }finally{await f.close();}
});


test('shared photo intake selects only the local extractor, preserving low-confidence printed dates and direction',async()=>{
  const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:{business_name:'Owner',default_currency:'USD'}})};
  let action;
  const handler=createWhatsAppBoundMessageHandler({audience:'owner',supabase:{from:()=>q,rpc:async()=>({data:false})},env,providerFactory:deny,extract:deny,
    extractOffline:request=>extractInvoiceOffline({...request,imageExtractor:imageExtractor(text)}),
    authorizeScope:async()=>true,logger,
    pendingActionStoreFactory:()=>({beginInvoiceReview:async()=>({id:1,action:{stage:'extracting'}}),
      transitionInvoiceReview:async input=>{assert.equal(input.fromStage,'extracting');action=input.action;return {action};}})});
  const answer=await handler({workspaceId:'w',customerId:'c',phone,message:'log invoice',messageId:'shared-photo',media:{bytes:png,mimeType:'image/png'}});
  assert.match(answer,/2026-10-20/);assert.match(answer,/2026-11-04/);assert.match(answer,/direction: uncertain/);
  assert.equal(action.extractionRoute,'offline');assert.equal(action.invoice.currency,'INR');assert.equal(action.stage,'incomplete');
});


test('cached local review preserves printed words even when they look like internal terminology',async()=>{
  const answer='Local invoice review. Check every value against the original:\ncustomer: Workspace Error Services (printed).\ninvoice number: INV_FAILED (printed).\nConfirm accepts exactly all the values shown above. Tap Confirm or Cancel.';
  const handler=createOwnerMessageHandler({supabase:{from:()=>{throw Error('cached review needs no query');}},env,logger,
    authorize:async()=>true,providerFactory:deny,agentFactory:deny,replyStore:{find:async()=>({answer,buttons:[{id:'cached-signed-choice',title:'Confirm'}]})}});
  const result=await handler({workspaceId:randomUUID(),ownerId:randomUUID(),phone,messageId:'replay-review',message:'log invoice'});
  assert.equal(result.answer,answer);assert.equal(result.buttons.length,1);
});


test('every established CONFIRMATION_REPLY form accepts a complete visible local review without a model',async()=>{
  const f=await fixture();try{
    const replies=['yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve','send it','create it'];
    for(const [i,message] of replies.entries()){
      f.setPrinted(text.replaceAll('INV-2026-0142',`INV-CONFIRM-${i}`));
      const proposal=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(proposal.buttons.length,2,message);
      const reply=await f.turn(message);
      assert.match(reply.answer,/Saved invoice/,message);
      assert.equal(await f.count(),i+1,message);
      const contact=await f.pending.loadPendingAction(f.scope);
      if(contact?.action?.type==='invoice_debtor_phone')await f.pending.consumePendingAction({...contact,...f.scope});
    }
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});


test('expired local review history is excluded while ordinary summaries continue',async()=>{
  const f=await fixture({recording:true});try{
    await f.turn('log invoice',{media:{bytes:png,mimeType:'image/png'}});
    await f.db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 hour' where workspace_id=$1",[f.scope.workspaceId]);
    assert.equal((await f.turn('Please summarize our conversation')).answer,'Summary');
    assert.equal(f.providerRecord.calls,1);
    assert.doesNotMatch(JSON.stringify(f.providerRecord.requests),/Kabir|20060|INV-2026|Cotton|cetld:offline-intake/);
    const history=await f.supabase.rpc('owner_assistant_history',{p_workspace_id:f.scope.workspaceId,p_owner_id:f.scope.ownerId});
    assert.match(JSON.stringify(history.data),/cetld:offline-intake/);
  }finally{await f.close();}
});

test('every printed due-date occurrence requires resolution and monetary due labels are excluded',async()=>{
  const f=await fixture();try{
    for(const pdfCase of [false,true])for(const due of ['Due Date 2026-11-04','Due Date: 2026-02-30\nDue Date: 2026-11-04']){
      const printed=text.replace('Due Date: 2026-11-04',due);
      f.setPrinted(printed);f.setPdfText(printed);
      const reply=await f.turn('We issued this invoice',{media:{bytes:pdfCase?pdf:png,mimeType:pdfCase?'application/pdf':'image/png'}});
      assert.equal(reply.buttons,undefined);assert.match(reply.answer,/2026-/);
      const row=await f.pending.loadInvoiceReview(f.scope);
      assert.ok(row.action.unresolvedFields.includes('dueDate'));
      assert.equal(row.action.assumptions.some(a=>a.includes('due date was not shown')),false);
    }
    f.setPrinted(text.replace('Due Date: 2026-11-04\n','').replace('Balance Due: INR 20060','Balance Due: ???\nAmount Due: INR 20060'));
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    const row=await f.pending.loadInvoiceReview(f.scope);
    assert.equal(row.action.printedEvidence.dueDate,undefined);
    assert.equal(row.action.unresolvedFields.includes('dueDate'),false);
  }finally{await f.close();}
});

test('denial is not affirmative issuance in captions or SQL corrections',async()=>{
  const f=await fixture();try{
    for(const message of ['It is false that we issued this invoice','I deny that we issued this invoice','I refute the claim that we issued this invoice']){
      const reply=await f.turn(message,{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(reply.buttons,undefined);
      const row=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(row.action.invoice.direction,'uncertain');
      const id='denial-'+Math.random();
      await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'normal','received',$5,$5)",[f.scope.workspaceId,f.scope.customerId,phone,message,id]);
      const action=structuredClone(row.action);action.invoice.direction='receivable';action.ownerProvidedFacts.direction={value:'receivable',sourceMessageId:id};
      await assert.rejects(f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId:id}));
    }
  }finally{await f.close();}
});

test('correction SQL rejects bare-yes forged values and reuse at the current version',async()=>{
  const f=await fixture();try{
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    const source=async(id,message)=>f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'normal','received',$5,$5)",[f.scope.workspaceId,f.scope.customerId,phone,message,id]);
    let row=await f.pending.loadInvoiceReview(f.scope);
    await source('forged-yes','yes');
    let action=structuredClone(row.action);action.invoice.total=1;action.ownerProvidedFacts.total={value:1,sourceMessageId:'forged-yes'};
    await assert.rejects(f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId:'forged-yes'}));
    await source('valid-date','set due date to 2026-11-10');
    action=correctOfflineReview(row.action,'set due date to 2026-11-10',{parseCorrection:parseInvoiceCorrection,messageId:'valid-date'});
    row=await f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId:'valid-date'});
    assert.ok(row);
    action=structuredClone(row.action);action.invoice.dueDate='2026-11-11';action.ownerProvidedFacts.dueDate={value:'2026-11-11',sourceMessageId:'valid-date'};
    await assert.rejects(f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId:'valid-date'}));
    // Reuse is rejected even when the second value IS supported by the same
    // text: total + currency can be supplied together, never in two replays.
    await source('two-facts','set total to 20060 INR');
    action=structuredClone(row.action);action.ownerProvidedFacts.total={value:20060,sourceMessageId:'two-facts'};
    row=await f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId:'two-facts'});
    assert.ok(row);
    action=structuredClone(row.action);action.ownerProvidedFacts.currency={value:'INR',sourceMessageId:'two-facts'};action.currencySource='user';
    await assert.rejects(f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId:'two-facts'}));
    assert.equal(await f.count(),0);
  }finally{await f.close();}
});


test('durable offline provenance also blocks web assistant provider construction',async()=>{
  for(const content of ['[cetld:offline-intake]\nKabir Textiles','Local invoice review. Kabir Textiles']){
    for(const serverHistory of [true,false]){
      let constructions=0,calls=0,response;
      const history=[{role:'assistant',content}];
      const handler=createAIHandler({env:{},authorize:async()=>({role:serverHistory?'owner':'admin',
        offlineProvenance:async()=>true,ownerConversation:{read:async()=>serverHistory?history:[],offlineProvenance:async()=>true},getSettings:deny}),
        providerFactory:()=>{constructions++;return {generate:async()=>{calls++;}};}});
      const res={setHeader(){},status(code){assert.equal(code,200);return this;},json(value){response=value;}};
      await handler({method:'POST',query:{action:'assistant'},body:{workspaceId:randomUUID(),message:'Please summarize our conversation',...(serverHistory?{}:{history})}},res);
      assert.match(response.answer,/local invoice information/);
      assert.equal(constructions,0);assert.equal(calls,0);
    }
  }
});


test('durable offline provenance survives contact replies, pruning, restart and route changes',async()=>{
  const f=await fixture({recording:true});try{
    const proposal=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    // The database also records provenance atomically for direct/recovery writes.
    await f.db.query('delete from app.offline_invoice_businesses where workspace_id=$1',[f.scope.workspaceId]);
    await f.db.query('update whatsapp_pending_actions set action=action where workspace_id=$1',[f.scope.workspaceId]);
    assert.equal((await f.db.query('select count(*)::integer n from app.offline_invoice_businesses where workspace_id=$1',[f.scope.workspaceId])).rows[0].n,1);
    await f.turn('Confirm',{interactionId:proposal.buttons[0].id});
    assert.match((await f.turn('+919876543210')).answer,/Kabir Textiles/);
    for(let n=0;n<9;n++)await f.turn('hi');
    let history=(await f.db.query('select content from owner_assistant_turns where workspace_id=$1',[f.scope.workspaceId])).rows;
    assert.ok(history.some(t=>t.content.includes('Saved +919876543210 for Kabir Textiles')));
    assert.equal(history.some(t=>t.content.includes('cetld:offline-intake')),false);
    for(const clearHistory of [false,true]){
      if(clearHistory)await f.db.query('delete from owner_assistant_turns where workspace_id=$1',[f.scope.workspaceId]);
      await f.db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 hour' where workspace_id=$1",[f.scope.workspaceId]);
      delete f.routeEnv.EXTRACTION_ROUTE;f.restart();
      const summary=await f.turn('Please summarize our conversation',{checkpoint:{phase:'planning',reply:'Kabir Textiles'}});
      assert.equal(summary.answer,'Summary');
      assert.doesNotMatch(JSON.stringify(f.providerRecord.requests.at(-1)),/Kabir|20060|INV-2026/);
      const handler=createAIHandler({env:{},authorize:async()=>({role:'owner',ownerConversation:{read:async()=>[],offlineProvenance:async()=>(await f.supabase.rpc('owner_assistant_offline_provenance',{p_workspace_id:f.scope.workspaceId,p_owner_id:f.scope.ownerId})).data},getSettings:deny}),providerFactory:deny});
      let response;
      await handler({method:'POST',query:{action:'assistant'},body:{workspaceId:f.scope.workspaceId,message:'Summarize'}},{setHeader(){},status(code){assert.equal(code,200);return this;},json(v){response=v;}});
      assert.match(response.answer,/local invoice information/);
    }
    assert.equal(f.providerRecord.calls,2);
    assert.doesNotMatch(JSON.stringify(f.providerRecord.requests),/Kabir|20060|INV-2026/);
  }finally{await f.close();}
});

test('whole issuance assertions reject prefix, interposed and suffix repudiation, including later retraction',async()=>{
  const f=await fixture();try{
    for(const message of ['We issued this invoice - that is untrue.','We issued this invoice; no, that statement is incorrect.',
      'We issued this invoice — I retract that claim.','We, contrary to the claim, did not issue this invoice.',
      'It is incorrect to say: we issued this invoice','We issued, no we did not, this invoice']){
      const reply=await f.turn(message,{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(reply.buttons,undefined,message);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.invoice.direction,'uncertain');
      assert.equal((await f.turn(message)).buttons,undefined);
      const row=await f.pending.loadInvoiceReview(f.scope),id='suffix-'+Math.random();
      await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'normal','received',$5,$5)",[f.scope.workspaceId,f.scope.customerId,phone,message,id]);
      const forged=structuredClone(row.action);forged.invoice.direction='receivable';forged.ownerProvidedFacts.direction={value:'receivable',sourceMessageId:id};
      await assert.rejects(f.pending.correctOfflineInvoiceReview({...row,...f.scope,action:forged,sourceMessageId:id}));
      await f.turn('yes');assert.equal(await f.count(),0);
    }
    for(const correction of ['We issued this invoice; no, that statement is incorrect.','That statement is untrue.','I retract that.','set notes to We issued this invoice; no, that is incorrect.','set due date to November 10; we did not issue this invoice.','set notes to We did not create this invoice.']){
      const affirmative=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal(affirmative.buttons.length,2);
      const withdrawn=await f.turn(correction);assert.equal(withdrawn.buttons,undefined);
      const row=await f.pending.loadInvoiceReview(f.scope);
      assert.equal(row.action.invoice.direction,'uncertain');assert.ok(row.action.missingFields.includes('direction'));
      await f.turn('Confirm',{interactionId:affirmative.buttons[0].id});await f.turn('yes');assert.equal(await f.count(),0);
    }
  }finally{await f.close();}
});

test('SQL recomputes unresolved and conflicting correction gates independently of supplied arrays',async()=>{
  const f=await fixture();try{
    for(const printed of [text.replace('2026-11-04','2026-02-30'),text+'\nGrand Total: INR 21000',text.replaceAll('INR','???'),text.replace('Subtotal: INR 17000','Subtotal: INR 16000'),text+'\n'+Array.from({length:60},(_,n)=>`Fabric${n} 1 10 10`).join('\n')]){
      f.setPrinted(printed);await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      const row=await f.pending.loadInvoiceReview(f.scope),id='gate-'+Math.random();
      await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner','set notes to reviewed','normal','received',$4,$4)",[f.scope.workspaceId,f.scope.customerId,phone,id]);
      const action=correctOfflineReview(row.action,'set notes to reviewed',{parseCorrection:parseInvoiceCorrection,messageId:id});
      assert.equal(action.stage,'incomplete');
      for(const gates of [{stage:'proposal',missingFields:[],validationIssues:[]},{stage:'incomplete',missingFields:[],validationIssues:[]}]){
        await assert.rejects(f.pending.correctOfflineInvoiceReview({...row,...f.scope,action:{...action,...gates},sourceMessageId:id}));
        assert.equal((await f.pending.loadInvoiceReview(f.scope)).version,row.version);
      }
      const legitimate=await f.pending.correctOfflineInvoiceReview({...row,...f.scope,action,sourceMessageId:id});
      assert.equal(legitimate.action.stage,'incomplete');assert.equal(await f.count(),0);
    }
  }finally{await f.close();}
});

test('unsupported deterministic corrections clarify before SQL and keep candidates unchanged',async()=>{
  const f=await fixture();try{
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    for(const message of ['set due date to November 10','set invoice date to October 21','change due date to 11/10']){
      const before=f.requests.filter(r=>r.url.includes('/rpc/whatsapp_correct_offline_invoice_review')).length;
      const reply=await f.turn(message);
      assert.match(reply.answer,/YYYY-MM-DD/);assert.doesNotMatch(reply.answer,/couldn.t verify/);
      assert.equal(f.requests.filter(r=>r.url.includes('/rpc/whatsapp_correct_offline_invoice_review')).length,before);
      assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.invoice.dueDate,'2026-11-04');
    }
    const valid=await f.turn('set due date to 2026-11-10');
    assert.match(valid.answer,/2026-11-10/);assert.equal(valid.buttons.length,2);
  }finally{await f.close();}
});

test('default web route treats history phrases as ordinary text with byte-identical replies',async()=>{
  const responses=[];
  for(const phrase of ['Ordinary business discussion.','I saw the words Local invoice review. in the manual.','[cetld:offline-intake] is a token in our docs.']){
    let constructions=0,calls=0;
    const handler=createAIHandler({env:{},clock:()=>new Date('2026-10-30T00:00:00Z'),authorize:async()=>({role:'admin',offlineProvenance:async()=>false,getSettings:async()=>({}),query:async()=>[]}),
      providerFactory:()=>{constructions++;return {generate:async()=>{calls++;return {content:'The same answer.'};}};},logger});
    let response;
    await handler({method:'POST',query:{action:'assistant'},body:{workspaceId:randomUUID(),message:'Please summarize our conversation',history:[{role:'user',content:phrase}]}},
      {setHeader(){},status(code){assert.equal(code,200);return this;},json(v){response=JSON.stringify(v);}});
    assert.equal(constructions,1);assert.equal(calls,1);responses.push(response);
  }
  assert.equal(responses[0],responses[1]);assert.equal(responses[0],responses[2]);
});

test('default owner route ignores local-review phrases in ordinary server history',async()=>{
  const f=await fixture({recording:true});try{
    delete f.routeEnv.EXTRACTION_ROUTE;
    const rpc=f.supabase.rpc.bind(f.supabase);
    f.supabase.rpc=(name,args)=>{
      assert.notEqual(name,'owner_assistant_offline_provenance','Default owner turns must not call the offline RPC');
      return rpc(name,args);
    };
    const answers=[];
    for(const content of ['Ordinary conversation','I saw the words Local invoice review. in the manual.','[cetld:offline-intake] is documentation']){
      await f.db.query('delete from owner_assistant_turns where workspace_id=$1',[f.scope.workspaceId]);
      await f.supabase.rpc('owner_assistant_append',{p_workspace_id:f.scope.workspaceId,p_owner_id:f.scope.ownerId,p_event_key:'normal-'+Math.random(),p_channel:'web',p_role:'user',p_content:content});
      const before={...f.providerRecord};
      const reply=await f.turn('Please summarize our conversation');answers.push(reply.answer);
      assert.equal(f.providerRecord.constructions,before.constructions+1);
      assert.ok(f.providerRecord.calls>before.calls);
      assert.equal(JSON.stringify(f.providerRecord.requests.at(-1)).includes(content),false);
    }
    assert.equal(answers[0],answers[1]);assert.equal(answers[0],answers[2]);
  }finally{await f.close();}
});

test('durable provenance scopes shared history without blocking unrelated chat or depending on the old lookup',async()=>{
  const f=await fixture({recording:true});try{
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    const requests=[];
    const handler=createWhatsAppBoundMessageHandler({supabase:f.supabase,env:{},authorizeScope:async()=>true,logger,
      providerFactory:()=>({async generate(request){requests.push(request);return {content:'Ordinary answer',model:'cf'};}})});
    assert.equal(await handler({...f.scope,message:'Summarize our conversation',messageId:'changed-route'}),'Ordinary answer');
    assert.doesNotMatch(JSON.stringify(requests),/Kabir|20060|INV-2026/);
    const broken=createWhatsAppBoundMessageHandler({supabase:{from:f.supabase.from.bind(f.supabase),rpc:(name,args)=>name==='owner_assistant_offline_provenance'?Promise.resolve({error:{code:'UNAVAILABLE'}}):f.supabase.rpc(name,args)},env:{EXTRACTION_ROUTE:'offline'},authorizeScope:async()=>true,logger,
      providerFactory:()=>({async generate(){return {content:'Still available',model:'cf'};}})});
    assert.equal(await broken({...f.scope,message:'Tell me a joke',messageId:'no-old-rpc'}),'Still available');
  }finally{await f.close();}
});

test('offline route without a provenance record permits ordinary owner chat independently of the obsolete workspace lookup',async()=>{
  const f=await fixture({recording:true});try{
    assert.equal((await f.supabase.rpc('owner_assistant_offline_provenance',{p_workspace_id:f.scope.workspaceId})).data,false);
    assert.equal((await f.turn('Please summarize our conversation')).answer,'Summary');
    assert.equal(f.providerRecord.constructions,1);assert.ok(f.providerRecord.calls>0);
    const before={...f.providerRecord};
    const rpc=f.supabase.rpc.bind(f.supabase);
    f.supabase.rpc=(name,args)=>name==='owner_assistant_offline_provenance'?Promise.resolve({error:{code:'DATABASE_UNAVAILABLE'}}):rpc(name,args);
    const continued=await f.turn('Please summarize our conversation');
    assert.equal(continued.answer,'Summary');
    assert.equal(f.providerRecord.constructions,before.constructions+1);assert.equal(f.providerRecord.calls,before.calls+1);
  }finally{await f.close();}
});

test('offline provenance survives corrected and derived replies across all pruning and recovery variants',async()=>{
  for(const greetings of [0,3,25,48]){
    const f=await fixture({recording:true});try{
      await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      await f.turn('set customer to Fresh Caption Customer');
      const corrected=await f.turn('set notes to Private caption detail');
      assert.equal(corrected.buttons.length,2);
      await f.turn('Confirm',{interactionId:corrected.buttons[0].id});
      await f.turn('+919876543210');
      for(let n=0;n<greetings;n++)await f.turn('hi');
      await f.db.query('delete from owner_assistant_turns where workspace_id=$1',[f.scope.workspaceId]);
      await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);
      // The mirrored metadata cannot be cleared by settings changes.
      await f.db.query('update workspace_settings set offline_invoice_provenance=false where workspace_id=$1',[f.scope.workspaceId]);
      assert.equal((await f.db.query('select offline_invoice_provenance from workspace_settings where workspace_id=$1',[f.scope.workspaceId])).rows[0].offline_invoice_provenance,true);
      delete f.routeEnv.EXTRACTION_ROUTE;f.restart();
      const rpc=f.supabase.rpc.bind(f.supabase);
      f.supabase.rpc=(name,args)=>{
        assert.notEqual(name,'owner_assistant_offline_provenance','Default turns use their existing history read');
        return rpc(name,args);
      };
      const reply=await f.turn('Please summarize our conversation',{checkpoint:{phase:'planning',reply:'Fresh Caption Customer Private caption detail 20060'}});
      assert.equal(reply.answer,'Summary');
      assert.doesNotMatch(JSON.stringify(f.providerRecord.requests),/Fresh Caption Customer|Private caption detail|20060/);
      const tools=createOwnerSafetyTools({supabase:f.supabase,scope:f.scope,env:{},authorize:async()=>true,ownerStore:{query:deny},
        media:{bytes:png,mimeType:'image/png'},providerFactory:deny,logger});
      for(const name of ['readInvoiceAttachment','checkInvoiceAttachmentDuplicate']){
        const result=await tools.execute(name,{});
        assert.equal(result.ok,false);assert.doesNotMatch(result.message||'',/local invoice information/);
      }
      assert.equal(f.providerRecord.calls,1);
    }finally{await f.close();}
  }
});
test('real web owner and admin stores reuse settings/history metadata without the offline RPC',async()=>{
  const f=await fixture({recording:true});try{
    let userId=f.scope.ownerId,constructions=0,calls=0;
    const handler=createAIHandler({env:{NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'fixture-key'},logger,
      fetchImpl:async(url,options)=>{
        const path=new URL(url).pathname;
        assert.notEqual(path,'/rest/v1/rpc/owner_assistant_offline_provenance');
        return path==='/auth/v1/user'?Response.json({id:userId}):f.fetchImpl(url,options);
      },providerFactory:()=>{constructions++;return {generate:async()=>{calls++;return {content:'Summary'};}};}});
    const ask=async(action='assistant')=>{
      let response;
      await handler({method:action==='assistant'?'POST':'GET',headers:{authorization:'Bearer fixture-owner-token'},query:{action,workspaceId:f.scope.workspaceId},
        body:{workspaceId:f.scope.workspaceId,message:'Please summarize our conversation'}},
        {setHeader(){},status(code){assert.equal(code,200);return this;},json(value){response=value;}});
      return response;
    };
    const settingsReads=()=>f.requests.filter(r=>new URL(r.url).pathname==='/rest/v1/workspace_ai_settings').length;
    const before=settingsReads();
    assert.doesNotMatch((await ask()).answer,/local invoice information/);
    assert.equal(constructions,1);assert.ok(calls>0);assert.equal(settingsReads(),before+1);
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    const recorded={constructions,calls};
    assert.match((await ask()).answer,/local invoice information/);
    const persisted=(await ask('assistant-history')).turns;
    assert.ok(persisted.every(turn=>['user','assistant'].includes(turn.role)&&typeof turn.content==='string'));
    assert.equal(JSON.stringify(persisted).includes('offline_provenance'),false);
    userId=randomUUID();await f.db.query('insert into auth.users(id) values($1)',[userId]);
    await f.db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[f.scope.workspaceId,userId]);
    assert.match((await ask()).answer,/local invoice information/);
    assert.deepEqual({constructions,calls},recorded);
  }finally{await f.close();}
});
test('shared local invoice route preserves ordinary chat before and after upload with scoped exclusion',async()=>{
  const f=await fixture();try{
    const requests=[];
    const handler=createWhatsAppBoundMessageHandler({supabase:f.supabase,env:{EXTRACTION_ROUTE:'offline'},logger,authorizeScope:async()=>true,
      providerFactory:()=>({async generate(request){requests.push(request);return {content:'Ordinary answer',model:'cf'};}})});
    let sequence=0;const ask=(message='Tell me about music')=>handler({...f.scope,message,messageId:'shared-'+(++sequence)});
    assert.equal(await ask(),'Ordinary answer');
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);
    assert.equal(await ask(),'Ordinary answer');
    assert.equal(await ask('Please summarize our conversation'),'Ordinary answer');
    assert.equal(requests.length,3);assert.doesNotMatch(JSON.stringify(requests),/Kabir|20060|INV-2026/);
    assert.ok(requests.at(-1).messages.some(turn=>turn.content==='Tell me about music'));
  }finally{await f.close();}
});
