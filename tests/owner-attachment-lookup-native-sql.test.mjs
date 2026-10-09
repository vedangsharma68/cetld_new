import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';

const duplicateQuestion='Have I already logged this invoice? My business issued it in USD, and the PAID stamp is incorrect. Keep customer messages and reminders off.';
const correction='My business issued this invoice. The currency is USD. The PAID stamp is incorrect: no payment has been received, and the full USD 93.50 is still due. Save it as an unpaid draft with no customer messages or reminders.';

async function renderPdf(bytes){
  const document=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true}).promise;
  try{
    const page=await document.getPage(1),viewport=page.getViewport({scale:1});
    const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    return canvas.toBuffer('image/png');
  }finally{await document.destroy();}
}

async function fixture(){
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550365';
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Attachment lookup regression',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  await db.query("select setval(pg_get_serial_sequence('public.whatsapp_pending_actions','id'),31,true)");
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const scope={workspaceId,ownerId,customerId,phone};
  const pdfBytes=await readFile(new URL('./fixtures/public-sliced-sample-invoice.pdf',import.meta.url));
  const imageBytes=await renderPdf(pdfBytes);
  const invoiceFacts={invoiceNumber:'INV-3337',customerName:'Test Business',invoiceDate:'2016-01-25',dueDate:'2016-01-31',
    subtotal:85,tax:8.5,total:93.5,outstandingAmount:93.5,currency:'AUD',direction:'uncertain',clientEmail:'test@test.com',
    clientPhone:null,clientPhoneRaw:null,notes:null,currencySource:'Melbourne, VIC 3000',paymentStatus:'paid',paymentStatusEvidence:'PAID'};
  const extractedWire=()=>({...Object.fromEntries(Object.entries(invoiceFacts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),
    lineItems:[{description:'Web Design',quantity:1,unitPrice:85,amount:85,confidence:.99}],lineItemsConfidence:.99});
  let extractionOverride=null,failExtraction=false,currentMessage='';
  const calls={executions:[],extractions:[],planner:[]};
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
    logger:{info(){},warn(){},error(){}},toolsFactory:options=>{
      const tools=createOwnerWorkspaceTools(options);
      return {...tools,async execute(name,args,context){calls.executions.push({name,args});return tools.execute(name,args,context);}};
    },fetchImpl:async(url,init)=>{
      const host=new URL(url).hostname,body=JSON.parse(init.body);
      if(body.generationConfig?.responseMimeType==='application/json'){
        calls.extractions.push({host,body,message:currentMessage});
        if(failExtraction)return Response.json({error:{message:'fixture extraction unavailable'}},{status:503});
        return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({...extractedWire(),...(extractionOverride||{})})}]},finishReason:'STOP'}]});
      }
      calls.planner.push({host,body,message:currentMessage});
      if(host==='api.cloudflare.com'){
        const tool=body.messages.findLast(item=>item.role==='tool');
        if(!tool)return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'must-not-plan-write',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,currency:'USD',status:'unpaid'}})}}]}}]});
        const result=JSON.parse(tool.content);
        return Response.json({choices:[{finish_reason:'stop',message:{content:result.message||'Nothing was changed.'}}]});
      }
      const parts=body.contents.flatMap(item=>item.parts||[]),tool=parts.findLast(part=>part.functionResponse)?.functionResponse;
      if(!tool)return Response.json({candidates:[{content:{role:'model',parts:[{functionCall:{name:'workspaceData',args:{operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,currency:'USD'}}},thoughtSignature:'fixture'}]},finishReason:'STOP'}]});
      return Response.json({candidates:[{content:{role:'model',parts:[{text:tool.response?.message||'Nothing was changed.'}]},finishReason:'STOP'}]});
    }});
  const persist=async(id,message,{kind='text',bytes=null,mimeType=null}={})=>{
    await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$5)",
      [id,phone,kind==='document'?'document':kind,message,bytes?id:null]);
    await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,null,$2,'inbound','owner',$3,$4,'received',$5,$5)",
      [workspaceId,phone,message,kind,id]);
    if(bytes)await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[id,mimeType,bytes,bytes.length]);
  };
  const turn=async(id,message,{mediaBytes=null,mimeType='image/png',kind='image',...extra}={})=>{
    currentMessage=message;await persist(id,message,{kind,bytes:mediaBytes,mimeType});
    return handler({...scope,messageId:id,message,...(mediaBytes?{media:{bytes:mediaBytes,mimeType,fileName:'rendered-public-sample.png'}}:{}),...extra});
  };
  const savedReview=async(sourceMessageId='pdf-source')=>(await db.query("select id,version,action,consumed_at from whatsapp_pending_actions where workspace_id=$1 and action->>'type'='invoice_review_draft' and action->>'sourceMessageId'=$2 order by created_at desc limit 1",[workspaceId,sourceMessageId])).rows[0];
  const snapshot=async()=>({
    invoices:(await db.query('select to_jsonb(i) value from invoices i where workspace_id=$1 order by id',[workspaceId])).rows.map(row=>row.value),
    files:(await db.query('select id,workspace_id,invoice_id,storage_path,mime_type,size_bytes,created_at from invoice_files where workspace_id=$1 order by id',[workspaceId])).rows,
    payments:(await db.query('select to_jsonb(p) value from payments p where workspace_id=$1 order by id',[workspaceId])).rows.map(row=>row.value),
    reviews:(await db.query("select id,version,action,consumed_at from whatsapp_pending_actions where workspace_id=$1 and action->>'type'='invoice_review_draft' order by id",[workspaceId])).rows,
    customerOutbound:(await db.query("select count(*)::int n from whatsapp_messages where workspace_id=$1 and audience='customer' and direction='outbound'",[workspaceId])).rows[0].n,
  });
  try{
    assert.equal(pdfBytes.length,43627);
    const first=await turn('pdf-source','Log this public sample invoice for testing. Keep customer messages and reminders off.',{mediaBytes:pdfBytes,mimeType:'application/pdf',kind:'document'});
    const draft=await savedReview();assert.equal(draft.action.stage,'incomplete',JSON.stringify({first,draft,errors:f.errors}));assert.equal(draft.id,32);
    const fixed=await turn('pdf-correction',correction);
    const proposal=await savedReview();assert.equal(proposal.action.stage,'proposal',JSON.stringify({fixed,proposal,errors:f.errors}));
    assert.equal(proposal.action.invoice.invoiceNumber,'INV-3337');assert.equal(proposal.action.invoice.direction,'receivable');
    assert.equal(proposal.action.invoice.currency,'USD');assert.equal(proposal.action.invoice.total,93.5);assert.equal(proposal.action.invoice.clientPhone,null);
    const saved=await turn('pdf-confirm','yes');assert.match(saved.answer,/Saved invoice INV-2026-0001/,JSON.stringify(saved));
    const review=await savedReview();assert.equal(review.action.stage,'saved');
    const state=await snapshot();assert.equal(state.invoices.length,1);assert.equal(state.files.length,1);assert.equal(state.payments.length,0);
    assert.equal(state.customerOutbound,0);
    const stored=await supabase.storage.from('invoice-files').download(state.files[0].storage_path);assert.equal(stored.error,null);
    assert.deepEqual(Buffer.from(await stored.data.arrayBuffer()),pdfBytes);
    return {...f,scope,pdfBytes,imageBytes,handler,turn,savedReview,snapshot,state,calls,get extractionOverride(){return extractionOverride;},set extractionOverride(value){extractionOverride=value;},get failExtraction(){return failExtraction;},set failExtraction(value){failExtraction=value;}};
  }catch(error){await f.close();throw error;}
}

