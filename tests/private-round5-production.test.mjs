import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';
import {createPrivateChatProvider,PRIVATE_CHAT_REPLY} from '../ai/private-chat.mjs';
import {privateFieldKeys,privatePartyKeys,privateOriginValues} from '../ai/private-value-matcher.mjs';
const factory=(wires,reply=()=>({content:'An ordinary answer'}))=>options=>new AIProvider({...options,cfAccountId:'local-r5',cfApiToken:'local-r5',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({raw:init.body,body});return Response.json({choices:[{message:reply(body)}]});}});
test('round5 currency composition retains canonical values before all four production sinks',async()=>{
 for(const[stored,amount]of[['twelve fifty rupees','1250'],['Rs 1.25 lakh','125000'],['₹1,250/-','1250'],['Rs.1,250/-','1250'],['बारह सौ पचास रुपये','1250']]){
  const wires=[],f=await fixture({providerFactory:factory(wires)});try{
   await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:stored}]);
   assert.ok((await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.some(r=>r.term==='number:'+amount),stored);
   for(const audience of ['owner','customer']){
    const scope={...f.scope,audience,messageId:'r5-'+audience},memory=()=>createPrivateChatMemory({supabase:f.supabase,scope});
    const current='send '+amount+' today';const m=memory();assert.equal(m.containsPrivate(current),true,'Uninitialized store must fail closed');await m.read('Tell me a joke');assert.equal(m.containsPrivate(current),true);
    const count=async()=>(await f.db.query('select count(*)::int n from whatsapp_provider_memory')).rows[0].n;
    const before=await count();await m.append('Tell me a joke',current);await m.append(current,'An ordinary answer');assert.equal(await count(),before);
    await f.db.query(`insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')`,[scope.workspaceId,audience==='owner'?scope.ownerId:null,audience==='customer'?scope.customerId:null,scope.phone,audience,'r5-history-'+audience,current]);
    const calls=[];const provider=(pf=factory(calls))=>createPrivateChatProvider({message:'Tell me a joke',memory:memory(),options:{},providerFactory:pf});
    await provider().generate();assert.equal(calls.length,1);assert.ok(calls.every(c=>!JSON.stringify(c.body.messages).includes(current)));
    assert.equal((await provider(factory([],()=>({content:current}))).generate()).content,PRIVATE_CHAT_REPLY);
    const toolCalls=[];const p=provider(factory(toolCalls,()=>({content:'',tool_calls:[{id:'issued',type:'function',function:{name:'probe',arguments:'{}'}}]})));p.setTools([{type:'function',function:{name:'probe',parameters:{type:'object'}}}]);
    const result=await p.generate({tools:[{function:{name:'probe'}}]});assert.equal(result.toolCalls.length,1);
    assert.equal((await p.generate({messages:[{role:'assistant',tool_calls:result.toolCalls},{role:'tool',tool_call_id:'issued',content:JSON.stringify({nested:{value:current}})}]})).content,PRIVATE_CHAT_REPLY);assert.equal(toolCalls.length,1);
    const argumentsCalls=[];const a=provider(factory(argumentsCalls,()=>({content:'',tool_calls:[{id:'bad',type:'function',function:{name:'probe',arguments:JSON.stringify({value:current})}}]})));a.setTools([{type:'function',function:{name:'probe',parameters:{type:'object'}}}]);assert.deepEqual((await a.generate({tools:[{function:{name:'probe'}}]})).toolCalls,[]);
    const n=wires.length;const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory(wires),logger:{error(){}}});if(audience==='owner')await f.turn(current);else await customer({...f.scope,message:current,messageId:'r5-current'});assert.equal(wires.length,n);
    await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[scope.workspaceId]);
   }
  }finally{await f.close();}
 }
});
test('round5 linked-party specificity matrix, component references and transliteration at actual HTTP boundary',async t=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});try{
  let id=0;const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory(wires),logger:{error(){}}});
  const turn=(a,m)=>a==='owner'?f.turn(m):customer({...f.scope,message:m,messageId:'r5-name-'+(++id)});
  for(const audience of ['owner','customer']){const n=wires.length;await turn(audience,'Ask Sharma for advice');assert.equal(wires.length,n+1,'Unretained common name stays ordinary');}
  const c=(await f.db.query("insert into customers(workspace_id,name) values($1,'Anurag Sharma') returning id",[f.scope.workspaceId])).rows[0];await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R5-NAMES',43,'INR','draft')",[f.scope.workspaceId,c.id]);f.restart();
  for(const audience of ['owner','customer'])for(const [input,privateTurn]of[
   ['Ask Anurag for advice',true],['ask Sharma today',true],['Ask अनुराग for advice',true],['ask शर्मा today',true],['Ask Anurag Sharma for advice',true],
   ['Sharma is a common surname',false],['Explain the etymology of the surname Sharma',false],['Ask Sharmila for advice',false],['Ask Anuradha for advice',false],['we are 100 people coming',false],['The numbers are 77,2500',false]])await t.test(audience+'/'+input,async()=>{const n=wires.length;await turn(audience,input);assert.equal(wires.length-n,privateTurn?0:1,input);});
 }finally{await f.close();}
});
test('round5 field, party, origin keys agree byte-for-byte across Unicode/symbol and repeated-origin corpus',async()=>{
 const f=await fixture();try{
  const values=['C++','Acme+','A+ Studio','Acme $ Sons','Acme©','किरण','करण','कमल','कोमल','İlker','I\u0307lker','A\u0085Studio','A\u00a0Studio','Anu\u200brag','₹1,250/-','twelve fifty rupees','Rs 1.25 lakh','1¼ thousand','1½ thousand','1⅛ thousand','Li Wang',...Array.from('¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞').map(g=>'1'+g+' thousand'),'बारह सौ पचास रुपये','31 अक्टूबर 2026','३१ अक्टूबर २०२६',...Object.keys((await import('../ai/private-value-language.mjs')).lexicalAliases)];
  for(const value of values){const sql=(await f.db.query('select distinct term from app.private_invoice_term_aliases($1) term order by term',[value])).rows.map(r=>r.term);assert.deepEqual(sql,[...new Set(privateFieldKeys(value))].sort(),value);const party=(await f.db.query('select distinct term from app.private_invoice_party_aliases($1) term order by term',[value])).rows.map(r=>r.term);assert.deepEqual(party,[...new Set(privatePartyKeys(value))].sort(),value);}
  for(const value of ['This invoice is from Willow Workshop,8654,due 12 Nov','Earlier here is the bill gates note; Here is the bill, Cedar Studio,7500,due 12 Nov','Mention invoice first; This invoice is from Maple Studio,9685,due 12 Nov']){const sql=(await f.db.query('select distinct term from app.private_invoice_origin_aliases($1) term order by term',[value])).rows.map(r=>r.term);const fields=privateOriginValues(value);const js=[...new Set(['origin:'+fields[0],...fields.flatMap(privateFieldKeys)])].sort();assert.deepEqual(sql,js,value);}
 }finally{await f.close();}
});

