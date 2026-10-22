import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

const scope={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',phone:'+12025550107'};
const target=[{column:'invoice_number',operator:'eq',value:'QA-REPRO-001'}];
const message='send him a reminder to pay';
const supabase={from(){throw Error('No database access before dispatch');}};

test('reminder transport decodes one nested array without changing its target or invoking a planner',async()=>{
  for(const operation of ['sendReminderNow','previewReminder'])for(const column of ['invoice_number','customer_name','id']){
    const filters=[{column,operator:'eq',value:column==='id'?'cccccccc-cccc-4ccc-8ccc-cccccccccccc':column==='customer_name'?'QA Repro Customer':'QA-REPRO-001'}];
    for(const encoded of [filters,JSON.stringify(filters)]){
      let dispatched=0;
      const tool=createWorkspaceDataTool({supabase,scope,message,authorize:async()=>true,
        planRequest:async()=>{throw Error('No model replan');},executeReminderOperation:async params=>{
          dispatched++;assert.deepEqual(params.filters,filters);assert.equal(params.operation,operation);
          return {ok:false,code:'missing_contact',message:'A usable customer phone is required.'};
        }});
      const result=await tool.execute({operation,table:'invoices',filters:encoded});
      assert.equal(result.code,'missing_contact');assert.equal(dispatched,1);
    }
  }
});

test('malformed or multiple reminder targets stop before dispatch and ask for one invoice',async()=>{
  const invalid=[JSON.stringify([...target,...target]),JSON.stringify([]),JSON.stringify({invoice_number:'QA-REPRO-001'}),
    JSON.stringify(JSON.stringify(target)),'[invalid',
    JSON.stringify([{...target[0],operator:'ilike'}]),JSON.stringify([{...target[0],column:'status'}]),
    JSON.stringify([{...target[0],value:''}]),JSON.stringify([{...target[0],value:'x'.repeat(101)}]),
    JSON.stringify([{...target[0],unexpected:'value'}])];
  for(const operation of ['sendReminderNow','previewReminder'])for(const filters of invalid){
    let calls=0;
    const tool=createWorkspaceDataTool({supabase,scope,message,authorize:async()=>true,
      planRequest:async()=>{throw Error('No replan may choose a target');},executeReminderOperation:async()=>{throw Error('No dispatch');}});
    const reply=await runOwnerAgent({message,tools:{definitions:[tool.definition],execute:(_name,args)=>tool.execute(args),getWriteAttempted:tool.getWriteAttempted},
      provider:{async generate(){calls++;assert.equal(calls,1,'No reply-repair loop');return {toolCalls:[{id:'reminder',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation,table:'invoices',filters})}}]};}}});
    assert.equal(calls,1,JSON.stringify({filters,reply}));assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));
    assert.match(reply.answer,/identify one invoice.*Send its invoice number/);assert.match(reply.answer,/Nothing was approved or queued/);
  }
});

test('encoded reminder filters retain authorization, scope and operation checks',async()=>{
  let dispatched=0;
  const make=authorize=>createWorkspaceDataTool({supabase,scope,message,authorize,executeReminderOperation:async()=>{dispatched++;return {ok:true};}});
  assert.equal((await make(async()=>false).execute({operation:'sendReminderNow',table:'invoices',filters:JSON.stringify(target)})).code,'DENIED');
  for(const args of [{operation:'sendReminderNow',table:'customers'},{operation:'confirm',table:'invoices'},
    {operation:'sendReminderNow',table:'invoices',values:{workspace_id:scope.workspaceId}}]){
    assert.equal((await make(async()=>true).execute({...args,filters:JSON.stringify(target)})).ok,false);
  }
  for(const filters of [JSON.stringify([{...target[0],workspace_id:scope.workspaceId}]),JSON.stringify([{...target[0],value:scope.workspaceId}])])
    assert.equal((await make(async()=>true).execute({operation:'sendReminderNow',table:'invoices',filters})).ok,false);
  assert.equal((await make(async()=>true).execute({operation:'sendReminderNow',table:'invoices',filters:' '.repeat(8193)})).ok,false);
  assert.equal(dispatched,0);
});
