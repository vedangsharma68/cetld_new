import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,png,pdf} from './fixtures/private-invoice.mjs';
import {createPrivateChatProvider,PRIVATE_CHAT_REPLY,CHAT_UNAVAILABLE_REPLY} from '../ai/private-chat.mjs';
import {AIProvider,CF_PRIMARY_MODEL,CF_BACKUP_MODEL,GEMINI_FALLBACK_MODEL} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {invoiceRowsAnswer} from '../automation/whatsapp/private-invoice-read.mjs';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';

const deny=()=>assert.fail('Private content must not reach a provider or customer review');
const secret='PRIVATE-INVOICE-CANARY Kabir Textiles 20060';

test('network boundary discards private transcripts, schema enums, tool results, profiles, errors and media on every retry',async()=>{
  const requests=[];
  const provider=createPrivateChatProvider({message:'Tell me a joke',providerFactory:options=>new AIProvider(options),options:{
    geminiApiKey:'configured-but-prohibited',cfAccountId:'test',cfApiToken:'test',maxAttempts:1,
    fetchImpl:async(url,init)=>{
      assert.equal(new URL(url).hostname,'api.cloudflare.com');
      const body=JSON.parse(init.body);requests.push(body);
      assert.doesNotMatch(JSON.stringify(body),/PRIVATE-INVOICE-CANARY|Kabir|20060|base64|googleParts/);
      return Response.json({choices:[{message:{content:'A safe joke.'}}]});
    },
  }});
  for(let n=0;n<2;n++){
    const result=await provider.generate({messages:[{role:'system',content:secret},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+secret}}]},
      {role:'tool',content:secret},{role:'assistant',content:secret,googleParts:[secret]}],
      tools:[{function:{parameters:{enum:[secret]}}}],response_format:{enum:[secret]},error:secret,checkpoint:{transcript:[secret]}});
    assert.equal(result.content,'A safe joke.');
  }
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].messages.map(t=>t.role),['system','user']);
  assert.equal(requests[0].messages.at(-1).content,'Tell me a joke');
  await assert.rejects(provider.generateStructured({messages:[{role:'user',content:secret}]}),e=>e.code==='LOCAL_DATA_ONLY');
  assert.equal(requests.length,2);
});

test('private current turns never construct a provider, regardless of history or extraction flag',async()=>{
  for(const message of ['set customer to '+secret,'summarize our invoice review','What does Kabir owe?','invoice INV-PRIVATE 20060']){
    const provider=createPrivateChatProvider({message,providerFactory:deny,options:{}});
    assert.equal((await provider.generate()).content,PRIVATE_CHAT_REPLY);
  }
});

for(const route of [undefined,'offline'])test(`owner chat and deterministic reads survive upload, confirm, pruning and restart (flag=${route})`,async()=>{
  const f=await fixture({recording:true});try{
    if(route===undefined)delete f.routeEnv.EXTRACTION_ROUTE;
    f.restart();
    assert.equal((await f.turn('Tell me a joke')).answer,'Summary');
    const before=f.providerRecord.calls;
    const review=await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    assert.match(review.answer,/invoice|photo/i);
    assert.equal((await f.pending.loadInvoiceReview(f.scope)).action.extractionRoute,'offline');
    assert.equal(f.providerRecord.calls,before);
    assert.equal((await f.turn('Tell me a joke')).answer,'Summary');
    const corrected=await f.turn('set notes to PRIVATE-INVOICE-CANARY');
    assert.match(corrected.answer,/PRIVATE-INVOICE-CANARY/);
    const saved=await f.turn('Confirm',{interactionId:corrected.buttons[0].id});
    assert.match(saved.answer,/Saved invoice/);
    assert.equal(await f.count(),1);
    await f.db.query('delete from owner_assistant_turns where workspace_id=$1',[f.scope.workspaceId]);
    await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);
    f.restart();
    assert.equal((await f.turn('Tell me a joke')).answer,'Summary');
    const calls=f.providerRecord.calls;
    const balance=await f.turn('What is my outstanding balance?');
    assert.match(balance.answer,/Unissued drafts.*INR 20060.00/);
    const status=await f.turn('What is the status of invoice INV-2026-0142?');
    assert.match(status.answer,/INV-2026-0142/);
    assert.equal(f.providerRecord.calls,calls);
    for(const payload of f.providerRecord.requests)assert.doesNotMatch(JSON.stringify(payload),/Kabir|PRIVATE-INVOICE|20060|INV-2026|Cotton/);
    assert.equal((await f.supabase.rpc('owner_assistant_offline_provenance',{p_workspace_id:f.scope.workspaceId})).data,true);
  }finally{await f.close();}
});