test('round5 linked native parties retain distinguishing vowel length and vowel signs',async()=>{
 for(const[stored,other]of[['किरण','करण'],['कमल','कोमल'],['राम','रम']]){const wires=[],f=await fixture({providerFactory:factory(wires)});try{
  const c=(await f.db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[f.scope.workspaceId,stored])).rows[0];await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'NATIVE-PARTY',43,'INR','draft')",[f.scope.workspaceId,c.id]);
  await f.turn('Ask '+other+' for advice');assert.equal(wires.length,1,stored+' != '+other);await f.turn('Ask '+stored+' for advice');assert.equal(wires.length,1);
 }finally{await f.close();}}
});


test('round5 linguistic-name exception never applies to private tool/response/memory data',async()=>{
 const f=await fixture();try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{partyNames:['Anurag Sharma']}]);
  for(const audience of ['owner','customer']){
   const memory=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience,messageId:'r5-strict-'+audience}});await memory.read('Tell me a joke');
   const value='Sharma is a common surname';assert.equal(memory.containsOrdinary(value),false);assert.equal(memory.containsPrivate(value),true);
   const rows=(await f.db.query('select count(*)::int n from whatsapp_provider_memory')).rows[0].n;await memory.append('Tell me a joke',value);assert.equal((await f.db.query('select count(*)::int n from whatsapp_provider_memory')).rows[0].n,rows);
   const wires=[],provider=createPrivateChatProvider({message:'Tell me a joke',memory,options:{},providerFactory:factory(wires,()=>({content:value}))});assert.equal((await provider.generate()).content,PRIVATE_CHAT_REPLY);
   assert.equal(wires.length,1);assert.ok(!wires[0].raw.includes('Sharma'));
  }
 }finally{await f.close();}
});


test('round5 short formal given-name components are retained, not dismissed as nicknames',async()=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});try{
  const c=(await f.db.query("insert into customers(workspace_id,name) values($1,'Li Wang') returning id",[f.scope.workspaceId])).rows[0];await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R5-SHORT-NAME',43,'INR','draft')",[f.scope.workspaceId,c.id]);await f.turn('Ask Li for advice');assert.equal(wires.length,0);await f.turn('Explain the surname Li');assert.equal(wires.length,1);
 }finally{await f.close();}
});
