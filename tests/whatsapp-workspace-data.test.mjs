import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {VERIFIED_MODEL_CATALOG} from '../ai/provider.mjs';
import {ownerCalendar,validateCustomFields} from '../automation/whatsapp/workspace-records.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {customFieldsView,businessRecordsView} from '../custom-fields.mjs';

test('owner local tomorrow follows calendar days across midnight and daylight saving',()=>{
  assert.deepEqual(ownerCalendar(()=>new Date('2026-10-04T20:00:00Z'),'Asia/Kolkata'),
    {timezone:'Asia/Kolkata',currentDate:'2026-10-05',tomorrow:'2026-10-06',yesterday:'2026-10-04'});
  assert.equal(ownerCalendar(()=>new Date('2026-03-08T06:30:00Z'),'America/New_York').tomorrow,'2026-03-09');
});

test('custom field validation and dashboard display keep system fields and HTML inert',()=>{
  assert.deepEqual(validateCustomFields({delivery_zone:'West',priority:true,credit_days:30}),{delivery_zone:'West',priority:true,credit_days:30});
  for(const value of [{workspace_id:'foreign'},{amount_paid:0},{api_key:'secret'},{metadata:{}},{status:'paid'},{nested:{}}])
    assert.throws(()=>validateCustomFields(value));
  const escape=s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;');
  assert.match(customFieldsView({delivery_zone:'<script>'},escape),/delivery zone.*&lt;script&gt;/);
  assert.match(businessRecordsView([{name:'<script>',record_type:'supplier',custom_fields:{city:'Mumbai'}}],escape),/&lt;script&gt;.*city.*Mumbai/);
});

test('failed tool results cannot be described as awaiting confirmation',()=>{
  assert.equal(ownerGroundingIssue('This update is awaiting confirmation.',[{ok:false,code:'INVALID'}]),'unverified_proposal');
  assert.equal(ownerGroundingIssue('Please confirm this update.',[{ok:false,code:'NOT_FOUND'}]),'unverified_proposal');
});

test('custom fields are discoverable and readable through the same scoped interface',async()=>{
  const supabase=fakeSupabase({rows:{customers:[{workspace_id:scope.workspaceId,name:'John Smith',custom_fields:{delivery_zone:'West'}}]}});
  const tool=createWorkspaceDataTool({supabase,scope,authorize:async()=>true});
  const description=await tool.execute({operation:'describe',table:'customers'});
  assert.ok(description.catalog.tables.customers.columns.includes('custom_fields'));
  assert.ok(description.catalog.tables.customers.writeFields.update.includes('custom_fields'));
  const read=await tool.execute({operation:'read',table:'customers',columns:['name','custom_fields']});
  assert.deepEqual(read.rows,[{name:'John Smith',custom_fields:{delivery_zone:'West'}}]);
  assert.deepEqual(supabase.calls[0].filters,[['workspace_id','eq',scope.workspaceId]]);
});

test('new business categories use the generic catalog, scoped reads and existing confirmation protocol',async()=>{
  const record={id:'33333333-3333-4333-8333-333333333333',workspace_id:scope.workspaceId,record_type:'supplier',name:'Acme Metals',custom_fields:{city:'Mumbai'},updated_at:'2026-10-01T00:00:00Z'};
  const supabase=fakeSupabase({rows:{business_records:[record]}});
  const tool=createWorkspaceDataTool({supabase,scope,authorize:async()=>true,message:'Change Acme lead days',messageId:'business-request',
    pending:{async loadPendingActionState(){return {generation:0};}}});
  const read=await tool.execute({operation:'read',table:'business_records',filters:[{column:'record_type',operator:'eq',value:'supplier'}]});
  assert.deepEqual(read.rows,[{record_type:'supplier',name:'Acme Metals',custom_fields:{city:'Mumbai'}}]);
  const update=await tool.execute({operation:'update',table:'business_records',filters:[{column:'name',operator:'eq',value:'Acme'}],values:{custom_fields:{lead_days:5}}});
  assert.equal(update.requiresConfirmation,true);
  assert.equal(supabase.calls.filter(call=>call.kind==='rpc').at(-1).args.p_target_id,record.id);
});

const scope = Object.freeze({
  workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownerId:'11111111-1111-4111-8111-111111111111',
  customerId:'22222222-2222-4222-8222-222222222222',
  phone:'+919871367051',
});

test('direct record preflight exposes repairable schema errors without attempting a write',async()=>{
  let writes=0;
  const tool=createWorkspaceDataTool({supabase:fakeSupabase(),scope,authorize:async()=>true,confirmationMode:'direct',message:'Create QA record',messageId:'isolated-preflight',
    executeDirectOperation:async()=>{writes++;return {ok:true};}});
  for(const [values,code] of [
    [{name:'QA',check_count:1},'INVALID_FIELDS'],
    [{name:'QA'},'INVALID_CATEGORY'],
    [{record_type:'qa_check'},'REQUIRED_FIELDS'],
    [{record_type:'QA Check',name:'QA'},'INVALID_CATEGORY'],
    [{record_type:'qa_check',name:22},'INVALID_VALUE'],
  ]){
    const result=await tool.execute({operation:'create',table:'business_records',values});
    assert.equal(result.ok,false);assert.equal(result.validationCode,code,JSON.stringify({values,result}));
    assert(result.catalog.tables.business_records.writeValueConstraints.create);
    assert.equal(tool.getWriteAttempted(),false);assert.equal(writes,0);
  }
  const denied=await tool.execute({operation:'create',table:'business_records',values:{record_type:'qa_check',name:'QA',workspace_id:'foreign'}});
  assert.equal(denied.ok,false);assert.equal(writes,0);assert.equal(tool.getWriteAttempted(),false);
  const result=await tool.execute({operation:'create',table:'business_records',values:{record_type:'qa_check',name:'QA',custom_fields:{check_count:1,qa_status:'active'}}});
  assert.equal(result.ok,true);assert.equal(tool.getWriteAttempted(),true);assert.equal(writes,1);
});

