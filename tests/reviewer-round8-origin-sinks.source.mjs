import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {setup} from './r8-review-harness.mjs';
const evidence=[];test.after(()=>writeFile('work/r8-origin-sinks.json',JSON.stringify(evidence,null,2)));
test('declarations retain every party and amount across source sinks and reconstruction',async t=>{
 const f=await setup();let n=0;try{for(const [source,followups]of [
 ['I billed Alder Finch 6847, and Brook Rowan 2749',['send 2749 today','Ask Brook for advice']],
 ['I billed Alder Finch 6847. I billed Brook Rowan 2749',['send 2749 today','Ask Brook for advice']],
 ['Alder Finch owes me 6847',['send 6847 today','Ask Alder for advice']],
 ['Payment from Alder Finch: 6847',['send 6847 today','Ask Alder for advice']],
 ['I billed Alder Finch 6847',['send 6847 today','Ask Alder for advice']],
 ])for(const audience of ['owner','customer'])for(const sink of ['terms','owner-audit','customer-audit','provider-memory']){
await f.reset();const seed=async()=>{
if(sink==='terms')await f.retain({notes:source});
if(sink==='owner-audit')await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,$3,'whatsapp','user',$4)",[f.scope.workspaceId,f.scope.ownerId,'r8-origin-'+(++n),source]);
if(sink==='customer-audit')await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,'user',$4)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,source]);
if(sink==='provider-memory')await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')",[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience,'r8-origin-'+(++n),source]);
};await seed();
for(const input of followups)await t.test(audience+'/'+sink+'/'+source+'/'+input,async()=>{if(sink==='provider-memory')await seed();f.restart();const row={source,sink,terms:await f.terms(),...await f.turn(audience,input)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));});
 }}finally{await f.close();}
});
test('inverted general questions and generic billing do not poison ordinary vocabulary',async t=>{
 const f=await setup();try{for(const [source,followup]of [['Are invoices numbered sequentially?','Are chapters numbered sequentially?'],['My bills are confusing','Tell me why maps are confusing'],['I will invoice you later','See you later'],['Explain invoice number formats','Explain image formats']])for(const audience of ['owner','customer'])await t.test(audience+'/'+source,async()=>{
await f.reset();const first=await f.turn(audience,source);await f.clear();const row={source,first,terms:await f.terms(),...await f.turn(audience,followup)};evidence.push(row);assert.equal(row.wires.length,1,JSON.stringify(row));
 });}finally{await f.close();}
});
