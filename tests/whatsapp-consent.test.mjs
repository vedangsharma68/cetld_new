import test from 'node:test';
import assert from 'node:assert/strict';
import {getSendEligibility, resolveActiveBindings, revokeConsentForPhone, suppressUnknownPhone} from '../automation/whatsapp/consent.mjs';

function fakeSupabase({consents=[],suppressions=[],globalSuppressions=[],customers=[],settings=consents.map(row=>({workspace_id:row.workspace_id,whatsapp_owner_attested_at:'2026-09-27T00:00:00.000Z'}))}={}) {
  const tables={whatsapp_consents:consents,whatsapp_suppressions:suppressions,whatsapp_global_suppressions:globalSuppressions,customers,workspace_settings:settings};
  const reads=[];
  const client={
    reads,
    from(table){
      const filters=[];
      const query={
        select(){reads.push(table);return query},
        eq(column,value){filters.push(row=>row[column]===value);return query},
        is(column,value){filters.push(row=>row[column]===value);return query},
        maybeSingle(){return Promise.resolve({data:tables[table].find(row=>filters.every(filter=>filter(row)))||null,error:null})},
        then(resolve,reject){return Promise.resolve({data:tables[table].filter(row=>filters.every(filter=>filter(row))),error:null}).then(resolve,reject)},
      };
      return query;
    },
    async rpc(name,args){
      if(name==='whatsapp_suppress_unknown_phone'){
        const phone=args.p_phone;
        if(consents.some(row=>row.phone===phone))return {data:false,error:null};
        const prior=globalSuppressions.some(row=>row.phone===phone);
        if(!prior)globalSuppressions.push({phone,suppressed_at:new Date().toISOString()});
        return {data:!prior,error:null};
      }
      assert.equal(name,'whatsapp_revoke_phone');
      const {p_workspace_id:workspace,p_phone:phone,p_via:via}=args;
      if(!consents.some(row=>row.workspace_id===workspace&&row.phone===phone))return {data:[{revoked:false,confirmation_due:false}],error:null};
      const prior=suppressions.some(row=>row.workspace_id===workspace&&row.phone===phone);
      if(!prior)suppressions.push({workspace_id:workspace,phone,suppressed_at:new Date().toISOString(),reason:via});
      let revoked=false;
      for(const row of consents){if(row.workspace_id===workspace&&row.phone===phone&&!row.revoked_at){row.revoked_at=new Date().toISOString();row.revoked_via=via;revoked=true}}
      return {data:[{revoked,confirmation_due:!prior}],error:null};
    },
  };
  return client;
}

const phone='+919871367051';
const active={workspace_id:'workspace-1',phone,customer_id:'customer-1',categories:['invoice_updates'],source:'verbal',revoked_at:null};
const customer={id:'customer-1',workspace_id:'workspace-1',phone,name:'Client'};

test('send eligibility checks suppression first and rejects owner attestation alone',async()=>{
  const blocked=fakeSupabase({consents:[{...active}],customers:[customer],suppressions:[{workspace_id:'workspace-1',phone,suppressed_at:'now'}]});
  assert.equal((await getSendEligibility({supabase:blocked,workspaceId:'workspace-1',phone})).reason,'suppressed');
  assert.deepEqual(blocked.reads,['whatsapp_global_suppressions','whatsapp_suppressions']);
  const ownerOnly=fakeSupabase({consents:[{...active,source:'owner_attestation'}],customers:[customer]});
  assert.equal((await getSendEligibility({supabase:ownerOnly,workspaceId:'workspace-1',phone})).reason,'missing_recipient_opt_in');
  const invoiceLine=fakeSupabase({consents:[{...active,source:'invoice_line'}],customers:[customer]});
  assert.equal((await getSendEligibility({supabase:invoiceLine,workspaceId:'workspace-1',phone})).reason,'missing_recipient_opt_in');
  assert.deepEqual(await resolveActiveBindings({supabase:invoiceLine,phone}),[]);
});

