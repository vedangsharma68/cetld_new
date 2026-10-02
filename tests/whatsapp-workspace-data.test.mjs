import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {VERIFIED_MODEL_CATALOG} from '../ai/provider.mjs';

const scope = Object.freeze({
  workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownerId:'11111111-1111-4111-8111-111111111111',
  customerId:'22222222-2222-4222-8222-222222222222',
  phone:'+919871367051',
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
  assert.equal(supabase.calls[0].selected,'name,email,phone');
  assert.deepEqual(result.rows,[{name:'Northstar',email:'billing@northstar.test',phone:'+919999999999'}]);
  assert.doesNotMatch(JSON.stringify(result),/api_key|workspace_id|33333333/);
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
  assert.deepEqual(seen.catalog.tables.invoices.writeValueConstraints.update.status,['paid']);
  assert.ok(seen.catalog.tables.workspace_settings.writeFields.update.includes('business_name'));
  assert.ok(seen.catalog.tables.workspace_settings.writeFields.update.includes('follow_up_preferences'));
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
