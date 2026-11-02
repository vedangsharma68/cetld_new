import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';
import {createPrivateChatProvider,PRIVATE_CHAT_REPLY} from '../ai/private-chat.mjs';
import {createPrivateValueMatcher} from '../ai/private-value-matcher.mjs';
import {fixture} from './fixtures/private-invoice.mjs';

// Real boundary + real memory implementation; capture the exact serialized
// provider messages, not merely an extraction callback or provider call count.
function harness({terms=['1250','anurag','2026-10-31'],history=[],response='Hello there',failure=false}={}){
  const payloads=[],writes=[];
  const supabase={from(table){const q={select(){return q},eq(){return q},order(){return q},
    async limit(){return {data:history}},async range(){return failure?{error:{code:'UNAVAILABLE'}}:{data:table==='whatsapp_private_invoice_terms'?terms.map(term=>({term})):[]}},
    async insert(rows){writes.push(...rows);return {data:null}}};return q;}};
  const memory=createPrivateChatMemory({supabase,scope:{workspaceId:'w',ownerId:'o',phone:'+12025550101',audience:'owner',messageId:'m'}});
  const provider=message=>createPrivateChatProvider({message,memory,options:{},providerFactory:()=>({async generate(request){payloads.push(JSON.parse(JSON.stringify(request.messages)));return typeof response==='function'?response(request):{content:response};}})});
  return {provider,memory,payloads,writes};
}
const variants=['send 1,250 today','twelve fifty today','one thousand two hundred and fifty today','1,250.00','1250USD','USD1,250.00','1,250rupees','1250.00','001250.000',
  'is it due 31 Oct?','is it due 31 October?','31/10/2026','Oct 31 2026','October 31, 2026','31-10-2026','31st Oct 2026'];
for(const message of variants)test(`serialized payload excludes retained variant: ${message}`,async()=>{
  const h=harness();assert.equal((await h.provider(message).generate()).content,PRIVATE_CHAT_REPLY);assert.deepEqual(h.payloads,[]);assert.deepEqual(h.writes,[]);
});
for(const message of ['1,25,000','1,25,000.00','125,000.00','one lakh twenty five thousand'])test(`Indian amount restatement stays local: ${message}`,async()=>{
  const h=harness({terms:['125000']});assert.equal((await h.provider(message).generate()).content,PRIVATE_CHAT_REPLY);assert.deepEqual(h.payloads,[]);
});
for(const term of ['1,250.00','1250.000','twelve fifty','31 Oct 2026','31/10/2026','Oct 31 2026','31-10-2026'])test(`reverse canonicalization of stored ${term}`,async()=>{
  const h=harness({terms:[term]});await h.provider(term.includes('1250')||term.includes('1,250')||term==='twelve fifty'?'send 1250 today':'2026-10-31').generate();assert.deepEqual(h.payloads,[]);
});
test('workspace specificity: unretained 100 reaches provider, retained 100 never does; token collisions stay ordinary',async()=>{
  const h=harness();await h.provider('I walked 100 steps today').generate();assert.equal(h.payloads.at(-1).at(-1).content,'I walked 100 steps today');
  const privateH=harness({terms:['100','ann','INV-12']});
  for(const text of ['100','100.00','0,100.00','one hundred','I walked 100 steps today'])await privateH.provider(text).generate();
  assert.deepEqual(privateH.payloads,[]);
  for(const text of ['I walked 1000 steps today','Planning a holiday','Explain INV-123'])await privateH.provider(text).generate();
  assert.equal(privateH.payloads.length,3); // No substring match: 100/1000, ann/planning, INV-12/INV-123.
});
test('mixed turns send only independent ordinary clauses and store only that ordinary conversation',async()=>{
  for(const message of ['good morning, also is 1250 ok?','Good morning; send 1,250 today','Tell me a joke; twelve fifty today','Hello! Is it due 31 Oct?']){
    const h=harness();const reply=await h.provider(message).generate();
    assert.match(reply.content,/Hello there/);assert.match(reply.content,/kept the private part local/);assert.equal(h.payloads.length,1);
    const wire=JSON.stringify(h.payloads);assert.doesNotMatch(wire,/1250|1,250|twelve fifty|31 Oct|anurag/);
    assert.doesNotMatch(JSON.stringify(h.writes),/1250|1,250|twelve fifty|31 Oct|private part/);
  }
  const h=harness();await h.provider('1250; explain that instead').generate();assert.deepEqual(h.payloads,[]);
});
test('history, issued tool results, tool arguments and model responses share canonical screening',async()=>{
  const history=['1,250 today','twelve fifty today','31 Oct','ordinary poetry'].map((content,id)=>({id,role:'user',content,provenance:'ordinary_chat_v1'}));
  const h=harness({history});await h.provider('Hello').generate();assert.deepEqual(h.payloads[0].slice(1,-1),[{role:'user',content:'ordinary poetry'}]);
  for(const value of ['1,250.00','twelve fifty','31 Oct']){
    const output=harness({response:value});assert.equal((await output.provider('Hello').generate()).content,PRIVATE_CHAT_REPLY);assert.deepEqual(output.writes,[]);
    const tool=harness({response:()=>({toolCalls:[{id:'issued',function:{name:'lookup',arguments:'{}'}}]})});
    const provider=tool.provider('Explain gardening');provider.setTools([{type:'function',function:{name:'lookup',parameters:{type:'object'}}}]);
    const first=await provider.generate({tools:[{function:{name:'lookup'}}]});
    await provider.generate({messages:[{role:'assistant',tool_calls:first.toolCalls},{role:'tool',tool_call_id:'issued',content:JSON.stringify({detail:value})}]});
    assert.equal(tool.payloads.length,1);assert.doesNotMatch(JSON.stringify(tool.payloads),/1,250|twelve fifty|31 Oct/);
    const args=harness({response:()=>({toolCalls:[{id:'bad',function:{name:'lookup',arguments:JSON.stringify({detail:value})}}]})});
    const ap=args.provider('Hello');ap.setTools([{type:'function',function:{name:'lookup'}}]);assert.deepEqual((await ap.generate({tools:[{function:{name:'lookup'}}]})).toolCalls,[]);
  }
});
test('store failures fail closed even when an ordinary clause could be separated',async()=>{
  const h=harness({failure:true});await assert.rejects(h.provider('Hello; send 1,250 today').generate(),{code:'CHAT_MEMORY_UNAVAILABLE'});assert.deepEqual(h.payloads,[]);
});
test('unapplied SQL retains raw values plus canonical aliases atomically, including invalid-date safety and helper ACLs',async()=>{
  const f=await fixture({recording:true});try{
    await f.db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,source,action,expires_at) values($1,$2,$3,'whatsapp',$4,now()+interval '15 minutes')",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,{type:'invoice_review_draft',invoice:{total:'1,25,000.00',dueDate:'31 Oct 2026',notes:'2026-02-31'}}]);
    const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
    for(const term of ['1,25,000.00','125000','31 oct 2026','2026-10-31','31 oct','2026-02-31'])assert.ok(terms.includes(term),term);
    for(const role of ['anon','authenticated','service_role'])assert.equal((await f.db.query("select has_function_privilege($1,'app.private_invoice_term_aliases(text)','execute') allowed",[role])).rows[0].allowed,false);
    assert.equal(createPrivateValueMatcher(terms)('one lakh twenty five thousand'),true);
  }finally{await f.close();}
});

