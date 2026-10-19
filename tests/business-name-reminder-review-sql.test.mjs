import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

const migration='20261019102614_business_name_reminder_review.sql';
const sql=await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8');

async function setup(){
  const f=await createOfflineSqlNetwork({excludeMigrations:[migration]});
  const owner=randomUUID(),stranger=randomUUID();
  await f.db.query('insert into auth.users(id) values($1),($2)',[owner,stranger]);
  async function workspace(actor,label){
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
    return (await f.db.query('select (public.create_workspace($1,$2)).id',[label,randomUUID()])).rows[0].id;
  }
  const ws=await workspace(owner,'QA Rename Studio'),other=await workspace(stranger,'QA Other');
  let number=0;
  async function invoice({workspaceId=ws,status='sent',state='active',body='Reviewed — QA Rename Studio'}={}){
    const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'QA Rename Customer') returning id",[workspaceId])).rows[0].id;
    return (await f.db.query(`insert into invoices(workspace_id,invoice_number,issue_date,due_date,total_amount,status,metadata,customer_id)
      values($1,$2,current_date-2,current_date-1,100,$3,jsonb_build_object('invoice_direction','receivable',
      'followup_state',$4::text,'approved_reminder_text',$5::text,'approved_preferences_updated_at',
      (select updated_at from workspace_settings where workspace_id=$1),'qa_fixture',true),$6) returning id`,
    [workspaceId,`QA-RENAME-${++number}`,status,state,body,customer])).rows[0].id;
  }
  const snapshot=async()=>{
    const role=(await f.db.query('select current_user role')).rows[0].role;
    await f.db.exec('reset role');
    const rows=(await f.db.query('select id,to_jsonb(i) value from invoices i order by id')).rows;
    await f.db.exec(`set role ${role}`);return rows;
  };
  const impact=async(name='QA New')=>(await f.supabase.rpc('business_name_change_impact',{p_workspace_id:ws,p_business_name:name})).data;
  const asOwner=async(actor=owner)=>{
    await f.db.exec('reset role');await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
    await f.db.exec("set request.jwt.claim.role='authenticated';set role authenticated");
  };
  return {...f,owner,stranger,ws,other,invoice,snapshot,impact,asOwner};
}

test('function-only migration is safe to reapply, preserves ACLs, and never backfills invoices',async()=>{
  const f=await setup();try{
    await f.invoice();const before=await f.snapshot();
    const signature='public.whatsapp_confirm_owner_create_settings(uuid,uuid,text,bigint,bigint,text)';
    const acl=async()=>(await f.db.query('select proacl::text as acl from pg_proc where oid=$1::regprocedure',[signature])).rows[0].acl;
    const beforeAcl=await acl();
    await f.db.exec(sql);assert.deepEqual(await f.snapshot(),before);assert.equal(await acl(),beforeAcl);
    const first=(await f.db.query('select pg_get_functiondef($1::regprocedure) as def',[signature])).rows[0].def;
    await f.db.exec(sql);assert.deepEqual(await f.snapshot(),before);assert.equal(await acl(),beforeAcl);
    assert.equal((await f.db.query('select pg_get_functiondef($1::regprocedure) as def',[signature])).rows[0].def,first);
    await f.db.exec('set role anon');
    await assert.rejects(f.db.query('select public.business_name_change_impact($1,$2)',[f.ws,'QA New']),e=>e.code==='42501');
  }finally{await f.close();}
});