test('real provider can repair a malformed generic business create before the single scoped write',async()=>{
  const message="Create a qa_check business record named CETLD QA 20261004 1442 with custom fields check_note 'temporary assistant test', check_count 1 and qa_status 'active'.";
  const values={record_type:'qa_check',name:'CETLD QA 20261004 1442',custom_fields:{check_note:'temporary assistant test',check_count:1,qa_status:'active'}};
  let calls=0,writes=0,saved;
  const workspaceTools=createOwnerWorkspaceTools({supabase:fakeSupabase(),scope,ownerStore:{async query(){return [];}},
    message,messageId:'isolated-business-create',authorize:async candidate=>candidate===scope,botPreferences:{confirmationMode:'direct'},
    directWriteAdapter:{async lookupCompleted(){return {ok:false,code:'NO_RECEIPT'};},async apply(input){
      writes++;assert.equal(input.workspaceId,scope.workspaceId);assert.equal(input.ownerId,scope.ownerId);
      assert.equal(input.operation,'business_record.create');assert.deepEqual(input.payload,values);
      assert.equal(input.authorization.quote,message);saved=structuredClone(input.payload);
      return {ok:true,completed:true,action:'business_record.created',entityType:'business_record',entityId:'33333333-3333-4333-8333-333333333333',record:saved};
    }}});
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,
    logger:{info(){},warn(){},error(){}},fetchImpl:async(_url,init)=>{
      calls++;const wire=JSON.parse(init.body);let content;
      if(calls===1)content=JSON.stringify({name:'workspaceData',parameters:{operation:'create',table:'business_records',values:{name:values.name,check_count:1}}});
      else if(calls===2){
        assert.equal(writes,0);assert(wire.tools?.length);
        assert(wire.messages.some(row=>row.role==='tool'&&JSON.parse(row.content).validationCode==='INVALID_FIELDS'));
        content=JSON.stringify({name:'workspaceData',parameters:{operation:'create',table:'business_records',values}});
      }else{assert.equal(writes,1);assert.deepEqual(saved,values);content='Created CETLD QA 20261004 1442 with check_note temporary assistant test, check_count 1 and qa_status active.';}
      return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
    }});
  const result=await runOwnerAgent({provider,message,tools:workspaceTools});
  assert.equal(result.plannerFailure,undefined);assert.match(result.answer,/Created CETLD QA/);
  assert.equal(calls,3);assert.equal(writes,1);
});

function fakeSupabase({rows={}, rpcResult={ok:true}, rpcError=null}={}) {
  const calls=[];
  return {
    calls,
    from(table) {
      const call={kind:'query',table,filters:[],selected:null};calls.push(call);
      const query={
        select(columns) { call.selected=columns;return query; },
        eq(column,value) { call.filters.push([column,'eq',value]);return query; },
        neq(column,value) { call.filters.push([column,'neq',value]);return query; },
        gt(column,value) { call.filters.push([column,'gt',value]);return query; },
        gte(column,value) { call.filters.push([column,'gte',value]);return query; },
        lt(column,value) { call.filters.push([column,'lt',value]);return query; },
        lte(column,value) { call.filters.push([column,'lte',value]);return query; },
        ilike(column,value) { call.filters.push([column,'ilike',value]);return query; },
        in(column,value) { call.filters.push([column,'in',value]);return query; },
        is(column,value) { call.filters.push([column,'is',value]);return query; },
        order(column,options) { (call.orders||=[]).push([column,options]);return query; },
        limit(value) { call.limit=value;return query; },
        range(from,to) { call.range=[from,to];return query; },
        maybeSingle() { call.single=true;return Promise.resolve({data:rows[table]?.[0]??null,error:null}); },
        then(resolve,reject) {
          let all=rows[table]||[];
          all=all.filter(row=>call.filters.every(([column,operator,value])=>{
            if(column==='workspace_id'&&row[column]===undefined)return true;
            const actual=row[column];
            if(operator==='eq')return actual===value;
            if(operator==='neq')return actual!==value;
            if(operator==='in')return value.includes(actual);
            if(operator==='is')return value===null?actual==null:actual===value;
            if(operator==='ilike')return String(actual??'').toLowerCase().includes(String(value).replaceAll('%','').toLowerCase());
            if(operator==='gt')return actual>value;
            if(operator==='gte')return actual>=value;
            if(operator==='lt')return actual<value;
            if(operator==='lte')return actual<=value;
            return false;
          }));
          const data=call.range?all.slice(call.range[0],call.range[1]+1):call.limit?all.slice(0,call.limit):all;
          return Promise.resolve({data,error:null}).then(resolve,reject);
        },
      };
      return query;
    },
    async rpc(name,args) {
      calls.push({kind:'rpc',name,args});
      if(rpcError) return {data:null,error:rpcError};
      return {data:typeof rpcResult==='function'?rpcResult(name,args):rpcResult,error:null};
    },
  };
}