test('production owner/customer mixed routes answer ordinary clauses during a local review without executing private edits',async()=>{
  const {createWhatsAppBoundMessageHandler}=await import('../automation/whatsapp/assistant-handler.mjs');
  const f=await fixture({recording:true});try{
    await f.turn('We issued this invoice',{media:{bytes:Buffer.from([137,80,78,71,13,10,26,10,0]),mimeType:'image/png'}});
    const before=await f.pending.loadInvoiceReview(f.scope);
    const owner=await f.turn('Tell me a joke; change invoice total to 1,250');
    assert.match(owner.answer,/Summary/);assert.match(owner.answer,/private part local/);
    assert.deepEqual(await f.pending.loadInvoiceReview(f.scope),before);
    assert.equal(f.providerRecord.requests.at(-1).messages.at(-1).content,'Tell me a joke');
    const payloads=[];
    const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,
      providerFactory:()=>({async generate(request){payloads.push(JSON.parse(JSON.stringify(request.messages)));return {content:'A safe joke'};}})});
    assert.match(await customer({...f.scope,message:'Tell me a joke; change invoice total to 1,250',messageId:'mixed-customer'}),/A safe joke/);
    assert.match(await customer({...f.scope,message:'change its amount to 100',messageId:'customer-edit-refused'}),/Only the business owner/);
    assert.equal(payloads.length,1);
    assert.equal(payloads.at(-1).at(-1).content,'Tell me a joke');assert.doesNotMatch(JSON.stringify(payloads),/1,250|Kabir|20060|total/);
    assert.deepEqual(await f.pending.loadInvoiceReview(f.scope),before);
  }finally{await f.close();}
});

test('an issued tool ID cannot launder altered assistant arguments or an unissued transcript',async()=>{
  const h=harness({response:()=>({toolCalls:[{id:'issued',function:{name:'lookup',arguments:'{}'}}]})});
  const provider=h.provider('Hello');provider.setTools([{type:'function',function:{name:'lookup'}}]);
  await provider.generate({tools:[{function:{name:'lookup'}}]});
  const reply=await provider.generate({messages:[{role:'assistant',tool_calls:[{id:'issued',function:{name:'lookup',arguments:'{"amount":"1,250"}'}}]}]});
  assert.equal(reply.content,PRIVATE_CHAT_REPLY);assert.equal(h.payloads.length,1);
  const fresh=harness();await fresh.provider('Hello').generate({messages:[{role:'assistant',tool_calls:[{id:'unissued',function:{name:'lookup',arguments:'{"value":"31 Oct"}'}}]}]});
  assert.equal(fresh.payloads.length,1);assert.doesNotMatch(JSON.stringify(fresh.payloads),/31 Oct|unissued/);
});
