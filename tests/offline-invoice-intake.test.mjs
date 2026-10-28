import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
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

// Exercise the real image extractor with a local OCR worker fixture. The
// preprocessing/recognition boundaries are local; all downstream parsing is real.
const imageExtractor=printed=>request=>extractInvoiceFromImage({...request,preprocessor:async bytes=>bytes,
  workerFactory:async()=>({recognize:async()=>({data:{text:printed,confidence:99}}),terminate:async()=>{}})});

async function fixture(){
  const f=await createOfflineSqlNetwork(),ownerId=randomUUID();
  await f.db.query('insert into auth.users(id) values($1)',[ownerId]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await f.db.query('select (public.create_workspace($1,$2)).id',['Offline Studio',randomUUID()])).rows[0].id;
  const verification=(await f.db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await f.db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
  assert.equal((await f.db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const binding=(await f.db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  const scope={workspaceId,ownerId,customerId:binding.customer_id,phone};
  const pending=createWhatsAppPendingActionStore({supabase:f.supabase});
  let printed=text, pdfText=null;
  const handler=createOwnerMessageHandler({supabase:f.supabase,env,logger,providerFactory:deny,fetchImpl:deny,
    agentFactory:deny,replyStore:null,
    toolsFactory:options=>createOwnerWorkspaceTools({...options,extractOfflineAttachment:request=>extractInvoiceOffline({...request,
      imageExtractor:imageExtractor(printed),pdfTextExtractor:async()=>pdfText})})});
  let sequence=0;
  const turn=async(message,{media,interactionId}={})=>{
    const messageId='offline-'+(++sequence);
    await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,$3,$4,'processing')",[messageId,phone,media?'image':'text',message]);
    await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'normal','received',$5,$5)",[workspaceId,scope.customerId,phone,message,messageId]);
    return handler({...scope,message,messageId,media,interactionId});
  };
  const count=async()=>Number((await f.db.query('select count(*) n from invoices')).rows[0].n);
  return {...f,scope,pending,turn,count,setPrinted:value=>{printed=value;},setPdfText:value=>{pdfText=value;}};
}

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
  const handler=createWhatsAppBoundMessageHandler({supabase:{from:()=>q},env:{EXTRACTION_ROUTE:'offline'},providerFactory:deny,
    authorizeScope:async()=>true,pendingActionStoreFactory:()=>({loadInvoiceReview:async()=>null,loadPendingAction:async()=>null}),
    invoiceStoreFactory:()=>({findInvoices:async()=>[]}),logger});
  assert.equal(await handler({workspaceId:'w',customerId:'c',phone,message:'chnge the bil details',messageId:'intent'}),
    'What would you like to change, and what should the new value be?');
  assert.match(await handler({workspaceId:'w',customerId:'c',phone,message:'set total to 100 INR',messageId:'edit'}),/find a recent invoice/);
});

for(const route of [undefined,'OFFLINE','offline ','local',''])test(`default provider route is preserved for ${JSON.stringify(route)}`,async()=>{
  const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:null})};
  let providerCalls=0,extractions=0;
  const handler=createWhatsAppBoundMessageHandler({supabase:{from:()=>q},env:route===undefined?{}:{EXTRACTION_ROUTE:route},
    authorizeScope:async()=>true,providerFactory:()=>{providerCalls++;return {};},
    pendingActionStoreFactory:()=>({beginInvoiceReview:async()=>({id:1,action:{stage:'extracting'}}),transitionInvoiceReview:async()=>({})}),
    extract:async()=>{extractions++;throw Error('default extraction boundary');},extractOffline:deny,logger});
  await handler({workspaceId:'w',customerId:'c',phone,message:'log invoice',messageId:'default',media:{bytes:png,mimeType:'image/png'}});
  assert.equal(providerCalls,2);assert.equal(extractions,1);
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
  const handler=createWhatsAppBoundMessageHandler({supabase:{from:()=>q},env,providerFactory:deny,extract:deny,
    extractOffline:request=>extractInvoiceOffline({...request,imageExtractor:imageExtractor(text)}),
    authorizeScope:async()=>true,audience:'owner',logger,
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
