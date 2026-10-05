import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

const source={printed_invoice_number:'PRINTED-17',source_invoice_number:'SOURCE-17',original_invoice_number:'ORIGINAL-17',
 invoice_number_override_audit:{originalExtractedNumber:'PRINTED-17',requestedNumber:'AUTO'},source_file:{name:'original.pdf'},
 original_extraction:{total:100},extracted_invoice:{number:'17'},extraction:{rawText:'original'},whatsapp_corrections:[{source:'whatsapp'}],
 assistant_idempotency_key:'original-save'};
async function fixture(){
 const f=await createOfflineSqlNetwork(),owner=randomUUID(),member=randomUUID(),foreign=randomUUID();
 await f.db.query('insert into auth.users(id) values($1),($2),($3)',[owner,member,foreign]);
 const identity=async(actor,role='authenticated')=>{await f.db.exec('reset role');await f.db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",[actor||'',role]);await f.db.exec(`set role ${role}`);};
 await identity(owner);const ws=(await f.db.query('select (public.create_workspace($1,$2)).id',['Sources',randomUUID()])).rows[0].id;
 await f.db.query('insert into workspace_members(workspace_id,user_id,role) values($1,$2,$3)',[ws,member,'member']);
 const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Source client') returning id",[ws])).rows[0].id;
 await identity(null,'service_role');
 const invoice=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,status,metadata) values($1,$2,'AUTO',100,'sent',$3) returning *",[ws,customer,{...source,invoice_direction:'receivable'}])).rows[0];
 return {...f,owner,member,foreign,ws,customer,invoice,identity};
}
test('actual owner/member raw updates cannot replace, null, remove or erase source/audit metadata; foreign RLS remains closed',async()=>{
 const f=await fixture();try{
  const original=(await f.db.query('select metadata from invoices where id=$1',[f.invoice.id])).rows[0].metadata;
  for(const actor of [f.owner,f.member]){await f.identity(actor);
   for(const key of Object.keys(source))for(const mode of ['replace','null','remove']){
    const value={...original};if(mode==='remove')delete value[key];else value[key]=mode==='null'?null:'forged';
    await assert.rejects(f.db.query('update invoices set metadata=$1 where id=$2',[value,f.invoice.id]),{code:'42501',message:'invoice source and audit metadata is server managed'});
   }
   await assert.rejects(f.db.query("update invoices set metadata='{}' where id=$1",[f.invoice.id]),{code:'42501'});
   assert.deepEqual((await f.db.query('select metadata from invoices where id=$1',[f.invoice.id])).rows[0].metadata,original);
  }
  await f.identity(f.foreign);assert.equal((await f.db.query('select id from invoices where id=$1',[f.invoice.id])).rows.length,0);
  assert.equal((await f.db.query("update invoices set metadata='{}' where id=$1 returning id",[f.invoice.id])).rows.length,0);
 }finally{await f.close();}
});
test('raw invoice INSERT refuses new audit forgeries but preserves ordinary numbering, SDK idempotency and custom-field isolation',async()=>{
 const f=await fixture();try{
  await f.identity(f.owner);
  for(const key of Object.keys(source).filter(key=>!['assistant_idempotency_key','source_invoice_number'].includes(key)))
   await assert.rejects(f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'AUTO',10,$3)",[f.ws,f.customer,{[key]:source[key],role:'service_role'}]),{code:'42501'});
  for(const number of ['AUTO','OWNER-INPUT']){
   const row=(await f.db.query('insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,$3,10,$4) returning *',[f.ws,f.customer,number,{assistant_idempotency_key:randomUUID(),invoice_direction:'receivable',role:'service_role'}])).rows[0];
   assert.match(row.invoice_number,/^INV-/);assert.equal(row.metadata.source_file,undefined);
   if(number==='AUTO')assert.equal(row.metadata.source_invoice_number,undefined);else assert.equal(row.metadata.source_invoice_number,number);
  }
  const uploaded=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'AUTO',10,$3) returning *",[f.ws,f.customer,{source_invoice_number:'EXTRACTED-17',extraction_status:'reviewed',invoice_direction:'receivable'}])).rows[0];
  assert.equal(uploaded.metadata.source_invoice_number,'EXTRACTED-17');assert.match(uploaded.invoice_number,/^INV-/);
  await f.identity(f.foreign);await assert.rejects(f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount) values($1,$2,'AUTO',10)",[f.ws,f.customer]),{code:'42501'});
 }finally{await f.close();}
});
test('typed audited owner correction keeps source facts, permits benign notes/dates/custom fields and verifies replay',async()=>{
 const f=await fixture();try{
  await f.identity(f.owner);const before=(await f.db.query('select * from invoices where id=$1',[f.invoice.id])).rows[0];
  const request=randomUUID(),values={notes:'Owner note',due_date:'2026-12-31',custom_fields:{project:'North',source_file:'custom annotation',role_hint:'service_role'}};
  const invoke=()=>f.db.query('select public.owner_correct_invoice($1,$2,$3,$4,$5) value',[f.ws,f.invoice.id,before.updated_at,request,values]);
  assert.equal((await invoke()).rows[0].value.completed,true);assert.equal((await invoke()).rows[0].value.replayed,true);
  const row=(await f.db.query('select * from invoices where id=$1',[f.invoice.id])).rows[0];
  for(const key of Object.keys(source))assert.deepEqual(row.metadata[key],before.metadata[key]);
  assert.equal(row.notes,values.notes);assert.equal(row.custom_fields.project,'North');
  assert.equal(row.custom_fields.source_file,'custom annotation');assert.deepEqual(row.metadata.source_file,before.metadata.source_file);
 }finally{await f.close();}
});
test('authenticated paid Assistant RPC cannot forge source metadata; normal paid saves remain atomic',async()=>{
 const f=await fixture();try{
  await f.identity(f.owner);
  const save=(metadata,key)=>f.db.query('select public.create_paid_assistant_invoice($1,$2,$3,current_date,null,$4,10,null,$5,$6,null) value',[f.ws,f.customer,'AUTO','USD',{invoice_direction:'receivable',assistant_idempotency_key:key,...metadata},key]);
  for(const key of Object.keys(source).filter(key=>!['assistant_idempotency_key','source_invoice_number'].includes(key)))await assert.rejects(save({[key]:source[key]},randomUUID()),{code:'42501'});
  for(const value of [null,{},'', 'x'.repeat(101),'line\nnumber'])await assert.rejects(save({source_invoice_number:value},randomUUID()),{code:'22023',message:'invalid initial source invoice number'});
  const idempotency=randomUUID();await save({},idempotency);await save({},idempotency);
  const row=(await f.db.query("select * from invoices where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2",[f.ws,idempotency])).rows[0];
  assert.equal(row.status,'paid');assert.equal(Number(row.amount_paid),10);
  assert.equal((await f.db.query('select count(*)::int n from payments where invoice_id=$1',[row.id])).rows[0].n,1);
  const printed=randomUUID();await save({source_invoice_number:'SELF-REPORTED-17'},printed);
  assert.equal((await f.db.query("select metadata from invoices where metadata->>'assistant_idempotency_key'=$1",[printed])).rows[0].metadata.source_invoice_number,'SELF-REPORTED-17');
 }finally{await f.close();}
});
test('existing source file binding is immutable to raw owner/member changes; scoped file append and trusted service flows remain supported',async()=>{
 const f=await fixture();try{
  await f.identity(f.owner);const path=`${f.ws}/${f.invoice.id}/original.pdf`;
  // Reflect the real app order: complete upload, then append its scoped pointer.
  await f.db.exec('reset role;grant select,insert,update,delete on storage.objects to authenticated;set role authenticated');
  await f.db.query("insert into storage.objects(bucket_id,name) values('invoice-files',$1)",[path]);
  const row=(await f.supabase.from('invoice_files').insert({workspace_id:f.ws,invoice_id:f.invoice.id,storage_path:path,file_name:'original.pdf',mime_type:'application/pdf',size_bytes:100}).select('*').single()).data;
  assert.ok(row?.id);
  for(const invalid of [`${randomUUID()}/${f.invoice.id}/foreign.pdf`,`${f.ws}/${randomUUID()}/other-invoice.pdf`,`${f.ws}/${f.invoice.id}/..`,`${f.ws}/${f.invoice.id}/nested/path.pdf`])
   await assert.rejects(f.db.query('insert into invoice_files(workspace_id,invoice_id,storage_path,file_name) values($1,$2,$3,$4)',[f.ws,f.invoice.id,invalid,'forged.pdf']),{code:'42501',message:'invoice source file path must match its workspace and invoice'});
  for(const actor of [f.owner,f.member]){await f.identity(actor);
   for(const patch of [{storage_path:path+'-forged'},{file_name:'forged.pdf'},{size_bytes:101},{mime_type:'image/png'}]){
    const key=Object.keys(patch)[0];await assert.rejects(f.db.query(`update invoice_files set ${key}=$1 where id=$2`,[patch[key],row.id]),{code:'42501',message:'existing invoice source file metadata is server managed'});
   }
   await assert.rejects(f.db.query('delete from invoice_files where id=$1',[row.id]),{code:'42501'});
  }
  await f.identity(f.foreign);assert.equal((await f.db.query('select * from invoice_files where id=$1',[row.id])).rows.length,0);
  await f.identity(null,'service_role');await f.db.query('update invoice_files set file_name=$1 where id=$2',['trusted.pdf',row.id]);
  await f.db.query("update invoices set metadata=metadata||'{\"printed_invoice_number\":\"SERVER-18\",\"source_file\":\"server.pdf\"}'::jsonb where id=$1",[f.invoice.id]);
  assert.equal((await f.db.query('select metadata from invoices where id=$1',[f.invoice.id])).rows[0].metadata.printed_invoice_number,'SERVER-18');
 }finally{await f.close();}
});
test('Storage RLS blocks linked owner/member overwrite, rename/delete and orphan-to-linked moves; append, orphan cleanup and service paths remain supported',async()=>{
 const f=await fixture();try{
  // Minimal Supabase-managed fixture models metadata and platform table grants;
  // production DDL only alters existing policies, never these columns/grants.
  await f.db.exec('reset role;alter table storage.objects add column metadata jsonb;grant select,insert,update,delete on storage.objects to authenticated,service_role');
  await f.identity(f.owner);const path=`${f.ws}/${f.invoice.id}/source.pdf`,orphan=`${f.ws}/${f.invoice.id}/new.pdf`;
  await f.db.query("insert into storage.objects(bucket_id,name,metadata) values('invoice-files',$1,'{\"size\":100}'),('invoice-files',$2,'{}')",[path,orphan]);
  const link=await f.supabase.from('invoice_files').insert({workspace_id:f.ws,invoice_id:f.invoice.id,storage_path:path,file_name:'source.pdf',size_bytes:100});assert.equal(link.error,null);
  for(const actor of [f.owner,f.member]){await f.identity(actor);
   assert.equal((await f.db.query("update storage.objects set metadata='{\"size\":200}' where name=$1 returning id",[path])).rows.length,0);
   assert.equal((await f.db.query('update storage.objects set name=$1 where name=$2 returning id',[path+'-renamed',path])).rows.length,0);
   assert.equal((await f.db.query('delete from storage.objects where name=$1 returning id',[path])).rows.length,0);
   await assert.rejects(f.db.query('update storage.objects set name=$1 where name=$2',[path,orphan]),{code:'42501'});
  }
  await f.identity(f.foreign);assert.equal((await f.db.query('select id from storage.objects where name=$1',[path])).rows.length,0);
  await assert.rejects(f.db.query("insert into storage.objects(bucket_id,name) values('invoice-files',$1)",[orphan+'-foreign']),{code:'42501'});
  await f.identity(f.owner);assert.equal((await f.db.query("update storage.objects set metadata='{\"size\":300}' where name=$1 returning id",[orphan])).rows.length,1);
  assert.equal((await f.db.query('delete from storage.objects where name=$1 returning id',[orphan])).rows.length,1);
  await f.identity(null,'service_role');assert.equal((await f.db.query("update storage.objects set metadata='{\"size\":101}' where name=$1 returning id",[path])).rows.length,1);
  assert.equal((await f.db.query('select name from storage.objects where name=$1',[path])).rows.length,1);
  for(const name of ['guard_raw_invoice_source_metadata','guard_raw_invoice_source_file'])await assert.rejects(f.db.query(`select app.${name}()`),{code:'42501'});
 }finally{await f.close();}
});
test('Storage policy preflight detects PUBLIC and inherited effective roles without resolving PUBLIC as an ordinary role',async()=>{
 const f=await fixture();try{
  await f.db.exec('reset role;create role fixture_storage_writer;create role fixture_unrelated_writer;grant fixture_storage_writer to authenticated');
  const sql=await readFile(new URL('../supabase/migrations/20261004218000_source_invoice_metadata_guard.sql',import.meta.url),'utf8');
  const preflight=sql.match(/do \$storage_policy_review\$[\s\S]*?\$storage_policy_review\$;/)?.[0];assert.ok(preflight);
  await f.db.exec('create policy unrelated_storage_write on storage.objects for update to fixture_unrelated_writer using(false)');
  await f.db.exec(preflight);await f.db.exec('drop policy unrelated_storage_write on storage.objects');
  for(const role of ['fixture_storage_writer','public']){
   await f.db.exec(`create policy unreviewed_storage_write on storage.objects for update to ${role} using(false)`);
   await assert.rejects(f.db.exec(preflight),{message:'Storage write policies require explicit source preservation review'});
   await f.db.exec('drop policy unreviewed_storage_write on storage.objects');
  }
 }finally{await f.close();}
});
