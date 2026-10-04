import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {CF_QWEN_MODEL, CF_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL} from '../ai/provider.mjs';

const workspaceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherWorkspace='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const customerId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope={workspaceId,ownerId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',phone:'+919871367051',customerId:'owner-placeholder'};
function database() {
  const reads=[];
  const tables={
    workspace_settings:[{workspace_id:workspaceId,owner_bot_preferences:{confirmationMode:'buttons'}}],
    workspace_ai_settings:[{workspace_id:workspaceId,primary_model:CF_QWEN_MODEL,fallback_model:GEMINI_FALLBACK_MODEL}],
    customers:[{workspace_id:workspaceId,id:customerId,name:'John Smith',company_name:'John Smith'},
      {workspace_id:otherWorkspace,id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',name:'John Other Business'}],
    invoices:[{workspace_id:workspaceId,id:'ffffffff-ffff-4fff-8fff-ffffffffffff',invoice_number:'INV-JOHN-1',customer_id:customerId,total_amount:120,amount_paid:0,currency:'USD',status:'sent',deleted_at:null},
      {workspace_id:otherWorkspace,id:'99999999-9999-4999-8999-999999999999',invoice_number:'OTHER-BUSINESS-SECRET',customer_id:customerId,total_amount:9999,currency:'USD',status:'sent',deleted_at:null}],
  };
  return {reads,tables,from(table){
    const filters=[];let columns='*',limit=100;
    const actualValue=(row,column)=>column==='customer.name'
      ?tables.customers.find(customer=>customer.workspace_id===row.workspace_id&&customer.id===row.customer_id)?.name:row[column];
    const q={select(value){columns=value;return q;},eq(column,value){filters.push(row=>actualValue(row,column)===value);reads.push({table,column,value});return q;},
      is(column,value){filters.push(row=>(row[column]??null)===value);return q;},in(column,value){filters.push(row=>value.includes(row[column]));return q;},
      ilike(column,value){const needle=value.replaceAll('%','').toLowerCase();filters.push(row=>String(actualValue(row,column)||'').toLowerCase().includes(needle));return q;},
      order(){return q;},limit(value){limit=value;return q;},
      maybeSingle:async()=>({data:result()[0]||null}),then(resolve,reject){return Promise.resolve({data:result()}).then(resolve,reject);}};
    function result(){return (tables[table]||[]).filter(row=>filters.every(filter=>filter(row))).slice(0,limit).map(row=>{
      if(columns==='*')return {...row};
      const output={};
      for(const column of columns.split(',')){
        if(column.startsWith('customer:customers!')){
          const customer=tables.customers.find(item=>item.workspace_id===row.workspace_id&&item.id===row.customer_id);
          output.customer=customer?{name:customer.name}:null;
        } else output[column]=row[column];
      }
      return output;
    });}
    return q;
  },rpc:async()=>({data:{ok:false,code:'FEATURE_UNAVAILABLE'}})};
}
const pendingFactory=()=>({loadPendingAction:async()=>null,loadPendingActionState:async()=>({generation:0,id:null,version:null,action:null})});
const call=args=>({id:'workspace-call',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}});
function handler(db,provider,history=[]) {
  return createOwnerMessageHandler({supabase:db,authorize:async()=>true,pendingActionStoreFactory:pendingFactory,
    ownerStoreFactory:()=>({query:async()=>[]}),historyReader:async()=>history,providerFactory:()=>provider,logger:{error(){}}});
}

test('default owner handler exposes compact workspace and configuration tools and answers meta in one tool round',async()=>{
  const db=database();let calls=0;
  const h=handler(db,{async generate({tools,messages}){
    calls++;if(tools){assert.deepEqual(tools.map(tool=>tool.function.name),['getAIProviderConfiguration','workspaceData']);assert.ok(JSON.stringify(tools).length<2600);}
    const results=messages.filter(message=>message.role==='tool');
    if(!results.length)return {model:CF_QWEN_MODEL,toolCalls:[{id:'config-call',type:'function',function:{name:'getAIProviderConfiguration',arguments:'{}'}}]};
    assert.equal(tools,undefined);
    const runtime=JSON.parse(results.at(-1).content);
    assert.ok(JSON.stringify(runtime).includes(CF_QWEN_MODEL));
    assert.ok(JSON.stringify(runtime).includes(GEMINI_FALLBACK_MODEL));
    return {model:CF_QWEN_MODEL,content:`Your primary model is ${CF_QWEN_MODEL}. Your fallback is ${GEMINI_FALLBACK_MODEL}.`};
  }});
  const result=await h({...scope,message:'Which model are you using?',messageId:'meta-1'});
  assert.equal(calls,1);assert.match(result.answer,/qwen3/);assert.ok(result.answer.includes(GEMINI_FALLBACK_MODEL));assert.doesNotMatch(result.answer,/invoice|OTHER-BUSINESS/);
  assert.equal(result.agentDiagnostics.toolRounds,1);
});

test('natural-language workspaceData reads real fixture invoices and preserves John across later turns',async()=>{
  const db=database();const history=[{role:'user',content:'John Smith is my customer'},
    {role:'assistant',content:'Got it. John Smith.'},{role:'user',content:'Thanks'},
    {role:'assistant',content:'You are welcome.'},{role:'user',content:'What can you help with?'},{role:'assistant',content:'Your workspace records.'}];
  let planned=0;
  const h=handler(db,{async generateStructured({messages}){
    planned++;assert.equal(messages.at(-1).content,'Tell me about his invoices');
    assert.match(messages.at(-2).content,/Find John's customer record/);
    assert(messages.some(row=>row.role==='user'&&row.content==='John Smith is my customer'));
    return {data:{operation:'read',table:'customers',columns:['name'],filters:[{column:'name',operator:'ilike',value:'%John%'}]}};
  },async generate({tools,messages}){
    if(tools)assert.deepEqual(tools.map(tool=>tool.function.name),['getAIProviderConfiguration','workspaceData']);
    assert.ok(messages.some(message=>message.content==='John Smith is my customer'));
    const results=messages.filter(message=>message.role==='tool');
    if(!results.length)return {model:CF_QWEN_MODEL,toolCalls:[call({request:"Find John's customer record"})]};
    if(results.length===1){assert.ok(results[0].content.includes('John Smith'));assert.ok(!results[0].content.includes(otherWorkspace));
      return {model:CF_QWEN_MODEL,toolCalls:[call({operation:'read',table:'invoices',columns:['invoice_number','total_amount','currency','status'],filters:[{column:'customer_name',operator:'eq',value:'John Smith'}]})]};}
    assert.ok(results[1].content.includes('INV-JOHN-1'));assert.ok(!results[1].content.includes('OTHER-BUSINESS-SECRET'));
    return {model:CF_QWEN_MODEL,content:'John has invoice INV-JOHN-1 for USD 120. Its status is sent.'};
  }},history);
  const result=await h({...scope,message:'Tell me about his invoices',messageId:'john-4'});
  assert.equal(planned,1);assert.match(result.answer,/INV-JOHN-1/);
  for(const table of ['customers','invoices'])assert.ok(db.reads.some(read=>read.table===table&&read.column==='workspace_id'&&read.value===workspaceId));
});

test('provider failure returns an honest owner reply without exposing error text or another model call',async()=>{
  let calls=0;const h=handler(database(),{async generate(){calls++;throw Object.assign(new Error('PRIVATE_DATABASE_SECRET'),{code:'PROVIDER_UNAVAILABLE'});}});
  const result=await h({...scope,message:'Show my invoices',messageId:'error-1'});
  assert.equal(calls,1);assert.ok(result.answer);assert.doesNotMatch(result.answer,/PRIVATE_DATABASE_SECRET|check your invoice or setting/i);
  assert.ok(result.plannerFailure);
  const reply=await h.createSafeFailureReply({workspaceId,code:'OWNER_LOOP_TIMEOUT'});
  assert.match(reply,/too long|timed out/i);assert.equal(calls,1);
});

test('the whole owner turn is bounded even when loading conversation history hangs',async()=>{
  let modelCalls=0;
  const h=createOwnerMessageHandler({supabase:database(),authorize:async()=>true,pendingActionStoreFactory:pendingFactory,
    historyReader:()=>new Promise(()=>{}),providerFactory:()=>({async generate(){modelCalls++;return {content:'Late'};}}),logger:{error(){}}});
  const started=Date.now();
  const result=await h({...scope,message:'Show invoices',messageId:'hung-setup',allowDeferred:true,deadlineAt:Date.now()+5_040});
  assert.ok(Date.now()-started<1_000);assert.equal(modelCalls,0);
  assert.equal(result.deferred,true);assert.equal(result.checkpoint,null);assert.equal(result.plannerFailure,undefined);
});

test('the default single tool preserves invoice delete confirmation and undo end to end',async()=>{
  const db=database(),invoice=db.tables.invoices[0];
  Object.assign(invoice,{issue_date:'2026-09-01',due_date:'2026-10-01',created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-02T00:00:00Z',metadata:{invoice_direction:'receivable'}});
  let current=null,generation=0,sequence=0,proposal=null;
  const pending={loadPendingAction:async()=>current&&!current.consumed_at?structuredClone(current):null,
    loadPendingActionState:async()=>({generation,id:current?.id||null,version:current?.version||null,action:current?.action||null}),
    async storePendingAction({action,expectedState}){if(expectedState?.generation!==generation)return null;current={id:++sequence,version:1,action:structuredClone(action)};generation++;return structuredClone(current);},
    async consumePendingAction({id}){if(id!==current?.id)return null;current.consumed_at=new Date().toISOString();generation++;return structuredClone(current);}};
  const base={invoiceId:invoice.id,proposalId:'77777777-7777-4777-8777-777777777777',invoiceNumber:invoice.invoice_number,
    customerName:'John Smith',totalAmount:120,currency:'USD',status:'sent',expiresAt:new Date(Date.now()+600_000).toISOString(),requiresExactConfirmation:false};
  const actions=[],toolResults=[];
  db.rpc=async(name,args)=>{
    assert.equal(name,'invoice_lifecycle_action');assert.equal(args.p_workspace_id,workspaceId);actions.push(args.p_action);
    if(args.p_action==='pending')return {data:{ok:true,action:'proposal_loaded',pending:!!proposal,...(proposal||{})}};
    if(args.p_action==='prepare'){assert.equal(args.p_invoice_id,invoice.id);proposal={...base};return {data:{ok:true,action:'proposal_created',...base}};}
    if(args.p_action==='confirm'){assert.equal(args.p_user_message,'yes');assert.ok(proposal);proposal=null;invoice.deleted_at=new Date().toISOString();return {data:{ok:true,action:'deleted',...base}};}
    if(args.p_action==='undo'){assert.equal(args.p_invoice_number,invoice.invoice_number);assert.ok(invoice.deleted_at);invoice.deleted_at=null;return {data:{ok:true,action:'restored',...base}};}
    throw Error('Unexpected lifecycle operation');
  };
  const plans=[{operation:'delete',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:invoice.invoice_number}]},
    {operation:'confirm'},{operation:'restore',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:invoice.invoice_number}]}];
  const answers=['John Smith’s invoice INV-JOHN-1 is USD 120, status sent. Reply yes to delete, or cancel.',
    'Deleted INV-JOHN-1. Reply UNDO DELETE INV-JOHN-1 to restore it within 30 days.','Restored INV-JOHN-1.'];
  let turn=0;
  const h=createOwnerMessageHandler({supabase:db,authorize:async()=>true,pendingActionStoreFactory:()=>pending,
    historyReader:async()=>[],ownerStoreFactory:()=>({async query(table,{filters={}}={}){
      let rows=(db.tables[table]||[]).filter(row=>row.workspace_id===workspaceId);
      for(const [key,filter] of Object.entries(filters)){
        if(filter.startsWith('eq.'))rows=rows.filter(row=>String(row[key])===filter.slice(3));
        if(filter.startsWith('in.('))rows=rows.filter(row=>filter.slice(4,-1).split(',').includes(String(row[key])));
      }
      return rows;
    }}),providerFactory:()=>{const index=turn++;return {async generate({messages,tools}){
      if(tools)assert.deepEqual(tools.map(tool=>tool.function.name),['getAIProviderConfiguration','workspaceData']);
      if(!messages.some(message=>message.role==='tool'))return {model:CF_QWEN_MODEL,toolCalls:[call(plans[index])]};
      const result=JSON.parse(messages.find(message=>message.role==='tool').content);toolResults.push(result);
      return {model:CF_QWEN_MODEL,content:answers[index]};
    }};},logger:{error(){}}});
  const proposed=await h({...scope,message:'Delete John’s duplicate invoice INV-JOHN-1',messageId:'delete-1'});
  assert.equal(toolResults.at(-1)?.ok,true,JSON.stringify(toolResults));assert.match(proposed.answer,/Reply yes to delete, or cancel/);assert.equal(invoice.deleted_at,null);
  const deleted=await h({...scope,message:'yes',messageId:'delete-2'});assert.match(deleted.answer,/Deleted/);assert.ok(invoice.deleted_at);
  const restored=await h({...scope,message:'UNDO DELETE INV-JOHN-1',messageId:'delete-3'});assert.match(restored.answer,/Restored/);assert.equal(invoice.deleted_at,null);
  assert.ok(actions.includes('prepare'));assert.ok(actions.includes('confirm'));assert.ok(actions.includes('undo'));
});

