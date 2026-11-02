import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/private-invoice.mjs';
import {runPrivateInvoiceBackfill,privateBackfillBatchSQL} from '../scripts/backfill-private-invoice-terms.mjs';
import {createPrivateValueMatcher} from '../ai/private-value-matcher.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
const migrationName='20261101120327_private_whatsapp_chat_memory.sql';
const migration=()=>readFile(new URL('../supabase/migrations/'+migrationName,import.meta.url),'utf8');
const historical=()=>fixture({recording:true,sqlNetworkOptions:{excludeMigrations:[migrationName]}});
const batch=async(db,sql)=>{const result=await db.exec(sql);return result.find(item=>item.rows?.[0]?.result)?.rows[0].result;};
async function seed(f){
 const customer=(await f.db.query("insert into customers(workspace_id,name,company_name,email,phone) values($1,'Before & Sons','Before Company','before@example.test','+12025550666') returning id",[f.scope.workspaceId])).rows[0];
 const invoice=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R4-BACKFILL',1250,'INR','draft') returning id",[f.scope.workspaceId,customer.id])).rows[0];
 await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,'r4-old-quote','whatsapp','user','Here is the bill, Cedar Studio, 7500, due 12 Nov')",[f.scope.workspaceId,f.scope.ownerId]);
 await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,'user','Here is the receipt, Maple Studio, 8750, due 14 Nov')",[f.scope.workspaceId,f.scope.customerId,f.scope.phone]);
 return {customer,invoice};
}

test('staged DDL commits without backfill; bounded batches release source locks and preserve concurrent OLD/NEW values',async()=>{
 const f=await historical();try{
  const {customer}=await seed(f),sql=await migration();await f.db.exec(sql);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_private_invoice_terms')).rows[0].n,0,'DDL transaction does no full backfill');
  assert.ok((await f.db.query('select * from whatsapp_private_invoice_backfill')).rows.some(row=>!row.complete));
  assert.match(sql,/set local lock_timeout='1s'/);assert.match(sql,/set local statement_timeout='5s'/);
  const before=f.providerRecord.calls;assert.match((await f.turn('Tell me a joke')).answer,/temporarily unavailable/);assert.equal(f.providerRecord.calls,before);
  assert.match((await f.turn('What is my outstanding balance?')).answer,/INR 1250.00/);assert.equal(f.providerRecord.calls,before);
  const customerHandler=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:()=>assert.fail('incomplete backfill cannot access a model'),logger:{error(){}}});
  assert.match(await customerHandler({...f.scope,message:'Tell me a joke'}),/temporarily unavailable/);
  assert.match(await customerHandler({...f.scope,message:'menu'}),/outstanding balance/);
  // Mutation before the scanner reaches this customer must preserve both names.
  await f.db.query("update customers set name='After & Sons',company_name='After Company' where id=$1",[customer.id]);
  await f.db.exec(`create table app.r4_lock_samples(relation text,mode text);
   create function app.r4_capture_locks() returns trigger language plpgsql as $$begin
    if current_setting('app.r4_probe',true)='on' then
     insert into app.r4_lock_samples select c.relname,l.mode from pg_locks l join pg_class c on c.oid=l.relation
      where l.pid=pg_backend_pid() and l.granted and c.relname in ('invoices','customers','whatsapp_pending_actions','owner_assistant_turns','whatsapp_conversation_turns');
    end if;return new;end $$;
   create trigger r4_capture after insert on whatsapp_private_invoice_terms for each row execute function app.r4_capture_locks();`);
  const statuses=[];let concurrent=false;
  await runPrivateInvoiceBackfill({batchSize:1,execute:sql=>batch(f.db,sql.replace('select app.backfill',"set local app.r4_probe='on';select app.backfill")),onBatch:async status=>{
   statuses.push(status);assert.ok(status.rows<=1);
   // Each callback runs after COMMIT, with no transaction/source lock carried.
   const locks=(await f.db.query("select l.mode from pg_locks l join pg_class c on c.oid=l.relation where l.pid=pg_backend_pid() and c.relname in ('invoices','customers','whatsapp_pending_actions')")).rows;
   assert.equal(locks.length,0);
   if(!concurrent){concurrent=true;await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R4-CONCURRENT',2401,'INR','draft')",[f.scope.workspaceId,customer.id]);}
  }});
  assert.ok(statuses.length>=3);assert.equal(statuses.at(-1).allComplete,true);
  const observed=(await f.db.query('select distinct relation,mode from app.r4_lock_samples')).rows;assert.ok(observed.length>0);
  assert.ok(observed.every(row=>row.mode==='AccessShareLock'),JSON.stringify(observed));
  const aliases=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term),match=createPrivateValueMatcher(aliases);
  for(const value of ['Before and Sons','After and Sons','Before Company','After Company','before@example.test','+12025550666','1250','2401','Cedar Studio','7500','Maple Studio','8750'])assert.equal(match(value),true,value);
  const count=aliases.length;assert.equal((await runPrivateInvoiceBackfill({execute:sql=>batch(f.db,sql)})).allComplete,true);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_private_invoice_terms')).rows[0].n,count);
  assert.equal((await f.turn('Tell me a joke')).answer,'Summary');assert.equal(f.providerRecord.calls,before+1);
 }finally{await f.close();}
});

