import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createOwnerWorkspaceTools as createTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {extractInvoice, INVOICE_IMAGE_REPLIES} from '../ai/extraction.mjs';
import {extractInvoiceFromImage} from '../ai/image-text.mjs';

const phone='+919871367051';
const sample=await readFile(new URL('./fixtures/qa-invoice.jpg',import.meta.url));
const quiet={info(){},warn(){},error(){},log(){}};

function invoiceWire(imageContent='single_invoice') {
  const values={invoiceNumber:'QA-PHOTO-001',customerName:'QA Sample Buyer',invoiceDate:'2026-10-18',dueDate:'2026-11-17',
    subtotal:100,tax:18,total:118,outstandingAmount:118,currency:'INR',clientPhone:null,clientPhoneRaw:null,
    clientEmail:null,notes:null,direction:'receivable',currencySource:'Currency: INR',addressHint:null,
    paymentTerms:null,paymentStatus:null,paymentStatusEvidence:null};
  return {...Object.fromEntries(Object.entries(values).flatMap(([name,value])=>[[name,value],[`${name}Confidence`,value===null?0:.99]])),
    lineItems:[{description:'Consulting',quantity:1,unitPrice:100,amount:100,confidence:.99}],lineItemsConfidence:.99,
    ...(imageContent===undefined?{}:{imageContent})};
}

