import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';

const workspaceDataMigration=await readFile(new URL('../supabase/migrations/20261002161928_whatsapp_workspace_data.sql',import.meta.url),'utf8');

const scope=Object.freeze({
  workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownerId:'11111111-1111-4111-8111-111111111111',
  customerId:'22222222-2222-4222-8222-222222222222',
  phone:'+919871367051',
});

function database({tables={}}={}) {
  const calls=[];
  const supabase={
    calls,
    from(table) {
      const call={kind:'query',table,selected:null,filters:[],limit:null,order:null};
      calls.push(call);
      const query={
        select(columns) {call.selected=columns;return query;},
        eq(column,value) {call.filters.push([column,'eq',value]);return query;},
        neq(column,value) {call.filters.push([column,'neq',value]);return query;},
        gt(column,value) {call.filters.push([column,'gt',value]);return query;},
        gte(column,value) {call.filters.push([column,'gte',value]);return query;},
        lt(column,value) {call.filters.push([column,'lt',value]);return query;},
        lte(column,value) {call.filters.push([column,'lte',value]);return query;},
        ilike(column,value) {call.filters.push([column,'ilike',value]);return query;},
        in(column,value) {call.filters.push([column,'in',value]);return query;},
        is(column,value) {call.filters.push([column,'is',value]);return query;},
        order(column,options) {call.order=[column,options];return query;},
        limit(value) {call.limit=value;return query;},
        maybeSingle() {return Promise.resolve({data:selectRows(call)[0]??null,error:null});},
        then(resolve,reject) {return Promise.resolve({data:selectRows(call),error:null}).then(resolve,reject);},
      };
      return query;
    },
    async rpc(name,args) {calls.push({kind:'rpc',name,args});return {data:{ok:true},error:null};},
  };
  function selectRows(call) {
    const fieldValue=(row,column)=>call.table==='invoices'&&column==='customer.name'
      ?(tables.customers||[]).find(customer=>customer.workspace_id===row.workspace_id&&customer.id===row.customer_id)?.name:row[column];
    let rows=[...(tables[call.table]||[])].filter(row=>call.filters.every(([column,operator,value])=>{
      const actual=fieldValue(row,column)??null;
      if(operator==='eq')return actual===value;
      if(operator==='neq')return actual!==value;
      if(operator==='is')return actual===value;
      if(operator==='in')return Array.isArray(value)&&value.includes(actual);
      if(operator==='gt')return actual>value;
      if(operator==='gte')return actual>=value;
      if(operator==='lt')return actual<value;
      if(operator==='lte')return actual<=value;
      if(operator==='ilike') {
        if(typeof actual!=='string'||typeof value!=='string')return false;
        const fragment=value.replaceAll('%','').toLowerCase();
        return actual.toLowerCase().includes(fragment);
      }
      return false;
    }));
    if(call.order) {
      const [column,options]=call.order;
      rows.sort((a,b)=>String(a[column]??'').localeCompare(String(b[column]??''))*(options?.ascending===false?-1:1));
    }
    if(call.limit!==null)rows=rows.slice(0,call.limit);
    const columns=call.selected?.split(',').map(column=>column.trim())||[];
    return rows.map(row=>{
      const output={};
      for(const column of columns){
        if(column.startsWith('customer:customers!')){
          const customer=(tables.customers||[]).find(item=>item.workspace_id===row.workspace_id&&item.id===row.customer_id);
          output.customer=customer?{name:customer.name}:null;
        } else if(Object.hasOwn(row,column))output[column]=row[column];
      }
      return output;
    });
  }
  return supabase;
}
function createTool(supabase,overrides={}) {
  return createWorkspaceDataTool({supabase,scope,authorize:async()=>true,...overrides});
}

