import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {fixture} from '../tests/fixtures/private-invoice.mjs';import {AIProvider} from '../ai/provider.mjs';import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
const evidence=[];test.after(()=>writeFile('work/r7-origin-sinks.json',JSON.stringify(evidence,null,2)));
test('fresh declaration classes retain private fields through terms, both audits and provider-memory guards',async t=>{
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'independent-r7-sinks',cfApiToken:'independent-r7-sinks',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});let n=0;
 const seed=async(sink,source,audience)=>{
  if(sink==='terms')await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:source}]);
  if(sink==='owner-audit')await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,$3,'whatsapp','user',$4)",[f.scope.workspaceId,f.scope.ownerId,'r7-sink-'+(++n),source]);
  if(sink==='customer-audit')await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,'user',$4)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,source]);
  if(sink==='provider-memory')await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')",[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience,'r7-sink-'+(++n),source]);
 };
 try{
  for(const [kind,source,followups]of [
   ['invoice-verb','I invoiced Alder Finch for 6847',['send 6847 today','Ask Alder for advice']],
   ['bill-verb','I billed Alder Finch 6847',['send 6847 today','Ask Alder for advice']],
   ['colon-prose','Invoice: Alder Finch for 6847',['send 6847 today','Ask Alder for advice']],
   ['compact-field-order','Invoice #AB-6847\nDate: 16 July 2027\nAlder Finch\nTotal 6847',['send 6847 today','Ask Alder for advice','Is it due 16 July 2027?']],
  ])for(const sink of ['terms','owner-audit','customer-audit','provider-memory'])for(const audience of ['owner','customer']){
   for(const table of ['owner_assistant_turns','whatsapp_conversation_turns','whatsapp_provider_memory','whatsapp_private_invoice_terms'])await f.db.query('delete from '+table+' where workspace_id=$1',[f.scope.workspaceId]);
   await seed(sink,source,audience);
   for(let i=0;i<followups.length;i++)await t.test(kind+'/'+sink+'/'+audience+'/'+followups[i],async()=>{
    if(i){await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);if(sink==='provider-memory')await seed(sink,source,audience);}
    f.restart();const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}}),input=followups[i],before=wires.length,result=audience==='owner'?await f.turn(input):await customer({...f.scope,message:input,messageId:'r7-sink-turn-'+(++n)}),terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term),row={kind,sink,audience,source,input,result,terms,wires:wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));
   });
  }
 }finally{await f.close();}
});