// This fixture exercises the signed webhook, Graph download, Supabase SDK,
// real SQL inbox/claims, owner handler/tools, local OCR, AIProvider wire
// validation, review transitions, invoice/file stores and outbound reply.
// The planner and vision response are scripted; no external request is made.
async function fixture({bytes=sample,classification='single_invoice',caption='log this invoice',type='image',downloadFails=false,staleHistory=false,stalePending=false}={}) {
  const f=await createOfflineSqlNetwork(),ownerId=randomUUID();
  await f.db.query('insert into auth.users(id) values($1)',[ownerId]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await f.db.query('select (public.create_workspace($1,$2)).id',['QA Sample Studio',randomUUID()])).rows[0].id;
  const verification=(await f.db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await f.db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
  assert.equal((await f.db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  if(staleHistory)await f.db.query(`insert into whatsapp_messages(workspace_id,phone,direction,audience,body,kind,status,idempotency_key,provider_message_id,created_at)
    values($1,$2,'inbound','owner','Create an invoice for QA Emoji Customer','text','received','qa-old-text','wamid.qa-old-text',now()-interval '5 minutes'),
      ($1,$2,'outbound','owner','The invoice for QA Emoji Customer could not be found.','normal','accepted','qa-old-reply',null,now()-interval '4 minutes')`,[workspaceId,phone]);
  if(stalePending){
    const binding=(await f.db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
    const pending=createWhatsAppPendingActionStore({supabase:f.supabase});
    const scope={workspaceId,customerId:binding.customer_id,phone};
    const expectedState=await pending.loadPendingActionState(scope);
    await pending.storePendingAction({...scope,source:'whatsapp',expectedState,
      action:{type:'owner_invoice_request',clientName:'QA Emoji Customer',total:999,currency:'USD'}});
  }
  // A rejected attachment must not alter any existing business record.
  const before=await snapshot(f.db);
  const sent=[],graph=[],vision=[],toolResults=[];
  let ocrCalls=0,chatCalls=0;
  const env={WHATSAPP_PHONE_NUMBER_ID:'qa-number',WHATSAPP_WABA_ID:'qa-waba',WHATSAPP_GRAPH_API_VERSION:'v24.0',
    WHATSAPP_ACCESS_TOKEN:'offline-fixture-only',WHATSAPP_APP_SECRET:'offline-fixture-only',GEMINI_API_KEY:'offline-fixture-only'};
  const fetchImpl=async(input,options={})=>{
    const url=new URL(String(input));
    if(url.hostname==='graph.facebook.com'){
      graph.push(url.pathname);assert.notEqual(options.method,'POST');
      if(downloadFails)return new Response('',{status:503});
      return Response.json({url:'https://qa-media.test/invoice.jpg',mime_type:'image/jpeg'});
    }
    if(url.hostname==='qa-media.test')return new Response(bytes,{headers:{'content-type':'image/jpeg'}});
    if(url.hostname==='generativelanguage.googleapis.com'){
      const request=JSON.parse(options.body);
      const inline=request.contents[0].parts.find(part=>part.inlineData)?.inlineData;
      assert.equal(inline.mimeType,'image/jpeg');assert.deepEqual(Buffer.from(inline.data,'base64'),bytes);
      const schema=request.generationConfig.responseJsonSchema;
      assert.ok(schema.required.includes('imageContent'));
      vision.push(request);
      const wire=invoiceWire(classification);
      if(classification==='missing')delete wire.imageContent;
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(wire)}]},finishReason:'STOP'}]});
    }
    throw Error(`Unexpected external request: ${url.hostname}`);
  };
  const owner=createOwnerMessageHandler({supabase:f.supabase,env,logger:quiet,
    providerFactory:options=>options.requestPurpose==='extraction'
      ?new AIProvider({...options,geminiApiKey:env.GEMINI_API_KEY,fetchImpl})
      :{async generate(){
        chatCalls++;
        // A stale-context planner tries to look up the earlier text customer.
        // A captionless image must be handled before this can be consulted.
        return {model:'offline-planner',toolCalls:[{id:'stale-customer',type:'function',function:{name:'workspaceData',
          arguments:JSON.stringify({operation:'read',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'QA Emoji Customer'}]})}}]};
      }},
    toolsFactory:asyncOptions=>{
      // Inject only the OCR observer into the real workspace tool adapter.
      const tools=createTools({...asyncOptions,extractAttachment:options=>extractInvoice({...options,
        imageExtractor:async input=>{ocrCalls++;return extractInvoiceFromImage(input);}})});
      const execute=tools.execute;
      return {...tools,async execute(...args){const result=await execute(...args);toolResults.push(result);return result;}};
    },
    agentFactory:async options=>{
      const {tools,message}=options;
      if(!message)return runOwnerAgent(options);
      const result=await tools.execute('workspaceData',{operation:message?'saveAttachment':'analyzeAttachment'});
      return {answer:result.message||(result.analysisOnly?'I read the attached invoice. Nothing was saved.':'Invoice processing finished.')};
    }});
  const runtime=createInboundRuntime({supabase:f.supabase,env,fetchImpl,logger:quiet,onOwnerMessage:owner,
    outbound:{async sendTypingIndicator(){},async sendServiceReply(input){assert.equal(input.to,phone);sent.push(input);return {status:'accepted'};}}});
  const webhook=createWhatsAppWebhookHandler({runtime,env,logger:quiet});
  const payload={object:'whatsapp_business_account',entry:[{id:env.WHATSAPP_WABA_ID,changes:[{field:'messages',value:{
    metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},messages:[{id:'wamid.qa-photo',from:phone.slice(1),
      timestamp:String(Math.floor(Date.now()/1000)),type,[type]:{id:'qa-media',mime_type:type==='sticker'?'image/webp':'image/jpeg',caption}}]}}]}]};
  const rawBody=Buffer.from(JSON.stringify(payload));
  const signature='sha256='+createHmac('sha256',env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const response={setHeader(){},status(status){this.statusCode=status;return this;},json(body){this.body=body;return this;}};
  try{
  await webhook({method:'POST',headers:{'x-hub-signature-256':signature},rawBody},response);
  assert.equal(response.statusCode,200);assert.deepEqual(response.body,{received:true});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.equal(sent.length,1);
  const answer=sent[0].body;
  assert.doesNotMatch(answer,/I couldn't read that message/);
  assert.deepEqual(f.errors,[]);
  return {...f,workspaceId,before,answer,graph,vision,toolResults,get ocrCalls(){return ocrCalls;},get chatCalls(){return chatCalls;}};
  }catch(error){await f.close();throw error;}
}

async function snapshot(db) {
  const result={};
  for(const table of ['customers','invoices','payments','invoice_files'])result[table]=(await db.query(`select * from ${table} order by id`)).rows;
  return result;
}

test('bundled sample JPEG is actually legible to the offline OCR engine',async()=>{
  const result=await extractInvoiceFromImage({bytes:sample,mimeType:'image/jpeg'});
  assert.equal(result.total.value,118);assert.equal(result.subtotal.value,100);assert.equal(result.tax.value,18);
  assert.match(result.ocr.text,/QA Sample Buyer/);
  assert.ok(result.total.confidence<0.75,'offline OCR alone never authorizes a save');
});

test('sample JPEG traverses signed webhook, media storage, real OCR and owner invoice save',async()=>{
  const f=await fixture();
  try{
    assert.equal(f.ocrCalls,1);assert.equal(f.vision.length,1);assert.equal(f.graph.length,1);
    assert.equal(f.toolResults[0].ok,true);
    const invoices=(await f.db.query('select total_amount,currency,metadata from invoices')).rows;
    assert.equal(invoices.length,1);assert.equal(Number(invoices[0].total_amount),118);assert.equal(invoices[0].currency,'INR');
    assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);
    assert.equal((await f.db.query('select count(*)::int n from payments')).rows[0].n,0);
    const stored=(await f.db.query('select bytes from whatsapp_inbound_media')).rows[0].bytes;
    assert.deepEqual(Buffer.from(stored),sample);
  }finally{await f.close();}
});