test('backfill batch failure rolls back aliases and cursor together; retry is idempotent',async()=>{
 const f=await historical();try{
  await seed(f);await f.db.exec(await migration());
  await f.db.exec("update whatsapp_private_invoice_backfill set complete=source<>'invoices'");
  await f.db.exec(`create function app.r4_fail_batch() returns trigger language plpgsql as $$begin if new.term='number:1250' then raise exception 'R4_TEST_FAILURE';end if;return new;end $$;
   create trigger r4_fail before insert on whatsapp_private_invoice_terms for each row execute function app.r4_fail_batch();`);
  const cursor=(await f.db.query("select * from whatsapp_private_invoice_backfill where source='invoices'")).rows[0];
  await assert.rejects(batch(f.db,privateBackfillBatchSQL(1)),/R4_TEST_FAILURE/);await f.db.exec('rollback');
  assert.deepEqual((await f.db.query("select * from whatsapp_private_invoice_backfill where source='invoices'")).rows[0],cursor);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_private_invoice_terms')).rows[0].n,0);
  await f.db.exec('drop trigger r4_fail on whatsapp_private_invoice_terms');
  await runPrivateInvoiceBackfill({execute:sql=>batch(f.db,sql),batchSize:1});
  assert.ok((await f.db.query("select * from whatsapp_private_invoice_terms where term='number:1250'")).rows.length);
 }finally{await f.close();}
});

test('privacy DDL rollback is atomic and every new helper/job/RPC retains restricted privileges',async()=>{
 const f=await historical();try{
  await seed(f);const sql=await migration();
  await assert.rejects(f.db.exec(sql.replace(/commit;\s*$/,'select 1/0;commit;')),/division by zero/);await f.db.exec('rollback');
  assert.equal((await f.db.query("select to_regclass('public.whatsapp_private_invoice_terms') present")).rows[0].present,null);
  assert.equal((await f.db.query("select to_regprocedure('app.private_invoice_normalize(text)') present")).rows[0].present,null);
  assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
  await f.db.exec(sql);
  const helpers=['private_invoice_lexical(text)','private_invoice_party_aliases(text)','private_invoice_normalize(text)','private_invoice_number_aliases(text)','private_invoice_group_number(text[])','private_invoice_word_number_value(text[])','private_invoice_word_number_aliases(text)','private_invoice_term_aliases(text)','private_invoice_evidence_aliases(text)','private_invoice_origin_aliases(text)'];
  for(const helper of helpers){
   const name='app.'+helper,meta=(await f.db.query('select provolatile,prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[name])).rows[0];
   assert.equal(meta.provolatile,'i');assert.equal(meta.prosecdef,false);assert.deepEqual(meta.proconfig,['search_path=""']);
   for(const role of ['anon','authenticated','service_role'])assert.equal((await f.db.query("select has_function_privilege($1,$2,'execute') ok",[role,name])).rows[0].ok,false);
  }
  for(const role of ['anon','authenticated','service_role'])assert.equal((await f.db.query("select has_function_privilege($1,'app.backfill_private_invoice_terms(integer)','execute') ok",[role])).rows[0].ok,false);
  for(const role of ['anon','authenticated']){
   assert.equal((await f.db.query("select has_function_privilege($1,'public.whatsapp_retain_private_chat_origin(uuid,text)','execute') ok",[role])).rows[0].ok,false);
   assert.equal((await f.db.query("select has_table_privilege($1,'public.whatsapp_private_invoice_backfill','select') ok",[role])).rows[0].ok,false);
  }
  assert.equal((await f.db.query("select relrowsecurity from pg_class where oid='public.whatsapp_private_invoice_backfill'::regclass")).rows[0].relrowsecurity,true);
  assert.equal((await f.db.query("select has_table_privilege('service_role','public.whatsapp_private_invoice_backfill','update') ok")).rows[0].ok,false);
  assert.throws(()=>privateBackfillBatchSQL(101));assert.throws(()=>privateBackfillBatchSQL(0));
 }finally{await f.close();}
});