function assertNoAbsenceClaim(reply){
  assert.match(reply,/could(?: not|n't)|unable|could not verify|not able/i);
  assert.doesNotMatch(reply,/not logged|no matching invoice|hasn.t been logged|not already logged/i);
}

test('attachment duplicate question uses exact read-only source match and preserves saved invoice review',async()=>{
  const f=await fixture();try{
    const before=await f.snapshot(),savedReview=await f.savedReview(),executionStart=f.calls.executions.length;
    const extractionStart=f.calls.extractions.length,plannerStart=f.calls.planner.length;
    const reply=await f.turn('event265-duplicate-question',duplicateQuestion,{mediaBytes:f.imageBytes});
    assert.match(reply.answer,/already logged/i,JSON.stringify(reply));
    assert.match(reply.answer,/INV-2026-0001/);assert.match(reply.answer,/INV-3337/);assert.match(reply.answer,/No changes were made/i);
    assert.equal(f.calls.executions.slice(executionStart).filter(item=>item.args.operation==='checkAttachment').length,1);
    assert.deepEqual(f.calls.executions.slice(executionStart).map(item=>item.args),[{operation:'checkAttachment'}]);
    assert.equal(f.calls.extractions.length-extractionStart,1,'analyze only this image to identify its source invoice');
    assert.equal(f.calls.planner.length,plannerStart,'the malformed generic-create planner is never asked for a decision');
    assert.deepEqual(await f.snapshot(),before);assert.deepEqual(await f.savedReview(),savedReview);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('missing or ambiguous attachment identity and extraction failure never assert a duplicate or absence',async()=>{
  const f=await fixture();try{
    const before=await f.snapshot();
    for(const [id,override] of [
      ['missing-number',{invoiceNumber:null,customerName:'Test Business',clientEmail:'test@test.com'}],
      ['missing-customer',{invoiceNumber:'INV-3337',customerName:null,clientEmail:null}],
      ['unknown-source',{invoiceNumber:'INV-NOT-LOGGED',customerName:'Test Business',clientEmail:'test@test.com'}],
      ['uncertain-number',{invoiceNumberConfidence:0.74}],
      ['uncertain-customer',{customerNameConfidence:0.74}],
      ['missing-confidence',{invoiceNumberConfidence:null}],
    ]){
      f.extractionOverride={invoiceNumber:'INV-3337',customerName:'Test Business',clientEmail:'test@test.com',invoiceNumberConfidence:0.95,customerNameConfidence:0.95,...override};
      const reply=await f.turn(`event265-${id}`,duplicateQuestion,{mediaBytes:f.imageBytes});
      assertNoAbsenceClaim(reply.answer);assert.doesNotMatch(reply.answer,/already logged|INV-2026-0001/i,JSON.stringify(reply));
      assert.deepEqual(await f.snapshot(),before);
    }
    f.extractionOverride=null;f.failExtraction=true;
    const failed=await f.turn('event265-extraction-failure',duplicateQuestion,{mediaBytes:f.imageBytes});
    assertNoAbsenceClaim(failed.answer);assert.doesNotMatch(failed.answer,/already logged|No invoice was found/i,JSON.stringify(failed));
    assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('ambiguous same-customer source matches stay unverified and no source is selected arbitrarily',async()=>{
  const f=await fixture();try{
    const invoice=f.state.invoices[0];
    const historical=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'OTHER-HISTORICAL','2016-01-25','2016-01-31','USD',93.5,'draft',$3) returning id",
      [f.scope.workspaceId,invoice.customer_id,{client_name:'Test Business'}])).rows[0].id;
    // Simulate a pre-guard historical collision. New inserts with this source
    // key are intentionally rejected by the real uniqueness guard.
    await f.db.query("update invoices set metadata=jsonb_set(metadata,'{printed_invoice_number}','\"INV-3337\"') where id=$1",[historical]);
    const before=await f.snapshot();
    const reply=await f.turn('event265-ambiguous',duplicateQuestion,{mediaBytes:f.imageBytes});
    assertNoAbsenceClaim(reply.answer);assert.doesNotMatch(reply.answer,/already logged|INV-2026-0001/i,JSON.stringify(reply));
    assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('a current payment proposal and saved review history survive the read-only attachment inquiry',async()=>{
  const f=await fixture();try{
    const pending=createWhatsAppPendingActionStore({supabase:f.supabase});
    const state=await pending.loadPendingActionState(f.scope);
    assert.ok(state);
    const action={type:'owner_invoice_payment',invoiceId:f.state.invoices[0].id,invoiceNumber:'INV-2026-0001',
      expectedUpdatedAt:f.state.invoices[0].updated_at,changes:{amount:10,currency:'USD'},sourceMessageId:'payment-proposal-source',
      requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600_000).toISOString()};
    const stored=await pending.storePendingAction({...f.scope,action,source:'whatsapp',expectedState:state});
    assert.ok(stored?.id);
    const before=await f.snapshot(),paymentAction=(await f.db.query("select id,version,action,consumed_at from whatsapp_pending_actions where workspace_id=$1 and action->>'type'='owner_invoice_payment'",[f.scope.workspaceId])).rows[0];
    const reply=await f.turn('event265-active-payment-query',duplicateQuestion,{mediaBytes:f.imageBytes});
    assert.match(reply.answer,/already logged/i,JSON.stringify(reply));
    assert.deepEqual(await f.snapshot(),before);
    assert.deepEqual((await f.db.query("select id,version,action,consumed_at from whatsapp_pending_actions where workspace_id=$1 and action->>'type'='owner_invoice_payment'",[f.scope.workspaceId])).rows[0],paymentAction);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('a foreign workspace cannot use the attachment inquiry to reveal owner invoice identity',async()=>{
  const f=await fixture();try{
    const before=await f.snapshot(),plannerStart=f.calls.planner.length,extractStart=f.calls.extractions.length;
    const reply=await f.handler({...f.scope,workspaceId:randomUUID(),messageId:'event265-foreign',message:duplicateQuestion,
      media:{bytes:f.imageBytes,mimeType:'image/png',fileName:'foreign.png'}});
    assert.equal(reply,'');assert.deepEqual(await f.snapshot(),before);
    assert.equal(f.calls.planner.length,plannerStart);assert.equal(f.calls.extractions.length,extractStart);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
