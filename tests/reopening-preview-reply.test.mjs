import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {runOwnerAgent,ownerReplySafetyIssue} from '../automation/whatsapp/owner-agent.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope} from './fixtures/owner-chat-battery.mjs';

const facts={financialReopening:true,invoiceNumber:'INV-2026-0002',currency:'USD',reversalAmount:154.06,balanceAfter:154.06};
const requirement={requiredFacts:facts,confirmationText:'yes',requiresCancel:true,requiresReplyCue:true,maxLength:900};
const proposal={ok:true,proposal:true,requiresConfirmation:true,...facts,paymentHistoryPreserved:true,cashRefund:false};
const valid='Reopen INV-2026-0002 by reversing USD 154.06 and restoring the balance to USD 154.06? The original receipt stays in history. No refund is sent. Reminders will be paused after confirmation. Reply yes or cancel.';
const logger={info(){},warn(){},error(){}};

test('natural payment-history wording preserves the consequential facts without admitting negated preservation',()=>{
  for(const history of ['The original receipt stays in history.','Payment history remains untouched.','Original payments are not deleted.','Existing payment receipts are kept.'])
    assert.equal(ownerReplySafetyIssue(valid.replace('The original receipt stays in history.',history),requirement),null,history);
  for(const history of ['Original receipts are not preserved.','Original receipts are deleted.','Payments stay paid.'])
    assert.equal(ownerReplySafetyIssue(valid.replace('The original receipt stays in history.',history),requirement),'confirmation_payment_history',history);
  assert.equal(ownerReplySafetyIssue(valid.replaceAll('154.06',''),requirement),'confirmation_reversal_amount');
});

for(const repairSucceeds of [true,false])test(`serialized provider final repair ${repairSucceeds?'returns preview facts':'reports a saved preview honestly'} without applying the financial change`,async()=>{
  let calls=0,writes=0;
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger,
    fetchImpl:async(_url,init)=>{
      calls++;const wire=JSON.parse(init.body);
      if(calls>1)assert(wire.messages.some(row=>row.role==='system'&&row.content.includes('Describe the unexecuted reopening preview.')));
      const message=calls===1?{content:'',tool_calls:[{id:'preview',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:facts.invoiceNumber}],values:{status:'unpaid'}})}}]}:
        {content:calls===2||!repairSucceeds?'Reopen INV-2026-0002? Original receipts stay in history. No refund. Reminders will pause. Reply yes or cancel.':valid};
      return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message,finish_reason:'stop'}]})};
    }});
  const result=await runOwnerAgent({provider,message:'Mark INV-2026-0002 as unpaid.',tools:{
    definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],
    async execute(){writes++;return proposal;},getReplyRequirement:()=>requirement,getWriteAttempted:()=>writes>0,
  }});
  assert.equal(writes,1);assert.equal(calls,3);
  if(repairSucceeds){assert.equal(result.answer,valid);assert.equal(result.plannerFailure,undefined);}
  else {assert.match(result.answer,/preview was saved/i);assert.match(result.answer,/No proposed business change was applied/);assert.doesNotMatch(result.answer,/could not confirm whether/);}
});

test('fresh pending reopening reads restore exact preview requirements and cannot complete a reversal',async()=>{
  const db=createOwnerChatDatabase();
  const pending={id:15,version:1,action:{type:'owner_invoice_reopen',...facts,sourceMessageId:'original',paymentCount:1,expiresAt:'2026-10-05T00:00:00Z'}};
  const tool=createWorkspaceDataTool({supabase:db.supabase,scope,clock:()=>new Date('2026-10-04T12:00:00Z'),authorize:async()=>true,pendingAtStart:pending,messageId:'later',message:'review the pending action'});
  const before=structuredClone({invoices:db.tables.invoices,payments:db.tables.payments});
  const result=await tool.execute({operation:'pending'});
  assert.equal(result.requiresConfirmation,true);assert.equal(result.completed,undefined);
  assert.equal(tool.getReplyRequirement().requiredFacts.reversalAmount,154.06);
  assert.equal(ownerReplySafetyIssue(valid,tool.getReplyRequirement()),null);
  assert.equal(db.rpcCalls.length,0);assert.deepEqual({invoices:db.tables.invoices,payments:db.tables.payments},before);
});

