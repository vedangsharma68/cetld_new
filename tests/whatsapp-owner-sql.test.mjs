import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',stranger='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const phone='+919871367051';
async function boot(beforeOwnerMigrations){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,storage to authenticated,anon,service_role;
 grant execute on function auth.uid() to authenticated,anon,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
  if(file==='20261002020102_owner_followup_conversations.sql'&&beforeOwnerMigrations)await beforeOwnerMigrations(db);
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
 }
 await db.exec(`insert into auth.users(id) values('${owner}'),('${stranger}') on conflict(id) do nothing;set role authenticated;set request.jwt.claim.sub='${owner}'`);
 const ws=(await db.query("select (public.create_workspace('CETLD test','owner-test')).id")).rows[0].id;
 return {db,ws};
}
test('complete migration chain verifies ownership, atomically changes existing invoices, records payments once, and enforces revocation',async()=>{
 const {db,ws}=await boot();
 try{
  const noAttestation=(await db.query('select whatsapp_owner_attested_at from public.workspace_settings where workspace_id=$1',[ws])).rows[0];
  assert.equal(noAttestation.whatsapp_owner_attested_at,null);
  const verification=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[ws,phone])).rows[0];
  assert.match(verification.code,/^\d{6}$/);
  await assert.rejects(db.query('update public.whatsapp_owner_verifications set verified_at=now()'),/permission denied/i);
  await assert.rejects(db.query('update public.workspace_settings set whatsapp_owner_phone=$1 where workspace_id=$2',[phone,ws]),/Connect this number/);
  const customer=(await db.query("insert into public.customers(workspace_id,name,phone) values($1,'MineralTree','+14155550244') returning id",[ws])).rows[0].id;
  const consent=(await db.query('select * from public.whatsapp_record_verbal_consent($1,$2,$3)',[ws,customer,'+14155550244'])).rows[0];
  assert.equal(consent.phone,'+14155550244');
  const invoice=(await db.query(`insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency,metadata)
   values($1,$2,'1223113','2026-09-01','2026-10-01',1725,'USD','{"invoice_direction":"receivable","subtotal":1500,"tax":225}') returning *`,[ws,customer])).rows[0];
  await db.exec("reset role;set request.jwt.claim.sub='';set role service_role");
  const linked=(await db.query('select public.whatsapp_verify_owner_code($1,$2) as value',[phone,verification.code])).rows[0].value;
  assert.equal(linked.ok,true);
  assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) as value',[phone,verification.code])).rows[0].value.replayed,true);
  const binding=(await db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  assert.equal(binding.workspace_id,ws);assert.equal(binding.owner_id,owner);assert.notEqual(binding.customer_id,customer);
  await db.query("insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,status) values('owner-claim','123456',$1,'text','processing')",[phone]);
  assert.equal((await db.query("select public.whatsapp_claim_owner_reply('owner-claim',$1,$2) as claimed",[phone,ws])).rows[0].claimed,true);
  assert.equal((await db.query("select public.whatsapp_claim_owner_reply('owner-claim',$1,$2) as claimed",[phone,ws])).rows[0].claimed,false);
  const createAction=async(changes,type='owner_invoice_update',stamp=invoice.updated_at)=>{
   const state=(await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',[ws,binding.customer_id,phone])).rows[0];
   const action={type,invoiceId:invoice.id,expectedUpdatedAt:stamp,changes,expiresAt:new Date(Date.now()+600000).toISOString()};
   return (await db.query('select * from public.whatsapp_store_pending_action($1,$2,$3,$4,$5,$6,$7,$8)',
    [ws,binding.customer_id,phone,JSON.stringify(action),'whatsapp',state.generation,state.id,state.version])).rows[0];
  };
  const confirm=async(a,ownerId=owner,messageId='confirm-'+a.id)=>{
   await db.query("insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text','yes','processing') on conflict(provider_message_id) do nothing",[messageId,phone]);
   return (await db.query('select public.whatsapp_confirm_owner_invoice_action($1,$2,$3,$4,$5,$6,true) as value',
    [ws,ownerId,phone,a.id,a.version,messageId])).rows[0].value;
  };
  const a=await createAction({total:2000,currency:'USD'});
  assert.equal((await confirm(a,stranger)).reason,'unbound');
  assert.equal((await confirm(a)).ok,true);
  assert.equal((await confirm(a)).replayed,true);
  let changed=(await db.query('select * from public.invoices where id=$1',[invoice.id])).rows[0];
  assert.equal(Number(changed.total_amount),2000);
  assert.equal(changed.metadata.whatsapp_corrections.length,1);assert.equal(changed.metadata.tax,225);assert.equal(changed.metadata.subtotal,1775);
  assert.equal((await db.query("select nullif(current_setting('request.jwt.claim.sub',true),'') as sub")).rows[0].sub,null);
  // The dashboard saves tax_minor and may leave canonical tax/subtotal null.
  await db.query('update public.invoices set metadata=metadata||$2::jsonb where id=$1',[invoice.id,JSON.stringify({tax_minor:22500,tax:null,subtotal:null})]);
  changed=(await db.query('select * from public.invoices where id=$1',[invoice.id])).rows[0];
  const tooSmall=await createAction({total:100},'owner_invoice_update',changed.updated_at);
  await assert.rejects(confirm(tooSmall),/less than the recorded tax/);
  assert.equal(Number((await db.query('select total_amount from public.invoices where id=$1',[invoice.id])).rows[0].total_amount),2000);
  const dashboardTax=await createAction({total:2100},'owner_invoice_update',changed.updated_at);
  assert.equal((await confirm(dashboardTax)).ok,true);
  changed=(await db.query('select * from public.invoices where id=$1',[invoice.id])).rows[0];
  assert.equal(changed.metadata.tax_minor,22500);assert.equal(changed.metadata.tax,225);assert.equal(changed.metadata.subtotal,1875);
  const stale=await createAction({dueDate:'2026-10-15'});
  assert.equal((await confirm(stale)).reason,'stale');
  await db.query("insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,status,received_at) values('before-proposal','123456',$1,'text','processing',now()-interval '1 minute')",[phone]);
  const newer=await createAction({dueDate:'2026-10-15'},'owner_invoice_update',changed.updated_at);
  assert.equal((await confirm(newer,owner,'before-proposal')).reason,'stale_confirmation');
  const replay=await confirm(newer,owner,'confirm-'+a.id);assert.equal(replay.replayed,true);
  assert.equal(replay.invoiceNumber,'1223113');
  assert.equal((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[newer.id])).rows[0].consumed_at,null);
  await db.query('select public.whatsapp_claim_pending_action($1,$2,$3,$4)',[newer.id,ws,binding.customer_id,phone]);
  const payment=await createAction({status:'paid'},'owner_invoice_payment',changed.updated_at);
  assert.equal((await confirm(payment)).ok,true);
  assert.equal((await confirm(payment)).replayed,true);
  const paid=(await db.query('select total_amount,amount_paid,status,metadata from public.invoices where id=$1',[invoice.id])).rows[0];
  assert.equal(paid.status,'paid');assert.equal(Number(paid.amount_paid),2100);assert.equal(paid.metadata.followup_state,'cancelled');
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1',[invoice.id])).rows[0].count,1);
  await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${owner}'`);
  await assert.rejects(db.query('select public.whatsapp_confirm_owner_invoice_action($1,$2,$3,$4,$5,$6,true)',[ws,owner,phone,payment.id,payment.version,'blocked-auth']),/permission denied/i);
  await db.query('select public.owner_unbind_whatsapp($1)',[ws]);
  assert.equal((await db.query('select public.owner_whatsapp_verification_status($1) as status',[ws])).rows[0].status,'expired');
  await db.exec("reset role;set request.jwt.claim.sub='';set role service_role");
  assert.equal((await db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows.length,0);
  assert.equal((await db.query('select count(*)::int as count from public.invoices where workspace_id=$1',[ws])).rows[0].count,1);
 }finally{await db.close();}
});