test('customer payment receipts cannot mark a workspace, start review, extract, write, or call any provider',async()=>{
  for(const route of [undefined,'offline'])for(const authorized of [false,true]){
    const handler=createWhatsAppBoundMessageHandler({supabase:{from:deny,rpc:deny},env:{EXTRACTION_ROUTE:route},
      audience:'customer',...(authorized?{authorizeScope:async()=>true}:{}),providerFactory:deny,fetchImpl:deny,
      extract:deny,extractOffline:deny,pendingActionStoreFactory:deny,channelFactory:deny});
    for(const media of [{bytes:png,mimeType:'image/png'},{bytes:pdf,mimeType:'application/pdf'}]){
      const reply=await handler({workspaceId:'w',customerId:'c',phone:'+919818685252',message:'Paid PRIVATE-INVOICE-CANARY',media});
      assert.match(reply,/owner to verify and record the payment/);
      assert.match(reply,/Nothing was changed/);
    }
  }
});

test('customer chat before and after owner upload uses only current general text, and balances stay local',async()=>{
  const f=await fixture({recording:true});try{
    let calls=0;
    const handler=createWhatsAppBoundMessageHandler({supabase:f.supabase,env:{EXTRACTION_ROUTE:'offline'},audience:'customer',
      authorizeScope:async()=>true,providerFactory:()=>({async generate(request){calls++;assert.doesNotMatch(JSON.stringify(request),/Kabir|20060|PRIVATE-INVOICE/);return {content:'Hello there',model:CF_PRIMARY_MODEL};}}),
      invoiceStoreFactory:()=>({findInvoices:async()=>[{invoiceNumber:'INV-CUSTOMER',clientName:secret,currency:'INR',total:100,amountPaid:25,status:'sent',metadata:{invoice_direction:'receivable'}}]}),logger:{error(){}}});
    const ask=message=>handler({...f.scope,message});
    assert.equal(await ask('Tell me a joke'),'Hello there');
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,audience,role,content) values($1,$2,$3,'customer','assistant',$4)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,secret]);
    assert.equal(await ask('Tell me a joke'),'Hello there');
    assert.match(await ask('What is my outstanding balance?'),/Issued outstanding: INR 75.00/);
    assert.equal(calls,2);
  }finally{await f.close();}
});

test('Cloudflare exhausted chain never calls Gemini even with a saved legacy fallback and valid credentials',async()=>{
  const hosts=[];
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL,
    cfAccountId:'test',cfApiToken:'test',geminiApiKey:'legacy-key',maxAttempts:1,
    fetchImpl:async url=>{hosts.push(new URL(url).hostname);return Response.json({errors:[{code:3036,message:'daily neuron allocation exhausted'}]},{status:429});}});
  await assert.rejects(provider.generate({messages:[{role:'user',content:'Hello'}]}),e=>e.code==='RATE_LIMITED');
  assert.ok(hosts.length>0);
  assert.ok(hosts.every(host=>host==='api.cloudflare.com'));
});

