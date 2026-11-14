import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
import {fixture} from '../tests/fixtures/private-invoice.mjs';import {AIProvider} from '../ai/provider.mjs';import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
const evidence=[];test.after(()=>writeFile('work/r7-independent-regressions.json',JSON.stringify(evidence,null,2)));
async function setup(){
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'independent-r7-regressions',cfApiToken:'independent-r7-regressions',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});let customer,n=0;
 const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 const turn=async(a,message)=>{const r=a==='owner'?await f.turn(message):await customer({...f.scope,message,messageId:'r7-independent-'+(++n)});return r?.answer??r;};
 const clearMemory=async()=>{await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);restart();};
 const reset=async()=>{for(const table of ['owner_assistant_turns','whatsapp_conversation_turns','whatsapp_provider_memory','whatsapp_private_invoice_terms'])await f.db.query('delete from '+table+' where workspace_id=$1',[f.scope.workspaceId]);restart();};
 return {...f,wires,turn,restart,clearMemory,reset,terms:async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term)};
}
test('round7 enumeration punctuation and introductory syntax protect known members while preserving different decimals',async t=>{
 const f=await setup();try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:1250}]);
  for(const audience of ['owner','customer'])for(const [input,privateTurn]of [
   ['The amounts = 1250,77',true],['The amounts are (1250,77)',true],['The amounts — 1250,77',true],['The amounts are [1250,77]',true],['The amounts are respectively 1250,77',true],['Choose from 1250,77',true],['Choose one: 1250,77',true],['The amounts = 77,1250',true],['The amounts: 1250,77',true],['The amounts are: 1250,77',true],['The amounts = 77,2500',false],['Put 1250,77 on the shopping list',false],
  ])await t.test(audience+'/'+input,async()=>{await f.clearMemory();const before=f.wires.length,result=await f.turn(audience,input),row={kind:'enumeration',audience,input,privateTurn,result,terms:await f.terms(),wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,privateTurn?0:1,JSON.stringify(row));});
 }finally{await f.close();}
});
test('round7 formal name references accept ordinary verb, complement and possessive contexts without blocking vehicles',async t=>{
 const f=await setup();try{
  for(const [stored,inputs]of [
   ['Van Harper',[["Ask Van if he is free",true],['Call Van now',true],['Van called me',true],['I spoke to Van recently',true],["Van's suggestion helped",true],['Ask Van for advice',true],['Van is coming tomorrow',true],['Travel by van',false],['We travel by van today',false],['We use a delivery van',false],['I hired a blue van today',false],['I bought a van today',false]]],
   ['An Harper',[['Ask An for advice',true],['An called me',true],['An is coming tomorrow',true],['I met An yesterday',true],['An apple is tasty',false],['Ask an expert for advice',false]]],
  ]){
   await f.reset();const c=(await f.db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[f.scope.workspaceId,stored])).rows[0];const inv=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,$3,43,'INR','draft') returning id",[f.scope.workspaceId,c.id,'R7-'+stored])).rows[0];
   for(const audience of ['owner','customer'])for(const [input,privateTurn]of inputs)await t.test(audience+'/'+stored+'/'+input,async()=>{await f.clearMemory();const before=f.wires.length,result=await f.turn(audience,input),row={kind:'formal-name',audience,stored,input,privateTurn,result,terms:await f.terms(),wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,privateTurn?0:1,JSON.stringify(row));});
   await f.db.query('delete from invoices where id=$1',[inv.id]);
  }
 }finally{await f.close();}
});
test('round7 declarative prose and compact field ordering retain every supplied private field across restart',async t=>{
 const f=await setup();try{
  for(const [style,source,followups]of [
   ['invoice-verb','I invoiced Alder Finch for 6847',['send 6847 today','Ask Alder for advice']],
   ['bill-verb','I billed Alder Finch 6847',['send 6847 today','Ask Alder for advice']],
   ['party-before-document','I sent Alder Finch an invoice for 6847',['send 6847 today','Ask Alder for advice']],
   ['amount-after-colon','Invoice: 6847 for Alder Finch',['send 6847 today','Ask Alder for advice']],
   ['party-after-colon','Invoice: Alder Finch for 6847',['send 6847 today','Ask Alder for advice']],
   ['date-before-party','Invoice #AB-6847\nDate: 16 July 2027\nAlder Finch\nTotal 6847',['send 6847 today','Ask Alder for advice','Is it due 16 July 2027?']],
   ['repaired-record-control','Invoice #AB-6847\nAlder Finch\nTotal 6847\nDue 16 July 2027',['send 6847 today','Ask Alder for advice','Is it due 16 July 2027?']],
  ])for(const audience of ['owner','customer']){
   await f.reset();const before=f.wires.length,result=await f.turn(audience,source),sourceRow={kind:'origin-source',style,audience,source,result,terms:await f.terms(),wires:f.wires.slice(before)};evidence.push(sourceRow);await t.test(audience+'/'+style+'/source',()=>assert.equal(sourceRow.wires.length,0,JSON.stringify(sourceRow)));
   f.restart();for(const input of followups)await t.test(audience+'/'+style+'/'+input,async()=>{await f.clearMemory();const start=f.wires.length,result=await f.turn(audience,input),row={kind:'origin-followup',style,audience,source,input,result,terms:await f.terms(),wires:f.wires.slice(start)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));});
  }
 }finally{await f.close();}
});