test('active consent requires current customer phone and category',async()=>{
  const client=fakeSupabase({consents:[{...active}],customers:[customer]});
  assert.equal((await getSendEligibility({supabase:client,workspaceId:'workspace-1',phone})).allowed,true);
  assert.equal((await getSendEligibility({supabase:client,workspaceId:'workspace-1',phone,category:'marketing'})).reason,'category_not_consented');
  const changed=fakeSupabase({consents:[{...active}],customers:[{...customer,phone:'+919999999999'}]});
  assert.equal((await getSendEligibility({supabase:changed,workspaceId:'workspace-1',phone})).reason,'unbound');
  const noOwner=fakeSupabase({consents:[{...active}],customers:[customer],settings:[]});
  assert.equal((await getSendEligibility({supabase:noOwner,workspaceId:'workspace-1',phone})).allowed,true);
});

test('inbound bindings include only active, unsuppressed, matching customer records',async()=>{
  const client=fakeSupabase({consents:[{...active},{...active,workspace_id:'workspace-2',customer_id:'customer-2'}],customers:[customer,{id:'customer-2',workspace_id:'workspace-2',phone}]});
  assert.deepEqual((await resolveActiveBindings({supabase:client,phone})).map(row=>row.workspaceId),['workspace-1','workspace-2']);
  const suppressed=fakeSupabase({consents:[{...active},{...active,workspace_id:'workspace-2',customer_id:'customer-2'}],customers:[customer,{id:'customer-2',workspace_id:'workspace-2',phone}],suppressions:[{workspace_id:'workspace-1',phone}]});
  assert.deepEqual((await resolveActiveBindings({supabase:suppressed,phone})).map(row=>row.workspaceId),['workspace-2']);
  const wrongCategory=fakeSupabase({consents:[{...active,categories:['customer_service']}],customers:[customer]});
  assert.deepEqual(await resolveActiveBindings({supabase:wrongCategory,phone}),[]);
  const noOwner=fakeSupabase({consents:[{...active}],customers:[customer],settings:[]});
  assert.deepEqual((await resolveActiveBindings({supabase:noOwner,phone})).map(r=>r.workspaceId),['workspace-1']);
});

test('STOP revokes once and claims only one confirmation, scoped to workspace',async()=>{
  const client=fakeSupabase({consents:[{...active},{...active,workspace_id:'workspace-2',customer_id:'customer-2'}],customers:[customer]});
  assert.deepEqual(await revokeConsentForPhone({supabase:client,workspaceId:'workspace-1',phone,via:'stop',messageId:'wamid-1'}),{revoked:true,confirmationDue:true});
  assert.deepEqual(await revokeConsentForPhone({supabase:client,workspaceId:'workspace-1',phone,via:'stop',messageId:'wamid-1'}),{revoked:false,confirmationDue:false});
  assert.equal((await getSendEligibility({supabase:client,workspaceId:'workspace-1',phone})).reason,'suppressed');
  assert.equal((await resolveActiveBindings({supabase:client,phone})).length,0);
});

test('invalid phone fails closed before querying the database',async()=>{
  const client=fakeSupabase();
  await assert.rejects(getSendEligibility({supabase:client,workspaceId:'workspace-1',phone:'9871367051'}),/E.164/);
  assert.deepEqual(client.reads,[]);
});

test('unknown STOP is globally suppressed once and blocks a later consent',async()=>{
  const globalSuppressions=[];
  const client=fakeSupabase({globalSuppressions});
  assert.deepEqual(await suppressUnknownPhone({supabase:client,phone,messageId:'wamid-unknown'}),{confirmationDue:true});
  assert.deepEqual(await suppressUnknownPhone({supabase:client,phone,messageId:'wamid-unknown'}),{confirmationDue:false});
  assert.equal((await getSendEligibility({supabase:client,workspaceId:'workspace-1',phone})).reason,'globally_suppressed');
  assert.deepEqual(await resolveActiveBindings({supabase:client,phone}),[]);
  const known=fakeSupabase({consents:[{...active}]});
  assert.deepEqual(await suppressUnknownPhone({supabase:known,phone,messageId:'wamid-known'}),{confirmationDue:false});
});