test('release upgrades existing ad hoc owner functions and preserves a verified owner binding',async()=>{
 let existingWorkspace,existingCustomer,existingProof;
 const {db}=await boot(async db=>{
  await db.exec(await readFile(new URL('fixtures/owner-verification-legacy.sql',import.meta.url),'utf8'));
  await db.exec(`insert into auth.users(id) values('${owner}');set role authenticated;set request.jwt.claim.sub='${owner}'`);
  existingWorkspace=(await db.query("select (public.create_workspace('CETLD test','legacy-owner')).id")).rows[0].id;
  await db.query('update public.workspace_settings set whatsapp_owner_attested_at=now() where workspace_id=$1',[existingWorkspace]);
  await db.exec("reset role;set request.jwt.claim.sub=''");
  existingCustomer=(await db.query("insert into public.customers(workspace_id,name,phone,metadata) values($1,'Owner (WhatsApp)',$2,'{\"whatsapp_owner\":true}') returning id",[existingWorkspace,phone])).rows[0].id;
  await db.query("insert into public.whatsapp_consents(workspace_id,phone,customer_id,consented_by,source,consent_text_version,categories) values($1,$2,$3,$4,'verbal','owner_binding_v1',array['invoice_updates'])",[existingWorkspace,phone,existingCustomer,owner]);
  existingProof=(await db.query("insert into public.whatsapp_owner_verifications(workspace_id,phone,requested_by,code_hash,expires_at,verified_at) values($1,$2,$3,'already-verified-proof',now(),now()) returning id",[existingWorkspace,phone,owner])).rows[0].id;
 });
 try{
  await db.exec("reset role;set request.jwt.claim.sub='';set role service_role");
  const resolved=(await db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows;
  assert.equal(resolved.length,1);assert.equal(resolved[0].workspace_id,existingWorkspace);assert.equal(resolved[0].customer_id,existingCustomer);
  assert.equal((await db.query('select id from public.whatsapp_owner_verifications where verified_at is not null')).rows[0].id,existingProof);
  await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${owner}'`);
  assert.equal((await db.query('select public.owner_whatsapp_verification_status($1) as value',[existingWorkspace])).rows[0].value,'linked');
 }finally{await db.close();}
});