test('model selection is proposed through workspaceData, confirmed later, and used on the next owner turn',async()=>{
  const db=database(),modelSettings=db.tables.workspace_ai_settings[0];
  let proposal=null,generation=0,turn=0;
  const pending={loadPendingAction:async()=>proposal?structuredClone(proposal):null,
    loadPendingActionState:async()=>({generation,id:proposal?.id||null,version:proposal?.version||null,action:proposal?.action||null})};
  db.rpc=async(name,args)=>{
    if(name==='invoice_lifecycle_action')return {data:{ok:false,code:'FEATURE_UNAVAILABLE'}};
    assert.equal(args.p_workspace_id,workspaceId);assert.equal(args.p_phone,scope.phone);
    if(name==='whatsapp_workspace_data_propose'){
      assert.equal(args.p_table,'workspace_ai_settings');assert.equal(args.p_values.primary_model,CF_PRIMARY_MODEL);
      assert.equal(modelSettings.primary_model,CF_QWEN_MODEL);
      proposal={id:12,version:1,action:{type:'owner_workspace_data_change',proposalId:'88888888-8888-4888-8888-888888888888',requestMessageId:args.p_request_message_id}};
      generation++;return {data:{ok:true,expiresAt:new Date(Date.now()+600_000).toISOString()}};
    }
    assert.equal(name,'whatsapp_workspace_data_confirm');assert.equal(args.p_confirmation_message_id,'model-2');
    modelSettings.primary_model=CF_PRIMARY_MODEL;proposal=null;generation++;return {data:{ok:true,actionType:'owner_workspace_data_confirmed',table:'workspace_ai_settings',operation:'update'}};
  };
  const configured=[];
  const plans=[{operation:'update',table:'workspace_ai_settings',values:{primary_model:CF_PRIMARY_MODEL}},
    {operation:'confirm'},{operation:'describe'}];
  const h=createOwnerMessageHandler({supabase:db,authorize:async()=>true,pendingActionStoreFactory:()=>pending,
    ownerStoreFactory:()=>({query:async()=>[]}),historyReader:async()=>[],logger:{error(){}},providerFactory:config=>{
      const index=turn++;configured.push(config.primaryModel);
      return {async generate({messages,tools}){
        if(tools)assert.deepEqual(tools.map(tool=>tool.function.name),['getAIProviderConfiguration','workspaceData']);
        if(!messages.some(message=>message.role==='tool'))return {model:config.primaryModel,toolCalls:[call(plans[index])]};
        const output=JSON.parse(messages.find(message=>message.role==='tool').content);
        assert.equal(output.ok,true);
        return {model:config.primaryModel,content:index===0?`${output.summary}. Reply yes to apply, or cancel.`:
          index===1?'The primary model has been updated.':`Your primary model is ${output.runtime.primaryModel}.`};
      }};
    }});
  const proposed=await h({...scope,message:'Change your primary model to Llama 3.3',messageId:'model-1'});
  assert.match(proposed.answer,/Reply yes/);assert.equal(modelSettings.primary_model,CF_QWEN_MODEL);
  assert.match((await h({...scope,message:'yes',messageId:'model-2'})).answer,/updated/);
  const meta=await h({...scope,message:'Which model are you using?',messageId:'model-3'});
  assert.match(meta.answer,/llama-3.3/);assert.deepEqual(configured,[CF_QWEN_MODEL,CF_QWEN_MODEL,CF_PRIMARY_MODEL]);
});
