import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
import {setup} from './fixtures/reviewer-round8-harness.mjs';
const evidence=[];test.after(()=>writeFile('work/r10-class-evidence.json',JSON.stringify(evidence,null,2)));
const seed=async(f,sink,source,audience,id)=>{
 if(sink==='notes')await f.retain({notes:source});
 if(sink==='owner-audit')await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,$3,'whatsapp','user',$4)",[f.scope.workspaceId,f.scope.ownerId,id,source]);
 if(sink==='customer-audit')await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,'user',$4)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,source]);
 if(sink==='provider-memory')await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')",[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience,id,source]);
 if(sink==='turn')return f.turn(audience,source);
};
test('R10 capture: span cardinality, every participant and supplied scoped payment facts survive reconstruction',async t=>{
 const f=await setup();let n=0;try{
  await f.retain({total:1250});for(const audience of ['owner','customer'])await t.test('R10.1/distributive/'+audience,async()=>{await f.clear();const row=await f.turn(audience,'Pay 1250,77 respectively');evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));});
  for(const sink of ['turn','notes'])for(const audience of ['owner','customer'])await t.test('R10.1/cardinality/'+sink+'/'+audience,async()=>{
   await f.reset();const source='Invoice: amounts 1250,77',first=await seed(f,sink,source,audience,'r10-'+(++n));await f.clear();const terms=await f.terms(),followups=[];for(const value of [1250,77]){const row=await f.turn(audience,'send '+value+' today');followups.push(row);assert.equal(row.wires.length,0,JSON.stringify({terms,row}));}evidence.push({kind:'capture-enumeration',source,sink,audience,first,terms,followups});
  });
  for(const separator of [', ','; ','\n'])for(const sink of ['turn','notes','owner-audit','customer-audit','provider-memory'])for(const audience of ['owner','customer'])await t.test('R10.4/'+JSON.stringify(separator)+'/'+sink+'/'+audience,async()=>{
   await f.reset();const source='I billed Alder Finch 6847'+separator+'Brook Rowan 2749',first=await seed(f,sink,source,audience,'r10-'+(++n));f.restart();const terms=await f.terms(),followups=[];for(const input of ['Ask Brook for advice','send 2749 today','send 6847 today']){await f.clear();const row=await f.turn(audience,input);followups.push(row);assert.equal(row.wires.length,0,JSON.stringify({source,sink,terms,row}));}evidence.push({kind:'capture-participants',source,sink,audience,first,terms,followups});
  });
  await f.db.query("update customers set name='Alder Finch' where id=$1",[f.scope.customerId]);await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R10-SCOPED-PAYMENT',9000,'INR','draft')",[f.scope.workspaceId,f.scope.customerId]);
  for(const audience of ['owner','customer'])await t.test('R10.5/scoped/'+audience,async()=>{await f.reset();await f.db.query('select app.retain_private_ledger_document(to_jsonb(i)) from invoices i where workspace_id=$1',[f.scope.workspaceId]);const source='I paid Alder Finch 6847',first=await f.turn(audience,source);assert.equal(first.wires.length,0);await f.clear();const terms=await f.terms(),row=await f.turn(audience,'send 6847 today');evidence.push({kind:'scoped-payment',source,audience,scope:f.scope,storedInvoice:9000,first,terms,row});assert.equal(row.wires.length,0,JSON.stringify({terms,row}));});
 }finally{await f.close();}
});
test('R10 matching: nominal references and rational quantities stay private',async t=>{
 const f=await setup();try{await f.retain({total:1250,partyNames:['An Harper','Van Harper','May Harper','김']});
  for(const audience of ['owner','customer'])for(const input of ['An and I went hiking','Van, my friend, called me','How did May respond?','김님에게 연락해줘','send 1 1/4 thousand today'])await t.test(audience+'/'+input,async()=>{await f.clear();const row=await f.turn(audience,input);evidence.push({kind:'matching',...row});assert.equal(row.wires.length,0,JSON.stringify(row));});
 }finally{await f.close();}
});
test('R10 false blocks: lexical words retain ordinary meaning alongside registered identities',async t=>{
 const f=await setup();try{await f.retain({partyNames:['राम','Rose']});
  for(const audience of ['owner','customer'])for(const [input,privateTurn]of [['आराम करो',false],['आराम करना जरूरी है',false],['Prices rose yesterday',false],['A red rose bloomed',false],['Ask राम for advice',true],['Ask Rose for advice',true],['Rose called me',true]])await t.test(audience+'/'+input,async()=>{await f.clear();const row=await f.turn(audience,input);evidence.push({kind:'lexical-role',privateTurn,...row});assert.equal(row.wires.length,privateTurn?0:1,JSON.stringify(row));});
 }finally{await f.close();}
});
test('R10 routing: a proper person is not evidence of an invoice request',async t=>{
 const f=await setup();try{
  for(const audience of ['owner','customer'])for(const [input,privateTurn]of [['Is Bill a scientist?',false],['Tell me about Bill.',false],['Explain photosynthesis',false],['balance',true]])await t.test(audience+'/'+input,async()=>{await f.clear();const row=await f.turn(audience,input);evidence.push({kind:'routing',privateTurn,...row});assert.equal(row.wires.length,privateTurn?0:1,JSON.stringify(row));});
 }finally{await f.close();}
});