test('authorization is rechecked before any database access and all read joins pin the verified workspace',async()=>{
  const db=database({tables:{
    invoices:[{id:'33333333-3333-4333-8333-333333333333',workspace_id:scope.workspaceId,customer_id:'44444444-4444-4444-8444-444444444444',invoice_number:'INV-1',deleted_at:null}],
    customers:[{id:'44444444-4444-4444-8444-444444444444',workspace_id:scope.workspaceId,name:'Northstar'}],
    payments:[{workspace_id:scope.workspaceId,invoice_id:'33333333-3333-4333-8333-333333333333',amount:12,paid_at:'2026-10-01T00:00:00Z'}],
  }});
  const denied=createTool(db,{authorize:async()=>false});
  const rejection=await denied.execute({operation:'read',table:'invoices',columns:['invoice_number']});
  assert.equal(rejection.code,'DENIED');
  assert.deepEqual(db.calls,[]);

  const allowed=createTool(db);
  const invoice=await allowed.execute({operation:'read',table:'invoices',columns:['invoice_number','customer_name']});
  assert.equal(invoice.ok,true);
  const payments=await allowed.execute({operation:'read',table:'payments',columns:['invoice_number','amount']});
  assert.equal(payments.ok,true);
  assert.equal(db.calls.filter(call=>call.kind==='query'&&call.table==='invoices').length,2,
    'invoice display names come from the invoice join and payment labels use one scoped invoice read');
  assert.equal(db.calls.filter(call=>call.kind==='query'&&call.table==='customers').length,0,
    'invoice customer names are included in the joined invoice read');
  for(const call of db.calls.filter(call=>call.kind==='query')) {
    assert.ok(call.filters.some(([column,operator,value])=>column==='workspace_id'&&operator==='eq'&&value===scope.workspaceId),
      'query to '+call.table+' must be pinned to the server-owned workspace');
  }
  assert.doesNotMatch(JSON.stringify([invoice,payments]),/workspace_id|owner_id|customer_id|invoice_id|33333333|44444444/);
});

test('raw follow-up preferences cannot disclose arbitrary owner phone or message content',async()=>{
  const db=database({tables:{
    workspace_settings:[{workspace_id:scope.workspaceId,business_name:'Northstar',follow_up_preferences:{
      owner_phone:'+919999999999',approvedMessage:'Private payment reminder for ACME 42',dailySummary:true,
    }}],
  }});
  const tool=createTool(db);
  const result=await tool.execute({operation:'read',table:'workspace_settings',columns:['follow_up_preferences']});
  const encoded=JSON.stringify(result);
  assert.ok(result.ok===false||!encoded.includes('+919999999999'));
  assert.ok(result.ok===false||!encoded.includes('Private payment reminder'));
});

test('payments and file metadata linked to deleted or foreign invoices are never returned',async()=>{
  const activeId='33333333-3333-4333-8333-333333333333';
  const deletedId='44444444-4444-4444-8444-444444444444';
  const foreignId='55555555-5555-4555-8555-555555555555';
  const foreignWorkspace='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const db=database({tables:{
    invoices:[
      {id:activeId,workspace_id:scope.workspaceId,invoice_number:'ACTIVE-1',deleted_at:null},
      {id:deletedId,workspace_id:scope.workspaceId,invoice_number:'DELETED-1',deleted_at:'2026-09-30T00:00:00Z'},
      {id:foreignId,workspace_id:foreignWorkspace,invoice_number:'FOREIGN-1',deleted_at:null},
    ],
    payments:[
      {workspace_id:scope.workspaceId,invoice_id:activeId,amount:15,paid_at:'2026-10-01T00:00:00Z'},
      {workspace_id:scope.workspaceId,invoice_id:deletedId,amount:900,paid_at:'2026-10-01T00:00:00Z'},
      {workspace_id:scope.workspaceId,invoice_id:foreignId,amount:9900,paid_at:'2026-10-01T00:00:00Z'},
      {workspace_id:foreignWorkspace,invoice_id:foreignId,amount:99900,paid_at:'2026-10-01T00:00:00Z'},
    ],
    invoice_files:[
      {workspace_id:scope.workspaceId,invoice_id:activeId,file_name:'active.pdf',mime_type:'application/pdf',size_bytes:100},
      {workspace_id:scope.workspaceId,invoice_id:deletedId,file_name:'deleted-private.pdf',mime_type:'application/pdf',size_bytes:200},
      {workspace_id:scope.workspaceId,invoice_id:foreignId,file_name:'foreign-parent.pdf',mime_type:'application/pdf',size_bytes:300},
      {workspace_id:foreignWorkspace,invoice_id:foreignId,file_name:'foreign-workspace.pdf',mime_type:'application/pdf',size_bytes:400},
    ],
  }});
  const tool=createTool(db);
  const payments=await tool.execute({operation:'read',table:'payments',columns:['invoice_number','amount']});
  const files=await tool.execute({operation:'read',table:'invoice_files',columns:['invoice_number','file_name','size_bytes']});
  assert.equal(payments.ok,true);
  assert.deepEqual(payments.rows,[{amount:15,invoice_number:'ACTIVE-1'}]);
  assert.equal(files.ok,true);
  assert.deepEqual(files.rows,[{file_name:'active.pdf',size_bytes:100,invoice_number:'ACTIVE-1'}]);
  assert.doesNotMatch(JSON.stringify([payments,files]),/900|9900|99900|deleted-private|foreign-/);
});