test('John and JohnSmith reads and writes resolve the same scoped John Smith; ambiguity refuses mutation',async()=>{
  const john={id:'33333333-3333-4333-8333-333333333333',workspace_id:scope.workspaceId,name:'John Smith',phone:null,updated_at:'2026-10-01T00:00:00Z'};
  const foreign={...john,id:'44444444-4444-4444-8444-444444444444',workspace_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  const supabase=fakeSupabase({rows:{customers:[john,foreign]}});
  const pending={async loadPendingActionState(){return {generation:0};}};
  for(const name of ['John','JohnSmith']){
    const tool=createWorkspaceDataTool({supabase,scope,authorize:async()=>true,pending,message:'Set his phone',messageId:'req-'+name});
    const read=await tool.execute({operation:'read',table:'customers',columns:['name','phone'],filters:[{column:'name',operator:'eq',value:name}]});
    assert.deepEqual(read.rows,[{name:'John Smith',phone:null}]);
    const write=await tool.execute({operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:name}],values:{phone:'+12025550123'}});
    assert.equal(write.requiresConfirmation,true);
    assert.equal(supabase.calls.filter(c=>c.kind==='rpc').at(-1).args.p_target_id,john.id);
  }
  const ambiguous=fakeSupabase({rows:{customers:[john,{...john,id:'55555555-5555-4555-8555-555555555555',name:'John Brown'}]}});
  const tool=createWorkspaceDataTool({supabase:ambiguous,scope,authorize:async()=>true,pending,message:'Set John phone',messageId:'ambiguous'});
  const result=await tool.execute({operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'John'}],values:{phone:'+12025550123'}});
  assert.equal(result.code,'AMBIGUOUS');assert.equal(result.requiresConfirmation,undefined);
  assert.equal(ambiguous.calls.some(c=>c.kind==='rpc'),false);
  const unrelated=fakeSupabase({rows:{customers:[{...john,name:'Mary Johnson'}]}});
  const noJohn=createWorkspaceDataTool({supabase:unrelated,scope,authorize:async()=>true,pending,message:'Set John phone',messageId:'no-john'});
  const absent=await noJohn.execute({operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'John'}],values:{phone:'+12025550123'}});
  assert.equal(absent.code,'NOT_FOUND');assert.equal(unrelated.calls.some(c=>c.kind==='rpc'),false);
});