test('deterministic answers refuse truncated data and keep currencies and drafts separate',()=>{
  const rows=[{invoice_number:'INV-A',currency:'INR',total_amount:'100',amount_paid:'25',status:'sent',metadata:{invoice_direction:'receivable'}},
    {invoice_number:'INV-B',currency:'USD',total_amount:'10',amount_paid:'0',status:'draft',metadata:{invoice_direction:'receivable'}}];
  const result={ok:true,readOnly:true,operation:'read',table:'invoices',rows,truncated:false,offset:0};
  assert.match(invoiceRowsAnswer('who owes what',result),/Issued outstanding: INR 75.00.*\nUnissued drafts.*USD 10.00/s);
  assert.match(invoiceRowsAnswer('who owes what',{...result,truncated:true}),/could not verify the complete/);
});

test('ordinary memory retains the last twenty messages across restart and excludes invoice quotations specifically',async()=>{
  const f=await fixture({recording:true});try{
    const messages=['My favourite colour is violet','My dog is named Pepper','I enjoy poetry','My favourite place is Goa',
      'I like the rain','I play the flute','I grow roses','My hobby is chess','I love the mountains','I collect stamps',
      'My favourite season is spring'];
    for(const message of messages)await f.turn(message);
    f.restart();
    await f.turn('What have I told you about myself?');
    const last=f.providerRecord.requests.at(-1).messages;
    assert.equal(last.length,22); // system + last 20 eligible messages + current
    assert.equal(last.some(turn=>turn.content===messages[0]),false);
    for(const message of messages.slice(1))assert.ok(last.some(turn=>turn.content===message),message);
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    // A bare exact invoice field, without an invoice keyword, must stay local.
    const before=f.providerRecord.calls;
    assert.match((await f.turn('Tell me about Kabir Textiles')).answer,/verified records/);
    assert.equal(f.providerRecord.calls,before);
    await f.turn('Tell me more about poetry');
    const payload=JSON.stringify(f.providerRecord.requests.at(-1));
    assert.match(payload,/My hobby is chess/);
    assert.doesNotMatch(payload,/Kabir|20060|INV-2026|Cotton|Local invoice review/);
    assert.ok((await f.db.query('select count(*)::integer n from whatsapp_provider_memory')).rows[0].n>20);
    await f.db.exec('set role authenticated');
    await assert.rejects(f.db.query('select * from whatsapp_provider_memory'));
    await assert.rejects(f.db.query('select * from whatsapp_private_invoice_terms'));
    await f.db.exec('reset role');
  }finally{await f.close();}
});

for(const route of [undefined,'offline'])test(`owner and customer receive honest temporary outage before and after upload (flag=${route})`,async()=>{
  const calls=[];
  const providerFactory=options=>new AIProvider({...options,cfAccountId:'fixture',cfApiToken:'fixture',geminiApiKey:'configured-but-disabled',maxAttempts:1,
    fetchImpl:async(url,init)=>{calls.push({host:new URL(url).hostname,body:JSON.parse(init.body)});return Response.json({errors:[{code:3036,message:'daily neuron quota exhausted'}]},{status:429});}});
  const f=await fixture({providerFactory});try{
    if(route===undefined)delete f.routeEnv.EXTRACTION_ROUTE;else f.routeEnv.EXTRACTION_ROUTE=route;f.restart();
    const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,env:f.routeEnv,audience:'customer',authorizeScope:async()=>true,providerFactory});
    for(const afterUpload of [false,true]){
      if(afterUpload)await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
      assert.equal((await f.turn('Tell me a short story')).answer,CHAT_UNAVAILABLE_REPLY);
      assert.equal(await customer({...f.scope,messageId:'customer-outage-'+afterUpload,message:'Tell me a short story'}),CHAT_UNAVAILABLE_REPLY);
    }
    assert.ok(calls.length>=4);assert.ok(calls.every(call=>call.host==='api.cloudflare.com'));
    for(const call of calls)assert.doesNotMatch(JSON.stringify(call.body),/Kabir|20060|Cotton|INV-2026/);
  }finally{await f.close();}
});

