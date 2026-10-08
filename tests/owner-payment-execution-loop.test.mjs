import test from 'node:test';
import assert from 'node:assert/strict';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {requestedOwnerPayment} from '../automation/whatsapp/owner-payment-intent.mjs';
const message='Record a USD 500 test payment against invoice SB-10442 for Northwind Systems LLC. This is only a dummy bookkeeping entry. Keep customer messages and reminders off.';
const call=(args,id)=>({id,type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}});
const read={operation:'read',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'SB-10442'}]};
const definition={type:'function',function:{name:'workspaceData',parameters:{type:'object'}}};
const evidence={ok:true,readOnly:true,operation:'read',table:'invoices',lookupInvoiceNumber:'SB-10442',rows:[{invoice_number:'INV-2026-6769',currency:'USD',total_amount:951.52,amount_paid:0}],truncated:false};
test('payment current intent ignores quoted, historical, question and ambiguous authority',()=>{
 assert.deepEqual(requestedOwnerPayment(message),{amount:500,currency:'USD',invoiceNumber:'SB-10442',customerName:'Northwind Systems LLC'});
 for(const text of ['He said "'+message+'"','Do not '+message,'Can I '+message,'Yesterday I '+message,message+' Instead pay USD 600.',message.replace('USD 500','USD 500 or EUR 500')])assert.equal(requestedOwnerPayment(text),null,text);
});
test('one cached-read model opportunity respects caps and attempted-write uncertainty',async()=>{
 for(const attempted of [false,true]){
  let executions=0;const requests=[];
  const result=await runOwnerAgent({message,tools:{definitions:[definition],execute:async()=>{executions++;return {...evidence,...(attempted?{writeAttempted:true}:{})};}},provider:{async generate(request){requests.push(request);return request.tools?{toolCalls:[call(read,'read-'+requests.length)]}:{content:'No changes were made.'};}}});
  assert.equal(executions,1);assert.deepEqual(requests.map(r=>Boolean(r.tools)),attempted?[true,false]:[true,true,true,false]);
  assert.equal(result.agentDiagnostics.toolRounds,attempted?1:3);
 }
});
test('truncated or absent fresh target proof cannot extend read finalization',async()=>{
 for(const invalid of [{rows:[]},{truncated:true},{lookupInvoiceNumber:'OTHER'}]){
  let requests=0;const flags=[];
  await runOwnerAgent({message,tools:{definitions:[definition],execute:async()=>({...evidence,...invalid})},provider:{async generate(request){flags.push(Boolean(request.tools));requests++;return request.tools?{toolCalls:[call(read,'read-'+requests)]}:{content:'No changes were made.'};}}});
  assert.deepEqual(flags,[true,true,false]);
 }
});
test('recovery checkpoint and native model history do not grant a second operation opportunity',async()=>{
 let checkpoint,calls=0,executions=0;
 const tools={definitions:[definition],execute:async()=>{executions++;return evidence;}};
 const first=await runOwnerAgent({message,tools,allowDeferred:true,budgetMs:100,onCheckpoint:async value=>{checkpoint=structuredClone(value);},provider:{async generate(){calls++;if(calls===3)return new Promise(()=>{});return {toolCalls:[call(read,'read-'+calls)],googleParts:[{functionCall:{name:'workspaceData',args:read},thoughtSignature:'c2ln'}]};}}});
 assert.equal(first.deferred,true);assert.equal(checkpoint.actionReadRecoveryUsed,true);assert.ok(checkpoint.transcript.some(row=>row.googleParts));
 const flags=[];calls=0;await runOwnerAgent({message,tools,allowDeferred:true,checkpoint,provider:{async generate(request){flags.push(Boolean(request.tools));return request.tools?{toolCalls:[call(read,'resume-'+(++calls))]}:{content:'No changes were made.'};}}});
 assert.deepEqual(flags,[true,true,false]);assert.equal(executions,1);
});
