import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';
import {createPrivateChatProvider} from '../ai/private-chat.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {privateOriginKeys,privateFieldKeys,privatePartyKeys,normalizePrivateValue} from '../ai/private-value-matcher.mjs';
const factory=wires=>options=>new AIProvider({...options,cfAccountId:'round7-local',cfApiToken:'round7-local',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{
 assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push(body.messages);return Response.json({choices:[{message:{content:'An ordinary answer'}}]});
}});
const sources=[
 'I issued an invoice of 6847 to Alder Finch, due 16 July 2027',
 'We sent the invoice for 6847 to Alder Finch, due 16 July 2027',
 'Here is an invoice of one thousand two hundred and fifty to Alder Finch, due 16 July 2027',
 'Our invoice to Alder Finch for 6847, due 16 July 2027',
 'Invoice #AB-6847\nAlder Finch\nTotal 6847\nDue 16 July 2027',
 'Invoice number AB-6847\nAlder Finch\nTotal: 6847\nDue: 16 July 2027',
 'Receipt №AB-6847\nAlder Finch\nTotal 6847\nDue 16 July 2027',
];
test('round7 declaration grammar and every field key remain identical in SQL and JavaScript',async()=>{
 const f=await fixture();try{
  for(const source of [...sources,...sources.map(s=>'Notes: '+s),...sources.map(s=>'Tell me a joke; '+s)]){
   const sql=(await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(r=>r.k);
   assert.deepEqual(sql,[...new Set(privateOriginKeys(source))].sort(),source);
   assert.equal((await f.db.query('select app.private_invoice_has_origin($1) yes',[source])).rows[0].yes,true);
   for(const key of ['party:alder','party:finch','date:2027-07-16'])assert.ok(sql.includes(key),source+'/'+key);
   assert.ok(sql.includes(source.includes('one thousand')?'number:1250':'number:6847'),source);
  }
  for(const source of ['Van Harper','The Cedar Studio','De Harper','To Harper'])assert.deepEqual((await f.db.query('select distinct k from app.private_invoice_party_aliases($1) k order by k',[source])).rows.map(r=>r.k),privatePartyKeys(source).sort());
 }finally{await f.close();}
});
test('round7 sentence and compact sources keep all fields local across every durable retention sink and reconstruction',async t=>{
 for(const source of [sources[0],sources[4]])for(const sink of ['turn','terms','owner-audit','customer-audit','memory-write'])await t.test(sink+'/'+source.split('\n')[0],async()=>{
  const wires=[],f=await fixture({providerFactory:factory(wires)});let n=0;
  try{
   if(sink==='turn')for(const audience of ['owner','customer']){
    const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory(wires),logger:{error(){}}});
    const before=wires.length;await(audience==='owner'?f.turn(source):customer({...f.scope,message:source,messageId:'r7-source-'+(++n)}));assert.equal(wires.length,before);
   }
   if(sink==='terms')await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:source}]);
   if(sink==='owner-audit')await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,'r7-source','whatsapp','user',$3)",[f.scope.workspaceId,f.scope.ownerId,source]);
   if(sink==='customer-audit')await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,'user',$4)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,source]);
   if(sink==='memory-write')for(const audience of ['owner','customer']){
    const memory=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience,messageId:'r7-private-'+audience}});await memory.read('Hello');await memory.append('Hello',source);
   }
   for(const audience of ['owner','customer']){
    f.restart();const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory(wires),logger:{error(){}}});
    for(const message of ['Ask Alder for advice','Ask Finch for advice','send 6847 today','is it due 16 July 2027?']){
     const before=wires.length;await(audience==='owner'?f.turn(message):customer({...f.scope,message,messageId:'r7-followup-'+(++n)}));assert.equal(wires.length,before,message);
    }
    const memory=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience,messageId:'r7-mixed-'+(++n)}});
    const before=wires.length,p=createPrivateChatProvider({message:'Help me plan a walk; '+source,memory,options:{},providerFactory:factory(wires)});await p.generate();
    assert.equal(wires.length,before+1);assert.equal(wires.at(-1).at(-1).content,'Help me plan a walk');assert.doesNotMatch(JSON.stringify(wires),/Alder|Finch|6847|July/);
   }
   assert.ok((await f.db.query('select content from whatsapp_provider_memory')).rows.every(r=>!r.content.includes('Alder')&&!r.content.includes('6847')));
  }finally{await f.close();}
 });
});
test('round7 grammatical formal components keep personal-reference scope without articles or vehicle over-blocking',async t=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});let n=0;
 try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{partyNames:['Van Harper','De Harper','The Cedar Studio']}]);
  for(const audience of ['owner','customer'])for(const [input,privateTurn]of [
   ['Ask Van for advice',true],['Is Van coming tomorrow?',true],['Van was here yesterday',true],['I saw Van yesterday',true],['Ask De for advice',true],
   ['I bought a van today',false],['The van was red',false],['Ask the doctor for advice',false],['What is the capital of France?',false],['Birds enjoy the sunshine.',false],
  ])await t.test(audience+'/'+input,async()=>{
   f.restart();const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory(wires),logger:{error(){}}});
   const before=wires.length;await(audience==='owner'?f.turn(input):customer({...f.scope,message:input,messageId:'r7-name-'+(++n)}));assert.equal(wires.length-before,privateTurn?0:1,input);
  });
 }finally{await f.close();}
});
test('round7 typographic dash class folds identically and never discards an explicit different year',async()=>{
 const f=await fixture();try{
  const dashes=[];for(let cp=0;cp<=0x10ffff;cp++){const ch=String.fromCodePoint(cp);if(/[\p{Pd}\u2212]/u.test(ch))dashes.push(ch);}
  for(const dash of dashes)for(const value of [`31${dash}Oct${dash}2026`,`31${dash}10${dash}26`,`2026${dash}10${dash}31`,`31${dash}Oct${dash}2027`]){
   assert.equal((await f.db.query('select app.private_invoice_normalize($1) v',[value])).rows[0].v,normalizePrivateValue(value));
   const sql=(await f.db.query('select distinct k from app.private_invoice_term_aliases($1) k order by k',[value])).rows.map(r=>r.k);
   assert.deepEqual(sql,privateFieldKeys(value).sort());assert.ok(sql.includes(value.endsWith('2027')?'date:2027-10-31':'date:2026-10-31'),value);
  }
 }finally{await f.close();}
});
test('round7 long-list screening checks retained members and grouped windows, never unrelated overflow',async()=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});
 try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:1250}]);
  for(const count of [33,65,100])for(const [parts,privateTurn]of [
   [Array.from({length:count},(_,i)=>String(101+i)),false],
   [[...Array.from({length:count},(_,i)=>String(101+i)),'1250'],true],
   [[...Array.from({length:count},(_,i)=>String(101+i)),'1','250'],true],
  ]){
   const memory=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience:'owner',messageId:'r7-list-'+count+'-'+privateTurn+'-'+parts.length}});
   const before=wires.length,p=createPrivateChatProvider({message:'Find the smallest among '+parts.join(','),memory,options:{},providerFactory:factory(wires)});await p.generate();assert.equal(wires.length-before,privateTurn?0:1);
  }
 }finally{await f.close();}
});
