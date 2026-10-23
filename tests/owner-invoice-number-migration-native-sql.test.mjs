import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
const migration='20261023123810_preserve_explicit_owner_invoice_numbers.sql';

test('owner numbering migration preserves existing rows, routine privileges, payment capabilities and customer auto numbering',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[migration]}),{db}=f,ownerId=randomUUID();
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Numbering fixture','numbering-fixture')).id")).rows[0].id;
  const customerId=(await db.query("insert into customers(workspace_id,name) values($1,'Fixture customer') returning id",[workspaceId])).rows[0].id;
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const insert=async(number,metadata)=>(await db.query('insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,metadata) values($1,$2,$3,1500,\'INR\',$4) returning *',[workspaceId,customerId,number,metadata])).rows[0];
  const legacy=await insert('SOURCE-1',{invoice_direction:'receivable',printed_invoice_number:'SOURCE-1'});
  const functions=async()=>(await db.query("select oid::regprocedure::text signature,proowner,proacl,prosecdef,proconfig,md5(prosrc) body from pg_proc where proname in ('assign_consistent_invoice_number','whatsapp_apply_direct_owner_write','whatsapp_owner_payment_capabilities') order by oid::regprocedure::text")).rows;
  const before=await functions();
  const sql=await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8');
  await db.exec(sql);const after=await functions();
  for(let i=0;i<before.length;i++)assert.deepEqual({...after[i],body:before[i].body},before[i]);
  assert.deepEqual(after.filter(row=>!row.signature.startsWith('assign_consistent_invoice_number')),before.filter(row=>!row.signature.startsWith('assign_consistent_invoice_number')));
  await db.exec(sql);assert.deepEqual(await functions(),after,'migration reapplication is a no-op');
  assert.deepEqual((await db.query('select * from invoices where id=$1',[legacy.id])).rows[0],legacy);
  const owner=await insert('QA-NUMBER-001',{invoice_direction:'receivable',printed_invoice_number:'QA-NUMBER-001',source_owner_invoice_number:'QA-NUMBER-001',assistant_idempotency_key:'wa_review_number_001'});
  assert.equal(owner.invoice_number,'QA-NUMBER-001');
  await assert.rejects(insert('QA-NUMBER-001',{source_owner_invoice_number:'QA-NUMBER-001'}),{code:'23505'});
  const customer=await insert('CUSTOMER-SOURCE-2',{printed_invoice_number:'CUSTOMER-SOURCE-2',assistant_idempotency_key:'wa_customer_number_002'});
  assert.notEqual(customer.invoice_number,'CUSTOMER-SOURCE-2');
  const automatic=await insert('AUTO',{});assert.notEqual(automatic.invoice_number,'AUTO');
  await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  await assert.rejects(insert('FORGED-1',{source_owner_invoice_number:'FORGED-1'}),{code:'42501'});
 }finally{await f.close();}
});