test('multiple relational filters cannot silently discard all but the first constraint',async()=>{
  const firstId='33333333-3333-4333-8333-333333333333';
  const secondId='44444444-4444-4444-8444-444444444444';
  const db=database({tables:{
    invoices:[
      {id:firstId,workspace_id:scope.workspaceId,invoice_number:'INV-A',deleted_at:null},
      {id:secondId,workspace_id:scope.workspaceId,invoice_number:'INV-B',deleted_at:null},
    ],
    payments:[
      {workspace_id:scope.workspaceId,invoice_id:firstId,amount:15,paid_at:'2026-10-01T00:00:00Z'},
      {workspace_id:scope.workspaceId,invoice_id:secondId,amount:25,paid_at:'2026-10-01T00:00:00Z'},
    ],
  }});
  const tool=createTool(db);
  const result=await tool.execute({operation:'read',table:'payments',columns:['invoice_number','amount'],filters:[
    {column:'invoice_number',operator:'eq',value:'INV-A'},
    {column:'invoice_number',operator:'eq',value:'INV-B'},
  ]});
  assert.ok(result.ok===false||result.rows.length===0,
    'conflicting invoice filters should fail or yield no matches, never return first-filter rows');
});

test('schema, projection, operator, and scope injection attempts fail before reaching PostgREST',async()=>{
  const db=database();
  const tool=createTool(db);
  const attacks=[
    {operation:'read',table:'workspace_members',columns:['role']},
    {operation:'read',table:'customers',columns:['name,metadata']},
    {operation:'read',table:'customers',columns:['workspace_id']},
    {operation:'read',table:'invoice_files',columns:['storage_path']},
    {operation:'read',table:'invoices',filters:[{column:'metadata->>assistant_idempotency_key',operator:'eq',value:'x'}]},
    {operation:'read',table:'customers',filters:[{column:'workspace_id',operator:'eq',value:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]},
    {operation:'read',table:'customers',filters:[{column:'name',operator:'or',value:'(workspace_id.eq.bbbbbbbbbbbb)'}]},
    {operation:'read',table:'invoices',order:{column:'metadata',direction:'asc'}},
    {operation:'read',table:'customers',columns:['name'],values:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},
  ];
  for(const attack of attacks) {
    const result=await tool.execute(attack);
    assert.equal(result.ok,false,JSON.stringify(attack));
    assert.notEqual(result.ok,true,JSON.stringify(attack));
  }
  assert.deepEqual(db.calls,[]);
});


test('confirmation RPC receives only scope and pending action identity captured by the server',async()=>{
  const proposalId='99999999-9999-4999-8999-999999999999';
  const db=database();
  const tool=createTool(db,{
    message:'yes',
    messageId:'wamid.owner-confirm',
    pendingAtStart:{
      id:73,version:4,workspace_id:scope.workspaceId,customer_id:scope.customerId,phone:scope.phone,
      action:{type:'owner_workspace_data_change',proposalId,requestMessageId:'wamid.owner-request'},
    },
  });
  const result=await tool.execute({operation:'confirm'});
  assert.equal(result.ok,true);
  const call=db.calls.find(item=>item.kind==='rpc');
  assert.equal(call.name,'whatsapp_workspace_data_confirm');
  assert.equal(call.args.p_workspace_id,scope.workspaceId);
  assert.equal(call.args.p_customer_id,scope.customerId);
  assert.equal(call.args.p_phone,scope.phone);
  assert.equal(call.args.p_pending_id,73);
  assert.equal(call.args.p_pending_version,4);
  assert.equal(call.args.p_proposal_id,proposalId);
  assert.equal(call.args.p_confirmation_message_id,'wamid.owner-confirm');
  assert.equal(call.args.p_user_message,'yes');
  assert.equal(Object.hasOwn(call.args,'p_owner_id'),false,'the database must derive the owner from the verified phone binding');
});

test('model-supplied confirmation scope and pending identifiers are rejected before RPC',async()=>{
  const db=database();
  const tool=createTool(db,{
    message:'yes',
    messageId:'wamid.owner-confirm',
    pendingAtStart:{id:73,version:4,action:{type:'owner_workspace_data_change',proposalId:'99999999-9999-4999-8999-999999999999',requestMessageId:'wamid.owner-request'}},
  });
  const result=await tool.execute({operation:'confirm',workspace_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',pending_id:999});
  assert.notEqual(result.ok,true);
  assert.deepEqual(db.calls,[]);
});


test('a revoked owner binding between base read and customer join suppresses the entire answer',async()=>{
  const db=database({tables:{
    invoices:[{id:'33333333-3333-4333-8333-333333333333',workspace_id:scope.workspaceId,
      customer_id:'44444444-4444-4444-8444-444444444444',invoice_number:'INV-1',deleted_at:null}],
    customers:[{id:'44444444-4444-4444-8444-444444444444',workspace_id:scope.workspaceId,name:'Northstar'}],
  }});
  let authCalls=0;
  const tool=createTool(db,{authorize:async()=>++authCalls<3});
  const result=await tool.execute({operation:'read',table:'invoices',columns:['invoice_number','customer_name']});
  assert.ok(result.ok===false||result.rows.length===0,
    'a binding revoked during a multi-query read must not return invoice data');
  assert.ok(authCalls>=3,'owner binding should be checked again at the relationship query boundary');
});


test('a foreign workspace record ID cannot escape the server-pinned tenant predicate',async()=>{
  const foreignWorkspace='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const foreignId='55555555-5555-4555-8555-555555555555';
  const db=database({tables:{invoices:[{
    id:foreignId,workspace_id:foreignWorkspace,invoice_number:'FOREIGN-1',deleted_at:null,
  }]}});
  const tool=createTool(db);
  const result=await tool.execute({operation:'read',table:'invoices',columns:['invoice_number'],
    filters:[{column:'id',operator:'eq',value:foreignId}]});
  assert.equal(result.ok,true);
  assert.deepEqual(result.rows,[]);
  assert.ok(db.calls[0].filters.some(([column,operator,value])=>
    column==='workspace_id'&&operator==='eq'&&value===scope.workspaceId));
});


test('owner and workspace identifiers cannot be smuggled through values or natural-language requests',async()=>{
  const db=database();
  let plannerCalled=false;
  const tool=createTool(db,{planRequest:async()=>{plannerCalled=true;return {operation:'read',table:'customers'};}});
  for(const attack of [
    {operation:'read',table:'customers',columns:['name'],filters:[{column:'email',operator:'eq',value:scope.ownerId}]},
    {operation:'read',table:'customers',values:{owner_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},
    {request:'Read workspace '+scope.workspaceId},
  ]) {
    const result=await tool.execute(attack);
    assert.notEqual(result.ok,true);
  }
  assert.equal(plannerCalled,false);
  assert.deepEqual(db.calls,[]);
});

test('proposal SQL functions pin search_path and expose only the intended service-role RPCs',()=>{
  for(const name of ['propose','decide','confirm','cancel']) {
    const start=workspaceDataMigration.indexOf(`create or replace function public.whatsapp_workspace_data_${name}(`);
    assert.notEqual(start,-1,`${name} function exists`);
    const end=workspaceDataMigration.indexOf('$function$;',start);
    assert.ok(end>start,`${name} function has a closed body`);
    const body=workspaceDataMigration.slice(start,end);
    assert.match(body,/language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
      `${name} must be SECURITY DEFINER with an empty search_path`);
  }
  assert.match(workspaceDataMigration,/alter table public\.whatsapp_workspace_data_proposals enable row level security;\s*alter table public\.whatsapp_workspace_data_proposals force row level security;/i);
  assert.match(workspaceDataMigration,/revoke all on public\.whatsapp_workspace_data_proposals from public,\s*anon,\s*authenticated;/i);
  assert.match(workspaceDataMigration,/grant select,\s*insert,\s*update on public\.whatsapp_workspace_data_proposals to service_role;/i);
  assert.match(workspaceDataMigration,/revoke all on function public\.whatsapp_workspace_data_decide\([^;]+\)\s*from public,\s*anon,\s*authenticated,\s*service_role;/i);
  assert.doesNotMatch(workspaceDataMigration,/grant execute on function public\.whatsapp_workspace_data_decide\(/i,
    'the shared decision implementation stays unreachable as a direct RPC');
  for(const name of ['propose','confirm','cancel']) {
    assert.match(workspaceDataMigration,new RegExp(`grant execute on function public\\.whatsapp_workspace_data_${name}\\([\\s\\S]*?\\)\\s*to service_role;`,'i'));
  }
});

test('proposal confirmation binds a later inbound owner message to the scoped pending proposal',()=>{
  const decideStart=workspaceDataMigration.indexOf('create or replace function public.whatsapp_workspace_data_decide(');
  const decideEnd=workspaceDataMigration.indexOf('$function$;',decideStart);
  const decide=workspaceDataMigration.slice(decideStart,decideEnd);
  assert.match(decide,/whatsapp_resolve_verified_owner\(p_phone\)/i);
  assert.match(decide,/pg_advisory_xact_lock/i);
  assert.match(decide,/e\.provider_message_id\s*=\s*v_message_id\s+and e\.sender_phone\s*=\s*p_phone\s+and e\.status in \('processing','done'\)/i);
  assert.match(decide,/v_event\.message_text is distinct from p_user_message/i);
  assert.match(decide,/p\.workspace_id=p_workspace_id and p\.customer_id=p_customer_id and p\.phone=p_phone for update/i);
  assert.match(decide,/v_pending\.action->>'type' is distinct from 'owner_workspace_data_change'/i);
  assert.match(decide,/v_pending\.action->>'proposalId' is distinct from p_proposal_id::text/i);
  assert.match(decide,/p\.owner_id=v_owner\.owner_id\s+and p\.customer_id=p_customer_id and p\.phone=p_phone/i);
  assert.match(decide,/v_event\.received_at<v_pending\.created_at/i);
  assert.match(decide,/v_proposal\.request_message_id=v_message_id/i);
  assert.match(decide,/v_proposal\.expires_at<=v_now/i);
  assert.match(decide,/v_proposal\.expected_updated_at/i,'business-row changes retain their stale guard');
  assert.match(decide,/whatsapp_owner_action_receipts/i,'the mutation and replay receipt are written in the same database function');
});