test('menus, signed lookup buttons and reminder refusals keep working after a local invoice',async()=>{
  const f=await fixture({recording:true,navigation:true});try{
    await f.db.exec(await readFile(new URL('../supabase/migrations/20261018060000_customer_reminder_tone.sql',import.meta.url),'utf8'));
    const first=await f.turn('menu');assert.ok(first.buttons.length);
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    await f.turn('yes');
    await f.turn('+14155550244');
    const menu=await f.turn('menu');assert.ok(menu.buttons?.length,JSON.stringify({menu,pending:await f.pending.loadPendingAction(f.scope)}));
    const lookup=await f.turn(menu.buttons[0].title,{interactionId:menu.buttons[0].id});
    assert.ok(lookup.answer);assert.doesNotMatch(lookup.answer,/offline.*limited|temporarily unavailable/);
    const number=(await f.db.query('select invoice_number from invoices where workspace_id=$1',[f.scope.workspaceId])).rows[0].invoice_number;
    const reminder=await f.turn('send a reminder for '+number+' now');
    assert.match(reminder.answer,/draft|sent or overdue|no customer|WhatsApp number|consent/i,JSON.stringify({reminder,errors:f.errors}));
    assert.equal(f.providerRecord.calls,0);
  }finally{await f.close();}
});

test('short quoted fields stay local after review pruning while ordinary words and memory remain available',async()=>{
  const f=await fixture({recording:true});try{
    await f.turn('My hobby is poetry');
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    await f.turn('set notes to Li');
    await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);f.restart();
    const before=f.providerRecord.calls;
    assert.match((await f.turn('Tell me about "Li"')).answer,/verified records/);
    assert.match((await f.turn('Explain the value "1"')).answer,/verified records/);
    assert.equal(f.providerRecord.calls,before);
    assert.equal((await f.turn('Tell me about living abroad')).answer,'Summary');
    assert.ok(f.providerRecord.requests.at(-1).messages.some(turn=>turn.content==='My hobby is poetry'));
  }finally{await f.close();}
});

test('customer ordinary memory retains twenty messages across restart and stays separate from owner memory',async()=>{
  const f=await fixture({recording:true});try{
    await f.turn('My private ordinary owner preference is violet');
    const requests=[];
    const create=()=>createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,
      providerFactory:()=>({async generate(request){requests.push(request);return {content:'Hello there',model:CF_PRIMARY_MODEL};}})});
    let customer=create();
    const subjects=['poetry','music','chess','gardening','hiking','cooking','painting','cycling','swimming','reading','singing'];
    for(const subject of subjects)await customer({...f.scope,messageId:'ordinary-customer-'+subject,message:'I enjoy '+subject});
    customer=create();await customer({...f.scope,messageId:'customer-restart',message:'What have I told you about myself?'});
    const turns=requests.at(-1).messages;assert.equal(turns.length,22);
    for(const subject of subjects.slice(1))assert.ok(turns.some(turn=>turn.content==='I enjoy '+subject));
    assert.doesNotMatch(JSON.stringify(turns),/private ordinary owner preference/);
  }finally{await f.close();}
});

test('eligible memory fills its twenty-message window after later invoice evidence excludes old quotations',async()=>{
  const f=await fixture({recording:true});try{
    for(const subject of ['poetry','music','chess','gardening','hiking','cooking','painting','cycling','swimming','reading','singing','dancing'])await f.turn('I enjoy '+subject);
    await f.turn('My secret project is CanaryAlpha');
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    await f.turn('set notes to CanaryAlpha');
    await f.turn('What have I told you about myself?');
    const turns=f.providerRecord.requests.at(-1).messages;
    assert.equal(turns.length,22);assert.doesNotMatch(JSON.stringify(turns),/CanaryAlpha|Kabir|20060/);
    assert.ok(turns.some(turn=>turn.content==='I enjoy gardening'));
  }finally{await f.close();}
});
