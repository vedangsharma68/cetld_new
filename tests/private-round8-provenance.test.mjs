import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixture} from '../tests/fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
const evidence=[];
await mkdir('work',{recursive:true});
test.after(()=>writeFile('work/r8-origin-class-regressions.json',JSON.stringify(evidence,null,2)));
async function setup(){
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'local-origin-class',cfApiToken:'local-origin-class',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');wires.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});let customer,n=0;
 const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 const reset=async()=>{for(const table of ['owner_assistant_turns','whatsapp_conversation_turns','whatsapp_provider_memory','whatsapp_private_invoice_terms'])await f.db.query('delete from '+table+' where workspace_id=$1',[f.scope.workspaceId]);restart();};
 return {...f,wires,restart,reset,turn:(audience,message)=>audience==='owner'?f.turn(message):customer({...f.scope,message,messageId:'own-origin-'+(++n)}),terms:async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term)};
}
const record='Invoice AB-49173\nHarbor Rowan\nTotal 49173\nDue 12 March 2028';
const declarations=[record,'Tell me a joke; '+record,'Tell me a joke.\n'+record,'I invoice Harbor Rowan for 49173','We will invoice Harbor Rowan for 49173','She invoices Harbor Rowan for 49173',"I'm invoicing Harbor Rowan for 49173",'They are billing Harbor Rowan 49173','North Studio is invoicing Harbor Rowan for 49173','The studio will invoice Harbor Rowan for 49173','North Studio invoices Harbor Rowan for 49173','李王 is invoicing Harbor Rowan for 49173','Van is billing Harbor Rowan for 49173','I am sending Harbor Rowan an invoice for 49173','We will send Harbor Rowan an invoice for 49173','I send Harbor Rowan invoice AB-49173 for 49173','I billed Dr. Harbor Rowan 49173','I sent Dr. Harbor Rowan an invoice for 49173','Invoice AB-49173\nDr. Harbor Rowan\nTotal 49173'];
test('document identities and finite billing predicates retain their role-bound fields before routing and through reconstruction',async t=>{
 const f=await setup();try{for(const audience of ['owner','customer'])for(const source of declarations)await t.test(audience+'/'+source.split('\n')[0],async()=>{
  await f.reset();const before=f.wires.length,first=await f.turn(audience,source),sourceWires=f.wires.slice(before);f.restart();const terms=await f.terms(),follow=[];
  for(const input of ['send 49173 today','Ask Harbor for advice',...(source.includes('North Studio')?['Ask North for advice']:[])]){const start=f.wires.length,result=await f.turn(audience,input);follow.push({input,result,wires:f.wires.slice(start)});}
  const row={audience,source,first,sourceWires,terms,follow};evidence.push(row);
  assert.ok(sourceWires.every(w=>!JSON.stringify(w.messages).includes('49173')&&!JSON.stringify(w.messages).includes('Harbor')),JSON.stringify(row));
  assert.ok(terms.includes('number:49173'),JSON.stringify(row));assert.ok(terms.includes('party:harbor'),JSON.stringify(row));
  assert.ok(follow.every(r=>r.wires.length===0),JSON.stringify(row));assert.equal(await f.count(),0);
 });}finally{await f.close();}
});
test('new declarations close all durable origin sinks for both audiences',async t=>{
 const f=await setup();let sequence=0;try{for(const source of [record,'I am invoicing Harbor Rowan for 49173'])for(const sink of ['terms','owner-audit','customer-audit','provider-memory'])for(const audience of ['owner','customer'])await t.test(audience+'/'+sink+'/'+source.split('\n')[0],async()=>{
  await f.reset();
  if(sink==='terms')await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:source}]);
  if(sink==='owner-audit')await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,$3,'whatsapp','user',$4)",[f.scope.workspaceId,f.scope.ownerId,'own-origin-'+(++sequence),source]);
  if(sink==='customer-audit')await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,'user',$4)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,source]);
  if(sink==='provider-memory')await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')",[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience,'own-origin-'+(++sequence),source]);
  f.restart();const before=f.wires.length,result=await f.turn(audience,'send 49173 today'),row={source,sink,audience,result,terms:await f.terms(),wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));
 });}finally{await f.close();}
});
test('domain questions and generic billing language do not create unscoped ordinary-word aliases',async t=>{
 const f=await setup();try{for(const audience of ['owner','customer'])for(const source of ['Explain invoice number formats','Explain invoice 2026 numbering formats','Tell me about invoicing formats','How does billing work?','What is invoicing software?','Explain what is invoicing software','I invoice customers monthly'])await t.test(audience+'/'+source,async()=>{
  await f.reset();await f.turn(audience,source);f.restart();const terms=await f.terms(),follow=[];
  for(const input of ['Explain image formats','Draft a birthday message','Travel by van','今天谈谈天气','Tell me about monthly planning']){const before=f.wires.length,result=await f.turn(audience,input);follow.push({input,result,wires:f.wires.slice(before)});}
  evidence.push({audience,source,terms,follow});if(source!=='I invoice customers monthly')assert.equal(terms.length,0,JSON.stringify({source,terms}));assert.ok(!terms.includes('party:formats'));assert.ok(!terms.includes('party:monthly'));assert.ok(follow.every(r=>r.wires.length===1),JSON.stringify({source,terms,follow}));
 });}finally{await f.close();}
});
