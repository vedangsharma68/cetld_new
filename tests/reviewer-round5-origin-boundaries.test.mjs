// Independent reviewer specification. All assertions and test bodies preserved; only imports and evidence-file hook adapted.
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';import {AIProvider} from '../ai/provider.mjs';import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
const evidence=[];
async function setup(){const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'independent-origin-r5',cfApiToken:'independent-origin-r5',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'A safe ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});let customer,n=0;const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();return {...f,wires,restart,turn:(a,m)=>a==='owner'?f.turn(m):customer({...f.scope,message:m,messageId:'origin-r5-'+(++n)})};}
test('comma-separated party after the original quotation header retains formal components',async t=>{
 const f=await setup();try{
  const source='Here is the bill, Anurag Sharma, 1250, due 31 Oct 2026';
  for(const audience of ['owner','customer']){
   const before=f.wires.length;await f.turn(audience,source);assert.equal(f.wires.length,before);f.restart();const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term);
   for(const input of ['Ask Anurag for advice','Ask Sharma for advice'])await t.test(audience+'/'+input,async()=>{const start=f.wires.length,result=await f.turn(audience,input),row={kind:'comma-party-origin',audience,source,terms,input,result,wires:f.wires.slice(start)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row.wires.map(w=>w.body.messages)));});
   for(const input of ['Ask Anurag Sharma for advice','send 1250 today'])await t.test('control/'+audience+'/'+input,async()=>{const start=f.wires.length,result=await f.turn(audience,input);evidence.push({kind:'comma-party-control',audience,source,input,result,wires:f.wires.slice(start)});assert.equal(f.wires.length,start);});
  }
 }finally{await f.close();}
});
test('format characters before structured private input must not disable durable retention',async t=>{
 const f=await setup();try{
  let n=0;for(const audience of ['owner','customer'])for(const prefix of ['\u200b','\ufeff','\u0085','\u00a0']){
   const amount=8271+(n++),source=prefix+JSON.stringify({invoice:{customer_name:'Format Canopy '+n,total:amount,due_date:'2027-08-26'}}),before=f.wires.length;await f.turn(audience,source);assert.equal(f.wires.length,before,'Private source remains local');f.restart();
   const origin=(await f.db.query('select app.private_invoice_has_origin($1) ok',[source])).rows[0].ok,terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term),input='send '+amount+' today',start=f.wires.length,result=await f.turn(audience,input),row={kind:'structured-prefix',audience,prefixCodepoint:prefix.codePointAt(0).toString(16),source,origin,terms,input,result,wires:f.wires.slice(start)};evidence.push(row);
   await t.test(audience+'/'+row.prefixCodepoint,()=>assert.equal(row.wires.length,0,JSON.stringify(row.wires.map(w=>w.body.messages))));
  }
 }finally{await f.close();}
});
