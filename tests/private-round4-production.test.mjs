import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider} from '../ai/provider.mjs';
import {createPrivateChatProvider,PRIVATE_CHAT_REPLY,PRIVATE_CHAT_SYSTEM_MESSAGE} from '../ai/private-chat.mjs';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';
import {createPrivateValueMatcher,privateFieldKeys,privateOriginValues,privateOriginKeys} from '../ai/private-value-matcher.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {fixture,png} from './fixtures/private-invoice.mjs';

const privateForms=[
 'The amounts are one thousand two hundred and fifty, seventy seven',
 'The amounts are twelve fifty, seventy seven',
 'The amounts are one thousand two hundred & fifty & seventy seven',
 'send 1 thousand 250 today','send 12 hundred and 50 today',
 '31Oct','Oct31','31Oct2026','31.Oct.2026','31/Oct/2026','31/Oct/26',
 '31-Oct-2026','Oct-31-2026',"31 Oct '26","October 31, '26",
 'Ask Acme and Sons for advice','Ask Acme & Sons for advice','Ask Acme-and-Sons for advice',
 'Here is the bill, Cedar Studio, 7500, due 12 Nov',
];
const ordinaryForms=['100','2,500','77','The amounts are seventy seven, two thousand five hundred',
 '31-Oct-2027','Oct-31-2027',"31 Oct '27","October 31, '27",'31 Oct 2027','is it due next Friday?','Quoted: roses are red','Forwarded: good morning','Forwarded: The amounts are 77, 2500','Quoted: due process is fair','Here is Bill Gates'];
const wireFactory=(captures,reply=()=>({content:'A safe answer'}))=>options=>new AIProvider({...options,
 cfAccountId:'local-fixture',cfApiToken:'local-fixture',maxAttempts:1,retryDelayMs:0,
 fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);
  captures.push({raw:init.body,messages:body.messages});return Response.json({choices:[{message:reply(body),finish_reason:'stop'}]});}});
async function production(){
 const captures=[],factory=wireFactory(captures),f=await fixture({providerFactory:factory});
 await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,['1250','2026-10-31']]);
 const c=(await f.db.query("insert into customers(workspace_id,name) values($1,'Acme & Sons') returning id",[f.scope.workspaceId])).rows[0];
 await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'NAME-PRIVATE-R4',43,'INR','draft')",[f.scope.workspaceId,c.id]);
 let sequence=0,customer;
 const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 const turn=(audience,message)=>audience==='owner'?f.turn(message):customer({...f.scope,message,messageId:'r4-customer-'+(++sequence)});
 return {...f,captures,factory,turn,restart,upload:()=>f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}})};
}

test('round4 actual SQL-backed owner/customer + actual AIProvider HTTP serialization contains all P1 classes before/after upload',async t=>{
 const f=await production();try{
  for(const uploaded of [false,true]){
   if(uploaded)await f.upload();
   // Use the fixture upload seam directly, then reconstruct both real handlers.
   if(uploaded)await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);
   f.restart();
   for(const audience of ['owner','customer'])for(const message of privateForms)await t.test(`${audience}/${uploaded}: ${message}`,async()=>{
    const before=f.captures.length;await f.turn(audience,message);
    assert.equal(f.captures.length,before,JSON.stringify(f.captures.slice(before).map(x=>x.messages)));
   });
  }
 }finally{await f.close();}
});

test('round4 different-year and unrelated-number controls remain provider-bound for both audiences',async t=>{
 const f=await production();try{
  for(const uploaded of [false,true]){
  if(uploaded){await f.upload();await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);f.restart();}
  for(const audience of ['owner','customer'])for(const message of ordinaryForms)await t.test(`${audience}/${uploaded}: ${message}`,async()=>{
   const before=f.captures.length;await f.turn(audience,message);assert.equal(f.captures.length,before+1,message);
   assert.equal(f.captures.at(-1).messages.at(-1).content,message);
  });
  }
 }finally{await f.close();}
});

test('round4 ordinary recipe clauses survive plain and while private fields stay absent from HTTP and memory',async t=>{
 const f=await production();try{
  for(const uploaded of [false,true]){
  if(uploaded){await f.upload();await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);f.restart();}
  for(const audience of ['owner','customer'])for(const suffix of ['send 1250 today','The amounts are twelve fifty, seventy seven','Here is the bill, Cedar Studio, 7500, due 12 Nov'])await t.test(audience+suffix,async()=>{
   const message='give me a pasta recipe and '+suffix,before=f.captures.length;await f.turn(audience,message);
   assert.equal(f.captures.length,before+1);assert.equal(f.captures.at(-1).messages.at(-1).content,'give me a pasta recipe');
   assert.doesNotMatch(f.captures.at(-1).raw,/1250|twelve fifty|Cedar Studio|7500|12 Nov/);
  });
  }
 }finally{await f.close();}
});

