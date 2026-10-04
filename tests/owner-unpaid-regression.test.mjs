import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope,DEFAULT_NOW,JOHN_INVOICE_ID} from './fixtures/owner-chat-battery.mjs';
import {CF_PRIMARY_MODEL} from '../ai/provider.mjs';

const request=(filters=[{column:'customer_name',operator:'eq',value:'JohnSmith'}])=>({operation:'update',table:'invoices',filters,values:{status:'unpaid'}});
function isolatedDatabase({paid=false,ambiguous=false}={}){
 const db=createOwnerChatDatabase();
 db.tables.invoices=db.tables.invoices.filter(row=>row.workspace_id!==scope.workspaceId||row.id===JOHN_INVOICE_ID);
 const invoice=db.tables.invoices.find(row=>row.id===JOHN_INVOICE_ID);
 if(paid){invoice.status='paid';invoice.amount_paid=invoice.total_amount;db.tables.payments.push({id:'aaaaaaaa-1111-4111-8111-111111111111',workspace_id:scope.workspaceId,invoice_id:invoice.id,amount:invoice.total_amount});}
 if(ambiguous)db.tables.invoices.push({...invoice,id:'ffffffff-ffff-4fff-8fff-fffffffffff9',invoice_number:'INV-009'});
 return db;
}

test('customer-name unpaid checks reach payment facts, without any ledger or proposal mutation',async()=>{
 for(const paid of [false,true]){
  const db=isolatedDatabase({paid}),before=structuredClone(db.tables.invoices);
  const tool=createWorkspaceDataTool({supabase:db.supabase,scope,authorize:async()=>true,message:'mark the invoice as unpaid'});
  const result=await tool.execute(request());
  assert.equal(result.ok,!paid);assert.equal(paid?result.code:result.alreadyUnpaid,paid?'PAYMENT_GUARD':true);
  assert.equal(result.requiresConfirmation,paid?undefined:false);assert.notEqual(result.completed,true);
  assert.equal(db.rpcCalls.length,0);assert.deepEqual(db.tables.invoices,before);db.assertScopedReads();
 }
 const db=isolatedDatabase({ambiguous:true});
 const result=await createWorkspaceDataTool({supabase:db.supabase,scope,authorize:async()=>true}).execute(request());
 assert.equal(result.code,'AMBIGUOUS');assert.equal(db.rpcCalls.length,0);
});

test('missing target and unsupported fields return specific model-facing validation reasons',async()=>{
 const db=isolatedDatabase(),tool=createWorkspaceDataTool({supabase:db.supabase,scope,authorize:async()=>true});
 const missing=await tool.execute(request([]));assert.equal(missing.validationCode,'TARGET_REQUIRED');assert.match(missing.message,/Which invoice/);
 const fields=await tool.execute({...request(),values:{payment_status:'unpaid'}});assert.equal(fields.validationCode,'INVALID_FIELDS');assert.match(fields.message,/never removes recorded payments/);
 assert(fields.catalog.tables.invoices.writeValueConstraints.update.status.includes('unpaid'));assert.equal(db.readCalls.length,0);
});

test('post-release unpaid, explanation and model question remain separate durable turns',async()=>{
 const db=isolatedDatabase({paid:true}),before=structuredClone({invoices:db.tables.invoices,payments:db.tables.payments});let calls=0;
 db.tables.whatsapp_messages.push({id:'old-failure',workspace_id:scope.workspaceId,phone:scope.phone,audience:'owner',direction:'outbound',kind:'normal',status:'delivered',created_at:DEFAULT_NOW.toISOString(),body:"I couldn't mark John Smith's invoice as unpaid because the operation failed due to invalid input."});
 const handler=createOwnerMessageHandler({supabase:db.supabase,authorize:async()=>true,env:{},clock:()=>DEFAULT_NOW,logger:{info(){},warn(){},error(){}},
  providerFactory:()=>({async generate({messages}){
   calls++;const latest=[...messages].reverse().find(row=>row.role==='user').content;
   // Reproduce a model attempting the old write again for the explanation.
   return {model:CF_PRIMARY_MODEL,content:'',toolCalls:[{id:'call-'+calls,type:'function',function:{name:latest==='which model are you using'?'getAIProviderConfiguration':'workspaceData',arguments:JSON.stringify(latest==='which model are you using'?{}:request())}}]};
  },async generateStructured(){throw Error('No extra planner or provider calls expected');}})});
 const answers=[];
 for(const [index,message] of ['mark the invoice as unpaid','what invalid input??','which model are you using'].entries()){
  const messageId='isolated-regression-'+index;
  db.tables.whatsapp_messages.push({id:'in-'+index,workspace_id:scope.workspaceId,phone:scope.phone,audience:'owner',direction:'inbound',kind:'text',status:'received',created_at:DEFAULT_NOW.toISOString(),provider_message_id:messageId,body:message});
  const result=await handler({...scope,message,messageId});answers.push(result.answer);assert.equal(result.plannerFailure,undefined);
  assert.equal((await handler({...scope,message,messageId})).answer,result.answer,'duplicate webhook must replay its own receipt');
 }
 assert.match(answers[0],/payments.*cannot erase payment history/i);assert.doesNotMatch(answers[0],/invalid input|confirmation/i);
 assert.match(answers[1],/explanation.*did not retry/i);assert.doesNotMatch(answers[1],/couldn't mark/i);
 assert.match(answers[2],new RegExp(CF_PRIMARY_MODEL.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.doesNotMatch(answers[2],/invoice|unpaid|confirm/i);
 assert.equal(calls,3);assert.deepEqual({invoices:db.tables.invoices,payments:db.tables.payments},before);
 assert.equal(db.tables.whatsapp_pending_actions.filter(row=>!row.consumed_at).length,0);db.assertScopedReads();
});