test('captionless JPEG reaches owner analysis without authorizing invoice creation',async()=>{
  const f=await fixture({caption:''});
  try{assert.equal(f.vision.length,1);assert.equal(f.chatCalls,0);assert.match(f.answer,/Customer: QA Sample Buyer.*Total: INR 118.00.*Nothing was saved/);assert.deepEqual(await snapshot(f.db),f.before);}
  finally{await f.close();}
});

test('captionless JPEG after unrelated text and pending customer reads only the new image',async()=>{
  const f=await fixture({caption:'',staleHistory:true,stalePending:true});
  try{
    assert.equal(f.chatCalls,0);assert.equal(f.vision.length,1);assert.equal(f.ocrCalls,1);
    assert.equal(f.toolResults.length,1);assert.equal(f.toolResults[0].analysisOnly,true);
    assert.equal(f.toolResults[0].fields.customerName,'QA Sample Buyer');
    assert.match(f.answer,/QA Sample Buyer/);assert.doesNotMatch(f.answer,/QA Emoji|999|could not be found/);
    assert.deepEqual(await snapshot(f.db),f.before);
    const review=(await f.db.query('select action from whatsapp_pending_actions where consumed_at is null')).rows[0].action;
    assert.equal(review.sourceMessageId,'wamid.qa-photo');assert.equal(review.invoice.clientName,'QA Sample Buyer');
  }finally{await f.close();}
});

test('sticker reproducer gives attachment instructions without download, OCR, planner or business writes',async()=>{
  const f=await fixture({type:'sticker',caption:''});
  try{
    assert.match(f.answer,/as a sticker.*attachment button.*Photos\/Gallery or Document/);
    assert.equal(f.graph.length,0);assert.equal(f.ocrCalls,0);assert.equal(f.vision.length,0);assert.equal(f.toolResults.length,0);
    assert.deepEqual(await snapshot(f.db),f.before);
  }finally{await f.close();}
});

test('download failure asks for a resend and makes no business changes',async()=>{
  const f=await fixture({downloadFails:true,caption:''});
  try{assert.match(f.answer,/couldn't fetch|could not be loaded/i);assert.equal(f.vision.length,0);assert.deepEqual(await snapshot(f.db),f.before);}
  finally{await f.close();}
});

test('image rejection replies survive real AIProvider validation and cannot save even high-confidence invoice fields',async t=>{
  const half=await sharp(sample).resize(450,550).toBuffer();
  const variants=[
    ['blurry',await sharp(sample).resize(12,15).resize(900,1100).blur(15).jpeg().toBuffer(),'unreadable','IMAGE_UNREADABLE'],
    ['rotated',await sharp(sample).rotate(90).jpeg().toBuffer(),'single_invoice',null],
    ['non-invoice',await sharp({create:{width:900,height:1100,channels:3,background:'#4488cc'}}).jpeg().toBuffer(),'not_invoice','IMAGE_NOT_INVOICE'],
    ['multi-invoice',await sharp({create:{width:900,height:550,channels:3,background:'white'}})
      .composite([{input:half,left:0,top:0},{input:half,left:450,top:0}]).jpeg().toBuffer(),'multiple_invoices','IMAGE_MULTIPLE_INVOICES'],
    ['missing classification',sample,'missing','IMAGE_UNREADABLE'],
  ];
  for(const [name,bytes,classification,code] of variants)await t.test(name,async()=>{
    const f=await fixture({bytes,classification});
    try{
      assert.equal(f.vision.length,1,'valid rejection must not trigger model failover');
      assert.equal(f.ocrCalls,1);
      if(code){
        assert.equal(f.answer,INVOICE_IMAGE_REPLIES[code]);
        assert.deepEqual(await snapshot(f.db),f.before);
        const pending=(await f.db.query('select action from whatsapp_pending_actions order by id desc limit 1')).rows[0].action;
        assert.equal(pending.stage,'canceled');assert.equal(pending.failureCode,code);
      }else{
        assert.equal(f.toolResults[0].ok,true);
        assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
        assert.equal(Number((await f.db.query('select total_amount from invoices')).rows[0].total_amount),118);
      }
    }finally{await f.close();}
  });
});