test('count and rename cover sent, non-deleted approvals only; same name and empty workspaces report zero; RLS isolates tenants',async()=>{
  const f=await setup();try{
    const affected=[await f.invoice(),await f.invoice({state:'paused'}),await f.invoice({state:'draft'})];
    await f.invoice({state:'draft',body:null});await f.invoice({state:'draft',body:''});await f.invoice({state:'draft',body:'   '});
    await f.invoice({status:'draft',state:'draft'});await f.invoice({status:'void'});await f.invoice({status:'paid'});await f.invoice({workspaceId:f.other});
    const deleted=await f.invoice();
    // Isolated QA fixture only: simulate an already soft-deleted invoice without
    // exercising the unrelated owner deletion confirmation flow.
    await f.db.exec('begin');
    await f.db.query('insert into app.invoice_lifecycle_write_context values(pg_backend_pid(),txid_current(),$1)',[deleted]);
    await f.db.query('update invoices set deleted_at=now(),deleted_by=$2 where id=$1',[deleted,f.owner]);
    await f.db.exec('commit');
    await f.db.exec(sql);await f.asOwner();
    assert.equal((await f.impact()).pausedReminderCount,3);
    assert.equal((await f.impact(' QA Rename Studio ')).pausedReminderCount,0);
    const before=await f.snapshot();
    const preview=await f.impact();
    const saved=await f.supabase.rpc('save_business_name_change',{p_workspace_id:f.ws,p_expected_updated_at:preview.updatedAt,
      p_business_name:'QA New',p_default_currency:'INR',p_default_timezone:'Asia/Kolkata'});
    assert.equal(saved.error,null,JSON.stringify(saved.error));assert.equal(saved.data.pausedReminderCount,3);
    const after=await f.snapshot();
    for(const {id,value} of after){
      if(!affected.includes(id))assert.deepEqual(value,before.find(row=>row.id===id).value,id);
      else{
        assert.equal(value.followup_state,'draft');assert.equal(value.next_follow_up_at,null);
        assert.equal(value.metadata.approved_reminder_text,null);assert.equal(value.metadata.approved_preferences_updated_at,null);
        assert.equal(value.metadata.followup_review_reason,'business_name_change');
        assert.match(value.metadata.followup_review_notice,/Needs re-approval after business name change/);
        assert.equal(value.metadata.followup_review_settings_updated_at,saved.data.settings.updated_at);
        for(const field of ['status','total_amount','amount_paid','invoice_number'])assert.equal(value[field],before.find(row=>row.id===id).value[field]);
      }
    }
    assert.equal((await f.impact('QA Another')).pausedReminderCount,0);
    await f.asOwner(f.stranger);
    await assert.rejects(f.db.query('select public.business_name_change_impact($1,$2)',[f.ws,'QA Foreign']),e=>e.code==='42501');
    await assert.rejects(f.db.query('select public.save_business_name_change($1,$2,$3,$4,$5)',[f.ws,saved.data.settings.updated_at,'QA Foreign','INR','UTC']),e=>e.code==='42501');
    const empty=await f.supabase.rpc('business_name_change_impact',{p_workspace_id:f.other,p_business_name:'QA Other'});
    assert.equal(empty.data.pausedReminderCount,0);
  }finally{await f.close();}
});

test('unchanged name preserves invoice state; a stale Settings confirmation fails before rename',async()=>{
  const f=await setup();try{
    await f.db.exec(sql);assert.equal((await f.impact()).pausedReminderCount,0);
    await f.invoice();await f.asOwner();
    const before=await f.snapshot(),preview=await f.impact('QA Rename Studio');
    const args=[f.ws,preview.updatedAt,'QA Rename Studio','INR','Asia/Kolkata'];
    const saved=(await f.db.query('select public.save_business_name_change($1,$2,$3,$4,$5) value',args)).rows[0].value;
    assert.equal(saved.pausedReminderCount,0);assert.deepEqual(await f.snapshot(),before);
    args[2]='QA New';
    await assert.rejects(f.db.query('select public.save_business_name_change($1,$2,$3,$4,$5)',args),e=>e.code==='40001');
    assert.deepEqual(await f.snapshot(),before);
    assert.equal((await f.db.query('select business_name from workspace_settings where workspace_id=$1',[f.ws])).rows[0].business_name,'QA Rename Studio');
  }finally{await f.close();}
});