test('round4 Rs. correction persists numeric containment through cancel and a new session',async t=>{
 const captures=[],original=await fixture({providerFactory:wireFactory(captures)});try{
  await original.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
  await original.turn('set notes to Rs.1,250');await original.turn('cancel');original.restart();
  const customer=createWhatsAppBoundMessageHandler({supabase:original.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:wireFactory(captures),logger:{error(){}}});
  for(const audience of ['owner','customer'])await t.test(audience,async()=>{
   const before=captures.length;if(audience==='owner')await original.turn('send 1250 today');else await customer({...original.scope,message:'send 1250 today',messageId:'r4-rs-customer'});
   assert.equal(captures.length,before,JSON.stringify(captures.slice(before).map(x=>x.messages)));
  });
  const aliases=(await original.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[original.scope.workspaceId])).rows.map(row=>row.term);
  assert.ok(aliases.includes('number:1250'));
 }finally{await original.close();}
});

test('round4 private quotation fields never become ordinary memory and remain contained after restart',async t=>{
 for(const audience of ['owner','customer'])for(const uploaded of [false,true])await t.test(`${audience}/${uploaded}`,async()=>{
  const f=await production();try{
   if(uploaded){await f.upload();await f.db.query('delete from whatsapp_pending_actions where workspace_id=$1',[f.scope.workspaceId]);f.restart();}
   assert.equal(createPrivateValueMatcher((await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term))('Cedar Studio'),false);
   const before=f.captures.length;await f.turn(audience,'Here is the bill, Cedar Studio, 7500, due 12 Nov');assert.equal(f.captures.length,before);
   f.restart();await f.turn(audience,'Tell me a joke');assert.equal(f.captures.length,before+1);assert.doesNotMatch(f.captures.at(-1).raw,/Cedar|7500|12 Nov/);
   await f.turn(audience,'Ask Cedar Studio for advice');assert.equal(f.captures.length,before+1,'private-origin fields stay retained across restart');
   const rows=(await f.db.query('select content from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId])).rows;
   assert.ok(rows.length);assert.ok(rows.every(row=>!/Cedar|7500|12 Nov/.test(row.content)));
  }finally{await f.close();}
 });
});

// Real persisted SQL memory and actual Cloudflare serialization at every shared
// boundary. The handler matrix above independently proves production routing.
test('round4 canonical screening is coherent in history, writes, responses and decoded tool arguments/results for both audiences',async()=>{
 const f=await production();try{
  const stored=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term),matches=createPrivateValueMatcher(stored);
  for(const audience of ['owner','customer'])for(const [i,value] of privateForms.entries()){
   const scope={...f.scope,audience,messageId:`r4-boundary-${audience}-${i}`};
   const memory=()=>createPrivateChatMemory({supabase:f.supabase,scope});
   const count=()=>f.db.query('select count(*)::int n from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]).then(r=>r.rows[0].n);
   const m=memory();await m.read('Tell me about gardening');const before=await count();await m.append('Tell me about gardening',value);await m.append(value,'A safe answer');assert.equal(await count(),before,value);
   await f.db.query(`insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance)
    values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')`,[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience,scope.messageId+'-history',value]);
   const captures=[];
   const make=(factory=wireFactory(captures))=>createPrivateChatProvider({message:'Tell me about gardening',memory:memory(),options:{},providerFactory:factory});
   await make().generate();assert.equal(captures.length,1);assert.equal(matches(captures[0].messages.slice(1)),false,value);
   const responses=[];const reply=await make(wireFactory(responses,()=>({content:value}))).generate();assert.equal(reply.content,PRIVATE_CHAT_REPLY,value);
   const args=[];const p=make(wireFactory(args,()=>({content:'',tool_calls:[{id:'private-args',type:'function',function:{name:'probe',arguments:JSON.stringify({nested:[{value}]})}}]})));
   p.setTools([{type:'function',function:{name:'probe',parameters:{type:'object'}}}]);assert.deepEqual((await p.generate({tools:[{function:{name:'probe'}}]})).toolCalls,[],value);
   const results=[];const q=make(wireFactory(results,()=>({content:'',tool_calls:[{id:'issued',type:'function',function:{name:'probe',arguments:'{}'}}]})));
   q.setTools([{type:'function',function:{name:'probe',parameters:{type:'object'}}}]);const issued=await q.generate({tools:[{function:{name:'probe'}}]});
   const result=await q.generate({messages:[{role:'assistant',tool_calls:issued.toolCalls},{role:'tool',tool_call_id:'issued',content:JSON.stringify({nested:{value}})}]});
   assert.equal(result.content,PRIVATE_CHAT_REPLY,value);assert.equal(results.length,1,value);
   for(const capture of [...captures,...responses,...args,...results]){assert.equal(capture.messages[0].content,PRIVATE_CHAT_SYSTEM_MESSAGE);assert.equal(matches(capture.messages.slice(1)),false,value);}
   await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);
  }
 }finally{await f.close();}
});

test('round4 actual owner tool loop contains every new private representation before a second HTTP request',async()=>{
 const f=await production();try{
  for(const value of privateForms){
   const captures=[];
   const handler=createOwnerMessageHandler({supabase:f.supabase,authorize:async()=>true,replyStore:null,logger:{info(){},warn(){},error(){}},
    toolsFactory:()=>({definitions:[{type:'function',function:{name:'getAIProviderConfiguration',parameters:{type:'object'}}}],async execute(){return {ok:true,detail:value};}}),
    providerFactory:wireFactory(captures,()=>({content:'',tool_calls:[{id:'issued',type:'function',function:{name:'getAIProviderConfiguration',arguments:'{}'}}]}))});
   await handler({...f.scope,message:'Which model is running?',messageId:'r4-owner-tool-'+privateForms.indexOf(value)});
   assert.equal(captures.length,1,value);assert.doesNotMatch(captures[0].raw,/1250|twelve fifty|Cedar Studio|Acme|31Oct|31\/Oct/);
  }
 }finally{await f.close();}
});

test('round4 SQL and JS construct exactly the same canonical field and private-origin keys',async()=>{
 const f=await production();try{
  const corpus=['one thousand two hundred and fifty, seventy seven','twelve fifty, seventy seven','1 thousand 250','12 hundred and 50','Rs.1,250','Rs. 1,250','1.25 thousand','Acme & Sons','Acme and Sons','Acme-and-Sons','Company One, Branch Two',...privateForms.slice(5,15),...ordinaryForms.slice(4), '31Apr2026','31/Oct/26','31Oct2026.','31.Oct.2026.','2026-10-31.','Rs.1,250.','twelve fifty.','one;1250','twelve.fifty','AcmeAndSons','"31/Oct/26"','"twelve fifty"'];
  for(const value of corpus){
   const sql=(await f.db.query('select app.private_invoice_term_aliases($1) term',[value])).rows.map(row=>row.term);
   assert.deepEqual([...new Set(sql)].sort(),privateFieldKeys(value).sort(),value);
  }
  for(const value of ['Here is the bill, Cedar Studio, 7500, due 12 Nov',"Here is the bill, Cedar Studio, 7500, due October 31, '26",'Forwarded: Cedar Studio,7500,due 12 Nov','Here is the bill from Cedar Studio,7500,due 12 Nov']){
   const sql=(await f.db.query('select app.private_invoice_origin_aliases($1) term',[value])).rows.map(row=>row.term),fields=privateOriginValues(value);
   const js=privateOriginKeys(value);assert.deepEqual([...new Set(sql)].sort(),[...new Set(js)].sort(),value);
  }
 }finally{await f.close();}
});


test('round4 alphabetic name keys normalize connector renderings in both storage directions',async()=>{
 const captures=[],f=await fixture({providerFactory:wireFactory(captures)});try{
  const c=(await f.db.query("insert into customers(workspace_id,name) values($1,'AcmeAndSons') returning id",[f.scope.workspaceId])).rows[0];
  await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R4-CAMEL',43,'INR','draft')",[f.scope.workspaceId,c.id]);
  const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:wireFactory(captures),logger:{error(){}}});
  for(const value of ['Ask Acme & Sons for advice','Ask Acme and Sons for advice','Ask Acme-and-Sons for advice']){await f.turn(value);await customer({...f.scope,message:value,messageId:'r4-name-'+value});}
  assert.deepEqual(captures,[]);
 }finally{await f.close();}
});
