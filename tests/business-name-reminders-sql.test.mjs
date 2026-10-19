import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

const migration='20261019090000_business_name_reminder_reapproval.sql';
test('rename migration is repeatable without backfill; count and review transition are tenant scoped',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[migration]});const {db}=f;
 try{
  const owner=randomUUID(),stranger=randomUUID();await db.query('insert into auth.users(id) values($1),($2)',[owner,stranger]);
  async function workspace(user,name){
   await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${user}';set role authenticated`);
   const id=(await db.query('select (public.create_workspace($1,$2)).id',[name,randomUUID()])).rows[0].id;await db.exec('reset role');return id;
  }
  const ws=await workspace(owner,'QA Studio'),foreign=await workspace(stranger,'QA Other');
  async function invoice(label,{workspaceId=ws,state='paused',text='Reviewed',status='sent',deleted=false}={}){
   const customer=(await db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[workspaceId,label])).rows[0].id;
   const row=(await db.query(`insert into invoices(customer_id,workspace_id,invoice_number,issue_date,due_date,total_amount,status,metadata)
    values($5,$1,$2,current_date-2,current_date-1,100,$3,$4) returning id`,[workspaceId,label,status,JSON.stringify({invoice_direction:'receivable',followup_state:state,
    approved_reminder_text:text,approved_preferences_updated_at:'2026-01-01T00:00:00Z',custom_fixture:'retained'}),customer])).rows[0];
   if(deleted){
    await db.exec('begin');
    await db.query('insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id) values(pg_backend_pid(),txid_current(),$1)',[row.id]);
    await db.query('update invoices set deleted_at=now(),deleted_by=$2 where id=$1',[row.id,owner]);
    await db.exec('delete from app.invoice_lifecycle_write_context;commit');
   }return row.id;
  }
  const affected=[await invoice('QA-PAUSED'),await invoice('QA-APPROVED',{state:'approved',text:'Reviewed\n\nQA Studio'})];
  const untouched=[await invoice('QA-EMPTY',{text:''}),await invoice('QA-WHITESPACE',{text:'   '}),await invoice('QA-NONE',{text:null}),
   await invoice('QA-DELETED',{deleted:true}),await invoice('QA-DRAFT',{status:'draft'}),await invoice('QA-PAID',{status:'paid'}),await invoice('QA-VOID',{status:'void'}),
   await invoice('QA-FOREIGN',{workspaceId:foreign})];
  async function all(){return (await db.query('select * from invoices order by id')).rows}
  const before=await all(),sql=await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);assert.deepEqual(await all(),before);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  async function count(id){return (await db.query('select public.business_name_reminder_pause_count($1) n',[id])).rows[0].n}
  assert.equal(await count(ws),2);assert.equal(await count(foreign),0);
  await db.query("update workspace_settings set business_name='QA Studio' where workspace_id=$1",[ws]);
  assert.deepEqual(await all(),before.filter(row=>row.workspace_id===ws&&!row.deleted_at));
  await db.query("update workspace_settings set business_name='QA Renamed Studio' where workspace_id=$1",[ws]);
  assert.equal(await count(ws),0);await db.exec('reset role');
  for(const row of await all()){
   const old=before.find(r=>r.id===row.id);
   if(untouched.includes(row.id)){assert.deepEqual(row,old);continue}
   assert.ok(affected.includes(row.id));assert.equal(row.followup_state,'paused');assert.equal(row.next_follow_up_at,null);
   assert.equal(row.metadata.approved_reminder_text,null);assert.equal(row.metadata.approved_preferences_updated_at,null);
   assert.equal(row.metadata.reminder_review_reason,'business_name_changed');assert.equal(row.metadata.custom_fixture,'retained');
   for(const field of ['total_amount','amount_paid','status','invoice_number','deleted_at'])assert.deepEqual(row[field],old[field]);
  }
  // Existing owner-review mechanism permits an explicit fresh approval.
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  await db.query(`update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',E'Fresh review\n\nQA Renamed Studio',
   'approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$2)) where id=$1`,[affected[0],ws]);
  assert.equal((await db.query('select followup_state from invoices where id=$1',[affected[0]])).rows[0].followup_state,'approved');
  await db.exec('reset role;set role anon');await assert.rejects(count(ws),/permission denied/);
 }finally{await f.close()}
});