test('unpaid is an honest no-op only when current invoice and payment facts agree',async()=>{
  const invoice={id:'33333333-3333-4333-8333-333333333333',workspace_id:scope.workspaceId,invoice_number:'INV-JOHN',status:'sent',total_amount:'100',amount_paid:'0'};
  for(const [patch,payments,expected] of [[{},[],true],[{amount_paid:'20'},[],false],[{status:'paid',amount_paid:'100'},[],false],[{},[{invoice_id:invoice.id,amount:'1'}],false]]){
    const supabase=fakeSupabase({rows:{invoices:[{...invoice,...patch}],payments}});
    const tool=createWorkspaceDataTool({supabase,scope,authorize:async()=>true});
    const result=await tool.execute({operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-JOHN'}],values:{status:'unpaid'}});
    assert.equal(result.ok,expected);assert.notEqual(result.completed,true);assert.notEqual(result.requiresConfirmation,true);
    if(expected)assert.equal(result.alreadyUnpaid,true);else assert.equal(result.code,'PAYMENT_GUARD');
    assert.equal(supabase.calls.some(c=>c.kind==='rpc'),false);
  }
});

test('structured tomorrow and custom fields reach direct execution only with current authorization',async()=>{
  let seen;
  const tool=createWorkspaceDataTool({supabase:fakeSupabase(),scope,authorize:async()=>true,message:'set it to tomorrows date',confirmationMode:'direct',timezone:'Asia/Kolkata',
    clock:()=>new Date('2026-10-04T20:00:00Z'),executeDirectOperation:async params=>{seen=params;return {ok:true,completed:true};}});
  await tool.execute({operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-JOHN'}],values:{due_date:'2019-02-26'}});
  assert.equal(seen.values.due_date,'2026-10-06');
  const invalid=await tool.execute({operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'John'}],values:{custom_fields:{owner_id:'foreign'}}});
  assert.equal(invalid.ok,false);
  const controller=new AbortController();controller.abort();
  const stopped=await tool.execute({operation:'update',table:'customers',values:{custom_fields:{priority:true}}},{signal:controller.signal});
  assert.equal(stopped.ok,false);assert.equal(seen.values.due_date,'2026-10-06');
});

test('workspaceData offers one generic tool and scoped reads expose sanitized allowlisted fields', async()=>{
  const supabase=fakeSupabase({rows:{customers:[{
    id:'33333333-3333-4333-8333-333333333333',workspace_id:scope.workspaceId,
    name:'Northstar',email:'billing@northstar.test',phone:'+919999999999',metadata:{api_key:'never return this'},
    created_at:'2026-10-01T00:00:00Z',
  }]}});
  const tool=createWorkspaceDataTool({supabase,scope,message:'show Northstar',authorize:async()=>true});

  assert.equal(tool.definition.function.name,'workspaceData');
  const result=await tool.execute({operation:'read',table:'customers',
    columns:['name','email','phone'],filters:[{column:'name',operator:'ilike',value:'%Northstar%'}],limit:5});

  assert.deepEqual(supabase.calls[0].filters,[
    ['workspace_id','eq',scope.workspaceId],['name','ilike','%Northstar%'],
  ]);
  assert.equal(supabase.calls[0].selected,'name,email,phone,id,updated_at,metadata');
  assert.deepEqual(result.rows,[{name:'Northstar',email:'billing@northstar.test',phone:'+919999999999'}]);
  assert.doesNotMatch(JSON.stringify(result),/api_key|workspace_id|33333333/);
  const internal=tool.getNextActionContext().records;
  assert.equal(internal[0].id,'33333333-3333-4333-8333-333333333333');
  assert.deepEqual(internal[0].metadata,{whatsapp_owner:false});
  assert.doesNotMatch(JSON.stringify(internal),/api_key|never return this/);
});

test('invoice customer-name lookup uses one workspace-scoped joined query',async()=>{
  const calls=[];
  const supabase={from(table){
    const call={table,selected:null,filters:[],orders:[],range:null};calls.push(call);
    const query={select(value){call.selected=value;return query;},eq(column,value){call.filters.push([column,'eq',value]);return query;},
      is(column,value){call.filters.push([column,'is',value]);return query;},ilike(column,value){call.filters.push([column,'ilike',value]);return query;},
      order(column,options){call.orders.push([column,options]);return query;},range(from,to){call.range=[from,to];return query;},
      then(resolve,reject){return Promise.resolve({data:[{workspace_id:scope.workspaceId,customer_id:'33333333-3333-4333-8333-333333333333',
        invoice_number:'INV-JOHN-1',customer:{name:'John Smith'}}],error:null}).then(resolve,reject);}};
    return query;
  }};
  const tool=createWorkspaceDataTool({supabase,scope,authorize:async()=>true});

  const result=await tool.execute({operation:'read',table:'invoices',columns:['invoice_number','customer_name'],
    filters:[{column:'customer_name',operator:'ilike',value:'%John%'}]});

  assert.deepEqual(result.rows,[{invoice_number:'INV-JOHN-1',customer_name:'John Smith'}]);
  assert.equal(calls.length,1);
  assert.equal(calls[0].table,'invoices');
  assert.match(calls[0].selected,/customers!invoices_workspace_id_customer_id_fkey!inner\(name\)/);
  assert.ok(calls[0].filters.some(([column,operator,value])=>column==='customer.name'&&operator==='ilike'&&value==='%John%'));
});

test('workspaceData rejects model-supplied workspace, tenant, or owner scope anywhere before database access',async()=>{
  const supabase=fakeSupabase();
  const safety=[];
  const tool=createWorkspaceDataTool({supabase,scope,message:'read',authorize:async()=>true,
    executeSafetyOperation:async params=>{safety.push(params);return {ok:true};}});

  for(const args of [
    {operation:'read',table:'customers',filters:[{column:'workspace_id',operator:'eq',value:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]},
    {operation:'update',table:'customers',values:{name:'A',tenant_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},
    {operation:'read',table:'customers',filters:[{column:'name',operator:'eq',value:scope.ownerId}]},
  ]) {
    const result=await tool.execute(args);
    assert.equal(result.ok,false);
    assert.equal(result.code,'INVALID');
  }
  assert.deepEqual(supabase.calls,[]);
  assert.deepEqual(safety,[]);
});

test('natural-language planning receives the safe catalog and never receives verified scope identifiers',async()=>{
  const supabase=fakeSupabase({rows:{customers:[]}});
  let seen;
  const tool=createWorkspaceDataTool({supabase,scope,message:'find a customer',authorize:async()=>true,
    planRequest:async(request,{catalog})=>{seen={request,catalog};return {operation:'read',table:'customers',columns:['name'],filters:[]};}});

  const result=await tool.execute({request:'Find the customer named Northstar'});
  assert.equal(result.ok,true);
  assert.equal(seen.request,'Find the customer named Northstar');
  assert.ok(seen.catalog.tables.customers.columns.includes('name'));
  assert.ok(seen.catalog.tables.invoices.writeFields.create.includes('customer_name'));
  assert.ok(seen.catalog.tables.invoices.writeFields.update.includes('status'));
  assert.deepEqual(seen.catalog.tables.invoices.writeValueConstraints.update.status,['paid','unpaid']);
  assert.ok(seen.catalog.tables.workspace_settings.writeFields.update.includes('business_name'));
  assert.ok(seen.catalog.tables.workspace_settings.writeFields.update.includes('follow_up_preferences'));
  const preferences=seen.catalog.tables.workspace_settings.writeValueConstraints.update;
  assert.deepEqual(preferences.owner_bot_preferences.tone,['concise','friendly','formal']);
  assert.ok(preferences.owner_bot_preferences.language.includes('Hindi'));
  assert.match(preferences.follow_up_preferences.reminderTemplate,/\{\{invoice_number\}\}/);
  assert.doesNotMatch(JSON.stringify(seen.catalog),/workspaceId|ownerId|customerId|workspace_id|owner_id/);
  assert.deepEqual(supabase.calls[0].filters,[['workspace_id','eq',scope.workspaceId]]);
});

test('read results are withheld when owner authorization is revoked during the database query',async()=>{
  const supabase=fakeSupabase({rows:{customers:[{name:'Private customer',workspace_id:scope.workspaceId}]}});
  let checks=0;
  const tool=createWorkspaceDataTool({supabase,scope,authorize:async()=>++checks<3});
  const result=await tool.execute({operation:'read',table:'customers',columns:['name']});
  assert.equal(result.ok,false);
  assert.equal(result.code,'DENIED');
  assert.equal(result.rows,undefined);
  assert.equal(checks,3);
});

test('generic customer writes are single-record confirmation proposals with server-derived target ids',async()=>{
  const supabase=fakeSupabase({rows:{customers:[{
    id:'33333333-3333-4333-8333-333333333333',workspace_id:scope.workspaceId,
    name:'Northstar',email:null,phone:null,updated_at:'2026-10-01T00:00:00Z',
  }]},rpcResult:{ok:true,proposalId:'99999999-9999-4999-8999-999999999999',expiresAt:'2026-10-02T01:00:00Z'}});
  const pending={async loadPendingActionState(){return {generation:4,id:null,version:null};}};
  const tool=createWorkspaceDataTool({supabase,scope,message:'Change Northstar to Northstar LLC',messageId:'wamid.request',
    pending,authorize:async()=>true});

  const result=await tool.execute({operation:'update',table:'customers',
    filters:[{column:'name',operator:'eq',value:'Northstar'}],values:{name:'Northstar LLC'}});

  assert.equal(result.ok,true);
  assert.equal(result.requiresConfirmation,true);
  const rpc=supabase.calls.find(call=>call.kind==='rpc');
  assert.equal(rpc.name,'whatsapp_workspace_data_propose');
  assert.equal(rpc.args.p_workspace_id,scope.workspaceId);
  assert.equal(rpc.args.p_target_id,'33333333-3333-4333-8333-333333333333');
  assert.equal(rpc.args.p_expected_updated_at,'2026-10-01T00:00:00Z');
  assert.equal(rpc.args.p_expected_generation,4);
  assert.equal(rpc.args.p_request_message_id,'wamid.request');
});

test('AI model changes require server catalog roles and confirm only on a later exact owner message',async()=>{
  const primary=VERIFIED_MODEL_CATALOG.find(entry=>entry.roles.includes('primary')&&entry.id!== 'space-bunny-free').id;
  const fallback=VERIFIED_MODEL_CATALOG.find(entry=>entry.roles.includes('fallback')&&entry.id!==primary).id;
  const supabase=fakeSupabase({rows:{workspace_ai_settings:[{
    workspace_id:scope.workspaceId,primary_model:'space-bunny-free',fallback_model:'longcat-2.5-preview-free',
    updated_at:'2026-10-01T00:00:00Z',
  }]},rpcResult:{ok:true,proposalId:'99999999-9999-4999-8999-999999999999'}});
  const pending={async loadPendingActionState(){return {generation:1,id:null,version:null};}};
  const propose=createWorkspaceDataTool({supabase,scope,message:'Change my primary model',messageId:'wamid.request',pending,authorize:async()=>true});
  const rejected=await propose.execute({operation:'update',table:'workspace_ai_settings',
    values:{primary_model:'unverified/model'}});
  assert.equal(rejected.ok,false);
  assert.equal(rejected.code,'INVALID');
  assert.equal(supabase.calls.some(call=>call.kind==='rpc'),false);

  const staged=await propose.execute({operation:'update',table:'workspace_ai_settings',
    values:{primary_model:primary,fallback_model:fallback}});
  assert.equal(staged.requiresConfirmation,true);
  const proposalCall=supabase.calls.find(call=>call.name==='whatsapp_workspace_data_propose');
  assert.equal(proposalCall.args.p_values.primary_model,primary);
  assert.equal(proposalCall.args.p_values.fallback_model,fallback);

  const confirmDb=fakeSupabase({rpcResult:{ok:true,table:'workspace_ai_settings',operation:'update'}});
  const confirm=createWorkspaceDataTool({supabase:confirmDb,scope,message:'yes',messageId:'wamid.confirm',authorize:async()=>true,
    pendingAtStart:{id:12,version:1,generation:2,workspace_id:scope.workspaceId,customer_id:scope.customerId,
      phone:scope.phone,action:{type:'owner_workspace_data_change',proposalId:'99999999-9999-4999-8999-999999999999'}}});
  const applied=await confirm.execute({operation:'confirm'});
  assert.equal(applied.ok,true);
  assert.equal(confirmDb.calls[0].name,'whatsapp_workspace_data_confirm');
  assert.equal(confirmDb.calls[0].args.p_pending_id,12);
  assert.equal(confirmDb.calls[0].args.p_confirmation_message_id,'wamid.confirm');
  assert.equal(confirmDb.calls[0].args.p_user_message,'yes');
});

test('generic proposal confirmation rejects inferred or same-turn confirmation before calling SQL',async()=>{
  const supabase=fakeSupabase();
  const tool=createWorkspaceDataTool({supabase,scope,message:'yes please do it',messageId:'wamid.confirm',authorize:async()=>true,
    pendingAtStart:{id:12,version:1,action:{type:'owner_workspace_data_change',proposalId:'99999999-9999-4999-8999-999999999999'}}});
  const result=await tool.execute({operation:'confirm'});
  assert.equal(result.ok,false);
  assert.equal(result.code,'INVALID');
  assert.equal(supabase.calls.length,0);
});

test('an active owner action cannot be silently replaced by a generic proposal',async()=>{
  const supabase=fakeSupabase({rows:{customers:[{
    id:'33333333-3333-4333-8333-333333333333',name:'Northstar',updated_at:'2026-10-01T00:00:00Z',
  }]}});
  const pending={async loadPendingActionState(){return {generation:4,id:20,version:1,
    action:{type:'owner_invoice_update',invoiceNumber:'INV-10'}};}};
  const tool=createWorkspaceDataTool({supabase,scope,message:'Rename Northstar',messageId:'wamid.request',
    pending,authorize:async()=>true});
  const result=await tool.execute({operation:'update',table:'customers',
    filters:[{column:'name',operator:'eq',value:'Northstar'}],values:{name:'Northstar LLC'}});
  assert.equal(result.ok,false);
  assert.equal(result.code,'PENDING');
  assert.equal(supabase.calls.length,0);
  assert.equal(tool.getWriteAttempted(),false);
});

test('a retried confirmation replays its durable receipt even after pending state was consumed',async()=>{
  const supabase=fakeSupabase({rpcResult:(name,args)=>name==='whatsapp_workspace_data_confirm'
    ?{ok:true,replayed:true,actionType:'owner_workspace_data_confirmed',table:'customers',operation:'create'}
    :{ok:false,reason:'no_action'}});
  const tool=createWorkspaceDataTool({supabase,scope,message:'yes',messageId:'wamid.confirm',authorize:async()=>true});
  const result=await tool.execute({operation:'confirm'});
  assert.equal(result.ok,true);
  assert.equal(result.replayed,true);
  const rpc=supabase.calls[0];
  assert.equal(rpc.name,'whatsapp_workspace_data_confirm');
  assert.equal(rpc.args.p_pending_id,null);
  assert.equal(rpc.args.p_proposal_id,null);
  assert.equal(tool.getWriteAttempted(),false);
});

test('reads use stable scoped pagination and expose a next offset when a page is full',async()=>{
  const customers=[
    {invoice_number:'INV-001',status:'open',created_at:'2026-10-01T00:00:00Z'},
    {invoice_number:'INV-002',status:'open',created_at:'2026-10-02T00:00:00Z'},
    {invoice_number:'INV-003',status:'paid',created_at:'2026-10-03T00:00:00Z'},
    {invoice_number:'INV-004',status:'open',created_at:'2026-10-04T00:00:00Z'},
    {invoice_number:'INV-005',status:'open',created_at:'2026-10-05T00:00:00Z'},
  ];
  const supabase=fakeSupabase({rows:{invoices:customers}});
  let authorizations=0;
  const tool=createWorkspaceDataTool({supabase,scope,authorize:async()=>{authorizations++;return true;}});
  const result=await tool.execute({operation:'read',table:'invoices',columns:['invoice_number','status'],
    filters:[{column:'status',operator:'eq',value:'open'}],limit:2,offset:1});
  assert.deepEqual(result.rows,[{invoice_number:'INV-002',status:'open'},{invoice_number:'INV-004',status:'open'}]);
  assert.equal(result.truncated,true);
  assert.equal(result.nextOffset,3);
  assert.deepEqual(supabase.calls[0].range,[1,3]);
  assert.deepEqual(supabase.calls[0].orders,[['created_at',{ascending:false}],['id',{ascending:false}]]);
  assert.ok(authorizations>=2,'owner scope is rechecked at the query boundary');
});

test('partial AI model changes merge against the sanitized active runtime pair',async()=>{
  const primary=VERIFIED_MODEL_CATALOG.find(entry=>entry.roles.includes('primary')&&entry.id!=='space-bunny-free').id;
  const runtimeFallback=VERIFIED_MODEL_CATALOG.find(entry=>entry.roles.includes('fallback')&&entry.id!==primary).id;
  const supabase=fakeSupabase({rows:{workspace_ai_settings:[]},rpcResult:{ok:true}});
  const pending={async loadPendingActionState(){return {generation:0,id:null,version:null};}};
  const tool=createWorkspaceDataTool({supabase,scope,message:'Use this primary',messageId:'wamid.request',pending,
    authorize:async()=>true,getRuntimeConfig:async()=>({activePrimaryModel:'space-bunny-free',activeFallbackModel:runtimeFallback})});
  const result=await tool.execute({operation:'update',table:'workspace_ai_settings',values:{primary_model:primary}});
  assert.equal(result.requiresConfirmation,true);
  const proposal=supabase.calls.find(call=>call.name==='whatsapp_workspace_data_propose');
  assert.equal(proposal.args.p_values.primary_model,primary);
  assert.equal(proposal.args.p_values.fallback_model,runtimeFallback);
  assert.equal(proposal.args.p_expected_updated_at,null);
});

test('workspace settings reads expose the scoped preference columns, and a tone patch preserves the saved bot style',async()=>{
  const original={assistantName:'Mira',tone:'friendly',language:'English',replyLength:'short',
    confirmationMode:'buttons',serviceReplySignature:'CETLD',customInstruction:'Use concise replies'};
  const updatedAt='2026-10-02T12:00:00Z';
  const supabase=fakeSupabase({rows:{workspace_settings:[{
    workspace_id:scope.workspaceId,business_name:'Northstar',default_currency:'INR',default_timezone:'Asia/Kolkata',
    follow_up_preferences:{tone:'professional',cadenceDays:7},owner_bot_preferences:original,updated_at:updatedAt,
  }]},rpcResult:{ok:true,proposalId:'99999999-9999-4999-8999-999999999999',expires_at:'2026-10-03T12:00:00Z'}});
  const pending={async loadPendingActionState(){return {generation:9,id:null,version:null};}};
  const readTool=createWorkspaceDataTool({supabase,scope,authorize:async()=>true});
  const read=await readTool.execute({operation:'read',table:'workspace_settings'});
  assert.deepEqual(read.rows,[{
    business_name:'Northstar',default_currency:'INR',default_timezone:'Asia/Kolkata',
    follow_up_preferences:{tone:'professional',cadenceDays:7},owner_bot_preferences:original,
  }]);

  const writeTool=createWorkspaceDataTool({supabase,scope,message:'Make the assistant formal',messageId:'wamid.settings-tone',
    pending,authorize:async()=>true,confirmationMode:'buttons'});
  const staged=await writeTool.execute({operation:'update',table:'workspace_settings',values:{owner_bot_preferences:{tone:'formal'}}});
  assert.equal(staged.ok,true);
  assert.equal(staged.requiresConfirmation,true);
  assert.equal(writeTool.getReplyRequirement()?.confirmationText,'yes');
  const proposal=supabase.calls.find(call=>call.name==='whatsapp_workspace_data_propose');
  assert.ok(proposal,'the partial preference update should use the generic pending-proposal RPC');
  assert.equal(proposal.args.p_table,'workspace_settings');
  assert.equal(proposal.args.p_target_id,scope.workspaceId);
  assert.equal(proposal.args.p_expected_updated_at,updatedAt);
  assert.deepEqual(proposal.args.p_values.owner_bot_preferences,{...original,tone:'formal'});
  assert.equal(proposal.args.p_values.follow_up_preferences,undefined);
});

test('a reminder-template edit in buttons mode becomes a generic scoped settings proposal',async()=>{
  const currentFollowups={tone:'gentle',cadenceDays:5,reminderTemplate:'Old template'};
  const supabase=fakeSupabase({rows:{workspace_settings:[{
    workspace_id:scope.workspaceId,business_name:'Northstar',default_currency:'INR',default_timezone:'Asia/Kolkata',
    follow_up_preferences:currentFollowups,owner_bot_preferences:{tone:'friendly'},updated_at:'2026-10-02T12:00:00Z',
  }]},rpcResult:{ok:true,proposalId:'99999999-9999-4999-8999-999999999999',expires_at:'2026-10-03T12:00:00Z'}});
  const pending={async loadPendingActionState(){return {generation:3,id:null,version:null};}};
  const tool=createWorkspaceDataTool({supabase,scope,message:'Update the reminder template',messageId:'wamid.template',pending,
    authorize:async()=>true,confirmationMode:'buttons'});
  const staged=await tool.execute({operation:'update',table:'workspace_settings',values:{
    follow_up_preferences:{reminderTemplate:'Hello {{customer_name}} — invoice {{invoice_number}} is due.'},
  }});

  assert.equal(staged.ok,true);
  assert.equal(staged.requiresConfirmation,true);
  const proposal=supabase.calls.find(call=>call.name==='whatsapp_workspace_data_propose');
  assert.ok(proposal,'template edits must be staged in the same atomic generic proposal flow');
  assert.equal(proposal.args.p_workspace_id,scope.workspaceId);
  assert.equal(proposal.args.p_customer_id,scope.customerId);
  assert.equal(proposal.args.p_phone,scope.phone);
  assert.equal(proposal.args.p_request_message_id,'wamid.template');
  assert.equal(proposal.args.p_table,'workspace_settings');
  assert.deepEqual(proposal.args.p_values.follow_up_preferences,{reminderTemplate:'Hello {{customer_name}}, invoice {{invoice_number}} is due.'});
  assert.equal(proposal.args.p_expected_updated_at,'2026-10-02T12:00:00Z');
});

test('malformed reminder placeholders fail before any settings query or proposal RPC',async()=>{
  const supabase=fakeSupabase({rows:{workspace_settings:[{
    workspace_id:scope.workspaceId,business_name:'Northstar',default_currency:'INR',default_timezone:'Asia/Kolkata',
    follow_up_preferences:{},owner_bot_preferences:{},updated_at:'2026-10-02T12:00:00Z',
  }]}});
  const pending={async loadPendingActionState(){return {generation:1,id:null,version:null};}};
  const tool=createWorkspaceDataTool({supabase,scope,message:'Use an unsupported reminder placeholder',messageId:'wamid.bad-template',pending,
    authorize:async()=>true,confirmationMode:'buttons'});
  const result=await tool.execute({operation:'update',table:'workspace_settings',values:{
    follow_up_preferences:{reminderTemplate:'Pay using {{bank_account_secret}}'},
  }});

  assert.equal(result.ok,false);
  assert.equal(result.code,'INVALID');
  assert.deepEqual(supabase.calls,[],'invalid template input should be rejected before even reading settings');
});

test('direct workspace writes quote the actual owner message and use only the verified owner scope',async()=>{
  const customerId='33333333-3333-4333-8333-333333333333';
  const message='Rename Northstar to Northstar LLC';
  const supabase=fakeSupabase({rows:{customers:[{
    id:customerId,workspace_id:scope.workspaceId,name:'Northstar',company_name:null,email:null,phone:null,
    updated_at:'2026-10-02T12:00:00Z',
  }]}});
  let adapterInput;
  const tools=createOwnerWorkspaceTools({supabase,scope,ownerStore:{async query(){return []; }},message,messageId:'wamid.direct-owner',authorize:async candidate=>candidate===scope,
    botPreferences:{confirmationMode:'direct'},directWriteAdapter:{
      async apply(input){adapterInput=input;return {ok:true,completed:true,action:'customer.updated',entityType:'customer',entityId:customerId};},
      async lookupCompleted(){return {ok:false,code:'NO_RECEIPT'};},
    }});
  const result=await tools.execute('workspaceData',{operation:'update',table:'customers',
    filters:[{column:'name',operator:'eq',value:'Northstar'}],values:{name:'Northstar LLC'}});

  assert.equal(result.ok,true);
  assert.equal(adapterInput.workspaceId,scope.workspaceId);
  assert.equal(adapterInput.ownerId,scope.ownerId);
  assert.equal(adapterInput.phone,scope.phone);
  assert.equal(adapterInput.providerMessageId,'wamid.direct-owner');
  assert.deepEqual(adapterInput.authorization,{kind:'instruction',quote:message});
  assert.equal(adapterInput.targetId,customerId);
  assert.ok(supabase.calls.find(call=>call.kind==='query'&&call.table==='customers').filters
    .some(([column,operator,value])=>column==='workspace_id'&&operator==='eq'&&value===scope.workspaceId));

  const denied=await tools.execute('workspaceData',{operation:'update',table:'customers',
    filters:[{column:'name',operator:'eq',value:'Northstar'}],values:{name:'Northstar LLC',workspace_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}});
  assert.equal(denied.ok,false);
  assert.equal(adapterInput.providerMessageId,'wamid.direct-owner','forged scope fields must not reach the write adapter');
});

test('workspaceData SQL migration scopes proposals, applies a confirmed customer write once, and replays its receipt',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create table public.workspaces(id uuid primary key);
      create table public.owner_test_bindings(workspace_id uuid,owner_id uuid,customer_id uuid,phone text,business_name text);
      create table public.whatsapp_pending_actions(
        id bigserial primary key,workspace_id uuid not null,customer_id uuid not null,phone text not null,
        action jsonb not null,source text not null,created_at timestamptz not null default now(),
        consumed_at timestamptz,version bigint not null default 1,generation bigint not null default 1,expires_at timestamptz);
      create unique index whatsapp_pending_actions_active_scope_idx
        on public.whatsapp_pending_actions(workspace_id,customer_id,phone) where consumed_at is null;
      create table public.whatsapp_inbound_events(
        provider_message_id text primary key,sender_phone text not null,status text not null,
        message_text text not null default '',received_at timestamptz not null default now(),provider_timestamp timestamptz);
      create table public.whatsapp_owner_action_receipts(
        provider_message_id text primary key,workspace_id uuid not null,owner_id uuid not null,phone text not null,
        action_id bigint,result jsonb not null,created_at timestamptz not null default now());
      create table public.customers(
        id uuid primary key default gen_random_uuid(),workspace_id uuid not null,name text not null,
        company_name text,email text,phone text,metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),updated_at timestamptz not null default now());
      create table public.workspace_settings(
        workspace_id uuid primary key,business_name text,default_currency text not null default 'INR',
        default_timezone text not null default 'Asia/Kolkata',updated_at timestamptz not null default now());
      create table public.workspace_ai_settings(
        workspace_id uuid primary key,primary_model text not null,fallback_model text,
        updated_at timestamptz not null default now());
      create table public.invoices(workspace_id uuid,customer_id uuid);
      create function public.whatsapp_resolve_verified_owner(p_phone text)
        returns table(workspace_id uuid,owner_id uuid,customer_id uuid,business_name text)
        language sql stable security definer set search_path=''
        as $$select b.workspace_id,b.owner_id,b.customer_id,b.business_name
          from public.owner_test_bindings b where b.phone=p_phone$$;
      create function public.whatsapp_store_pending_action(
        p_workspace_id uuid,p_customer_id uuid,p_phone text,p_action jsonb,p_source text,
        p_expected_generation bigint,p_expected_id bigint,p_expected_version bigint)
        returns table(id bigint,version bigint,generation bigint,action jsonb)
        language sql security definer set search_path=''
        as $$select null::bigint,null::bigint,null::bigint,null::jsonb where false$$;
    `);
    const sql=await readFile(new URL('../supabase/migrations/20261002161928_whatsapp_workspace_data.sql',import.meta.url),'utf8');
    await db.exec(sql);
    const otherWorkspace='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const owner='11111111-1111-4111-8111-111111111111';
    const ownerContact='22222222-2222-4222-8222-222222222222';
    const foreignCustomer='33333333-3333-4333-8333-333333333333';
    const phone='+919871367051';
    await db.query('insert into auth.users(id) values($1)',[owner]);
    await db.query('insert into public.workspaces(id) values($1),($2)',[scope.workspaceId,otherWorkspace]);
    await db.query('insert into public.owner_test_bindings values($1,$2,$3,$4,$5)',
      [scope.workspaceId,owner,ownerContact,phone,'Test Business']);
    await db.query('insert into public.whatsapp_inbound_events(provider_message_id,sender_phone,status,message_text) values($1,$2,$3,$4)',
      ['req-create',phone,'processing','Add customer NewCo']);
    await db.query('insert into public.customers(id,workspace_id,name) values($1,$2,$3)',
      [foreignCustomer,otherWorkspace,'Foreign customer']);
    await db.query('insert into public.workspace_settings(workspace_id,business_name) values($1,$2)',
      [scope.workspaceId,'Test Business']);

    await db.exec('set role service_role');
    const proposed=(await db.query(`select public.whatsapp_workspace_data_propose(
      $1,$2,$3,$4,'create','customers',null,null,$5::jsonb,$6,0,null,null) as value`,
      [scope.workspaceId,ownerContact,phone,'req-create',JSON.stringify({name:'NewCo'}),'Create customer NewCo'])).rows[0].value;
    assert.equal(proposed.ok,true);
    // The service role can call the narrowly granted RPCs, while fixture inspection
    // uses the test owner connection because pending-action rows are not readable.
    await db.exec('reset role');
    const pending=(await db.query(`select * from public.whatsapp_pending_actions
      where workspace_id=$1 and customer_id=$2 and consumed_at is null`,[scope.workspaceId,ownerContact])).rows[0];
    assert.equal(pending.action.type,'owner_workspace_data_change');
    const proposalId=pending.action.proposalId;

    // A foreign workspace or a customer row owned by another workspace cannot be targeted.
    await db.exec('set role service_role');
    const attacked=(await db.query(`select public.whatsapp_workspace_data_propose(
      $1,$2,$3,$4,'update','customers',$5,now(),'{"name":"Hijacked"}'::jsonb,$6,1,$7,$8) as value`,
      [otherWorkspace,ownerContact,phone,'req-create',foreignCustomer,'Change foreign customer',pending.id,pending.version])).rows[0].value;
    assert.equal(attacked.reason,'unbound');
    await db.exec('reset role');
    await db.query('insert into public.whatsapp_inbound_events(provider_message_id,sender_phone,status,message_text) values($1,$2,$3,$4)',
      ['confirm-create',phone,'processing','yes']);
    await db.exec('set role service_role');
    const applied=(await db.query(`select public.whatsapp_workspace_data_confirm(
      $1,$2,$3,$4,$5,$6,$7,null,'yes') as value`,
      [scope.workspaceId,ownerContact,phone,pending.id,pending.version,proposalId,'confirm-create'])).rows[0].value;
    assert.equal(applied.ok,true);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as count from public.customers where workspace_id=$1 and name=$2',
      [scope.workspaceId,'NewCo'])).rows[0].count,1);

    await db.exec('set role service_role');
    const replay=(await db.query(`select public.whatsapp_workspace_data_confirm(
      $1,$2,$3,null,null,null,$4,null,'yes') as value`,
      [scope.workspaceId,ownerContact,phone,'confirm-create'])).rows[0].value;
    assert.equal(replay.ok,true);
    assert.equal(replay.replayed,true);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as count from public.customers where workspace_id=$1 and name=$2',
      [scope.workspaceId,'NewCo'])).rows[0].count,1);
  } finally {
    await db.close();
  }
});
