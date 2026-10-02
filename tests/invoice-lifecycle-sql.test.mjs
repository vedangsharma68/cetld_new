import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stranger='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const phone='+919871367051';

async function boot(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role',true),'')
    $$;
    grant usage on schema auth,storage to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated,anon,service_role;
    grant execute on function auth.role() to authenticated,anon,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;`);
  const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url)))
    .filter(name=>name.endsWith('.sql')).sort();
  for(const name of migrations){
    const sql=await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
    await db.exec(sql.replace('create extension if not exists pgcrypto;',''));
  }
  await db.exec(`insert into auth.users(id) values('${owner}'),('${stranger}') on conflict(id) do nothing;
    set request.jwt.claim.role='authenticated';set role authenticated;set request.jwt.claim.sub='${owner}'`);
  const workspaceId=(await db.query("select (public.create_workspace('Lifecycle test','owner-test')).id"))
    .rows[0].id;
  return {db,workspaceId};
}

async function asOwner(db,userId=owner){
  await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${userId}';set role authenticated`);
}

async function asService(db){
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
}

async function addInvoice(db,workspaceId,invoiceNumber,{payment=false,file=false}={}){
  // Fixtures need privileged inserts; application roles intentionally cannot
  // write invoice rows directly outside the lifecycle RPC.
  await db.exec('reset role');
  const customerId=(await db.query(`insert into public.customers(workspace_id,name,phone)
    values($1,$2,'+14155550244') returning id`,[workspaceId,`Customer ${invoiceNumber}`])).rows[0].id;
  const invoice=(await db.query(`insert into public.invoices(
      workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,amount_paid,status,metadata)
    values($1,$2,$3,'2026-09-01','2026-10-01',100,$4,'sent',
      '{"invoice_direction":"receivable","followup_state":"scheduled"}'::jsonb)
    returning id,invoice_number,updated_at,automation_version`,
  [workspaceId,customerId,invoiceNumber,payment?20:0])).rows[0];
  if(payment)await db.query(`insert into public.payments(workspace_id,invoice_id,amount,reference)
    values($1,$2,20,'lifecycle fixture')`,[workspaceId,invoice.id]);
  if(file){
    const path=`${workspaceId}/${invoice.id}/source.pdf`;
    await db.query(`insert into public.invoice_files(workspace_id,invoice_id,storage_path,file_name,mime_type,size_bytes)
      values($1,$2,$3,'source.pdf','application/pdf',12)`,[workspaceId,invoice.id,path]);
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['invoice-files',path]);
  }
  return invoice;
}

async function lifecycle(db,action,workspaceId,fields={}){
  const result=await db.query(`select public.invoice_lifecycle_action(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as value`,[
    action,workspaceId,fields.invoiceId||null,fields.proposalId||null,fields.invoiceNumber||null,
    fields.phone||null,fields.idempotencyKey||null,fields.userMessage||null,
    fields.requestMessageId||null,fields.confirmationMessageId||null,
  ]);
  return result.rows[0].value;
}

async function addInbound(db,messageId,messageText){
  await db.query(`insert into public.whatsapp_inbound_events(
      provider_message_id,phone_number_id,sender_phone,message_type,message_text,status)
    values($1,'123456',$2,'text',$3,'processing') on conflict(provider_message_id) do nothing`,
  [messageId,phone,messageText]);
}

async function storeOwnerAction(db,workspaceId,action){
  await asService(db);
  const binding=(await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  assert.ok(binding?.customer_id,'the test owner must have a verified WhatsApp scope');
  const row=(await db.query(`insert into public.whatsapp_pending_actions(
      workspace_id,customer_id,phone,action,source)
    values($1,$2,$3,$4::jsonb,'whatsapp') returning id,version,generation,action,consumed_at`,
  [workspaceId,binding.customer_id,phone,JSON.stringify(action)])).rows[0];
  return row;
}

async function atomicOwnerConfirm(db,workspaceId,pending,confirmationMessageId){
  return (await db.query(`select public.whatsapp_confirm_owner_create_settings(
      $1,$2,$3,$4,$5,$6) as value`,
  [workspaceId,owner,phone,pending.id,pending.version,confirmationMessageId])).rows[0].value;
}

async function atomicOwnerReceiptLookup(db,workspaceId,confirmationMessageId){
  return (await db.query(`select public.whatsapp_confirm_owner_create_settings(
      $1,$2,$3,null,null,$4) as value`,[workspaceId,owner,phone,confirmationMessageId])).rows[0].value;
}

function ownerCreateAction({invoiceNumber='INV-OWNER-ATOMIC-001',clientName='Atomic Client',idempotencyKey='wa_owner_create_0123456789abcdef',sourceMessageId='wa-owner-create-source'}={}){
  return {type:'owner_invoice_create',idempotencyKey,sourceMessageId,
    expiresAt:new Date(Date.now()+5*60_000).toISOString(),
    invoice:{invoiceNumber,clientName,clientEmail:null,clientPhone:null,clientPhoneRaw:null,
      invoiceDate:'2026-10-01',dueDate:'2026-10-31',currency:'INR',total:1200,subtotal:null,tax:null,
      outstanding:1200,notes:null,lineItems:[],alreadyPaid:false,direction:'receivable'}};
}

async function addSavedOwnerInvoice(db,workspaceId,action){
  await db.exec('reset role');
  const invoice=action.invoice;
  const customerId=(await db.query('insert into public.customers(workspace_id,name) values($1,$2) returning id',
    [workspaceId,invoice.clientName])).rows[0].id;
  return (await db.query(`insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,notes,metadata)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning id,invoice_number`,[workspaceId,customerId,invoice.invoiceNumber,
    invoice.invoiceDate,invoice.dueDate,invoice.currency,invoice.total,invoice.notes,JSON.stringify({
      assistant_idempotency_key:action.idempotencyKey,invoice_direction:'receivable',subtotal:invoice.subtotal,tax:invoice.tax,
      outstanding_amount:invoice.outstanding,client_name:invoice.clientName,printed_invoice_number:invoice.invoiceNumber,
      client_phone:invoice.clientPhone,client_phone_raw:invoice.clientPhoneRaw,client_email:invoice.clientEmail,line_items:invoice.lineItems,
    })])).rows[0];
}

async function bindVerifiedOwner(db,workspaceId){
  await asOwner(db);
  const verification=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',
    [workspaceId,phone])).rows[0];
  assert.match(verification.code,/^\d{6}$/);
  await asService(db);
  const result=(await db.query('select public.whatsapp_verify_owner_code($1,$2) as value',
    [phone,verification.code])).rows[0].value;
  assert.equal(result.ok,true);
}

test('owner create and settings confirmation commit with the pending receipt and replay safely',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindVerifiedOwner(db,workspaceId);
    const createAction=ownerCreateAction();
    const createPending=await storeOwnerAction(db,workspaceId,createAction);
    await addInbound(db,'wa-atomic-create-confirm','YES');
    const created=await atomicOwnerConfirm(db,workspaceId,createPending,'wa-atomic-create-confirm');
    assert.equal(created.ok,true);
    assert.equal(created.actionType,'owner_invoice_create');
    assert.equal(created.customerName,'Atomic Client');
    const replay=await atomicOwnerConfirm(db,workspaceId,createPending,'wa-atomic-create-confirm');
    assert.equal(replay.ok,true);
    assert.equal(replay.replayed,true);
    assert.equal((await db.query(`select count(*)::int as n from public.invoices
      where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2`,
    [workspaceId,createAction.idempotencyKey])).rows[0].n,1);
    assert.ok((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',
      [createPending.id])).rows[0].consumed_at);
    assert.equal((await db.query(`select count(*)::int as n from public.whatsapp_owner_action_receipts
      where provider_message_id=$1`,['wa-atomic-create-confirm'])).rows[0].n,1);

    const settings=(await db.query('select business_name,updated_at from public.workspace_settings where workspace_id=$1',
      [workspaceId])).rows[0];
    const settingsAction={type:'owner_settings_update',sourceMessageId:'wa-settings-source',
      expiresAt:new Date(Date.now()+5*60_000).toISOString(),expectedUpdatedAt:settings.updated_at,
      request:{businessName:'Atomic Studio',patch:{tone:'professional',dailySummary:false}}};
    const settingsPending=await storeOwnerAction(db,workspaceId,settingsAction);
    await addInbound(db,'wa-atomic-settings-confirm','yes.');
    const savedSettings=await atomicOwnerConfirm(db,workspaceId,settingsPending,'wa-atomic-settings-confirm');
    assert.equal(savedSettings.ok,true);
    assert.equal(savedSettings.businessName,'Atomic Studio');
    assert.deepEqual(savedSettings.changed,['businessName','tone','dailySummary']);
    const storedSettings=(await db.query('select business_name,follow_up_preferences from public.workspace_settings where workspace_id=$1',
      [workspaceId])).rows[0];
    assert.equal(storedSettings.business_name,'Atomic Studio');
    assert.equal(storedSettings.follow_up_preferences.tone,'professional');
    assert.equal(storedSettings.follow_up_preferences.dailySummary,false);
    assert.ok((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',
      [settingsPending.id])).rows[0].consumed_at);
  }finally{await db.close();}
});

test('receipt-only replay requires the exact verified owner, provider message, and current stored YES',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindVerifiedOwner(db,workspaceId);
    const action=ownerCreateAction({invoiceNumber:'INV-RECEIPT-ONLY-001',idempotencyKey:'wa_owner_receipt_only_001',
      sourceMessageId:'wa-receipt-only-source'});
    const pending=await storeOwnerAction(db,workspaceId,action);
    await addInbound(db,'wa-receipt-only-confirm','YES');
    const created=await atomicOwnerConfirm(db,workspaceId,pending,'wa-receipt-only-confirm');
    assert.equal(created.ok,true);

    const replay=await atomicOwnerReceiptLookup(db,workspaceId,'wa-receipt-only-confirm');
    assert.equal(replay.ok,true);
    assert.equal(replay.replayed,true);
    assert.equal(replay.invoiceNumber,created.invoiceNumber);
    assert.equal((await db.query(`select count(*)::int as n from public.invoices
      where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2`,[workspaceId,action.idempotencyKey])).rows[0].n,1);

    await db.query(`update public.whatsapp_inbound_events set message_text='no'
      where provider_message_id='wa-receipt-only-confirm'`);
    assert.equal((await atomicOwnerReceiptLookup(db,workspaceId,'wa-receipt-only-confirm')).reason,'no_action',
      'a durable receipt is not exposed when the stored provider turn is no longer an explicit YES');
    await db.query(`update public.whatsapp_inbound_events set message_text='YES'
      where provider_message_id='wa-receipt-only-confirm'`);

    await addInbound(db,'wa-receipt-only-empty','yes');
    assert.deepEqual(await atomicOwnerReceiptLookup(db,workspaceId,'wa-receipt-only-empty'),{ok:false,reason:'no_action'});
    const otherWorkspace='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    assert.equal((await atomicOwnerReceiptLookup(db,otherWorkspace,'wa-receipt-only-confirm')).reason,'unbound');
    assert.equal((await db.query(`select count(*)::int as n from public.invoices
      where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2`,[workspaceId,action.idempotencyKey])).rows[0].n,1);
  }finally{await db.close();}
});

test('owner create confirmation rejects canceled and stale actions without writing',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindVerifiedOwner(db,workspaceId);
    const createAction=ownerCreateAction({idempotencyKey:'wa_owner_create_cancel_001',sourceMessageId:'wa-canceled-source'});
    const canceled=await storeOwnerAction(db,workspaceId,createAction);
    await asService(db);
    await db.query('update public.whatsapp_pending_actions set consumed_at=now() where id=$1',[canceled.id]);
    await addInbound(db,'wa-canceled-confirm','yes');
    assert.equal((await atomicOwnerConfirm(db,workspaceId,canceled,'wa-canceled-confirm')).reason,'no_action');
    assert.equal((await db.query(`select count(*)::int as n from public.invoices
      where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2`,
    [workspaceId,createAction.idempotencyKey])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from public.customers where workspace_id=$1 and name=$2',
      [workspaceId,'Atomic Client'])).rows[0].n,0);

    await db.exec('reset role');
    const settings=(await db.query('select business_name,updated_at from public.workspace_settings where workspace_id=$1',
      [workspaceId])).rows[0];
    const settingsAction={type:'owner_settings_update',sourceMessageId:'wa-settings-stale-source',
      expiresAt:new Date(Date.now()+5*60_000).toISOString(),expectedUpdatedAt:settings.updated_at,
      request:{businessName:'Proposed Studio',patch:{}}};
    const stale=await storeOwnerAction(db,workspaceId,settingsAction);
    await db.exec('reset role');
    await db.query("update public.workspace_settings set business_name='External Studio' where workspace_id=$1",[workspaceId]);
    await addInbound(db,'wa-settings-stale-confirm','yes');
    assert.equal((await atomicOwnerConfirm(db,workspaceId,stale,'wa-settings-stale-confirm')).reason,'stale');
    const current=(await db.query('select business_name from public.workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
    assert.equal(current.business_name,'External Studio');
    assert.ok((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[stale.id])).rows[0].consumed_at);
  }finally{await db.close();}
});

test('owner create idempotency recovers only the original active payload and rejects collisions without orphan customers',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindVerifiedOwner(db,workspaceId);
    const recoverAction=ownerCreateAction({invoiceNumber:'INV-OWNER-RECOVERY-001',clientName:'Recovery Client',
      idempotencyKey:'wa_owner_create_recovery_001',sourceMessageId:'wa-recovery-source'});
    const recoverInvoice=recoverAction.invoice;
    const recoverRow=await addSavedOwnerInvoice(db,workspaceId,recoverAction);
    const recoverPending=await storeOwnerAction(db,workspaceId,recoverAction);
    await addInbound(db,'wa-recovery-confirm','yes');
    const recovered=await atomicOwnerConfirm(db,workspaceId,recoverPending,'wa-recovery-confirm');
    assert.equal(recovered.ok,true);
    assert.equal(recovered.customerName,'Recovery Client');
    assert.equal((await db.query(`select count(*)::int as n from public.invoices
      where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2`,
    [workspaceId,recoverAction.idempotencyKey])).rows[0].n,1);

    await db.query(`update public.invoices set invoice_number='INV-OWNER-RECOVERY-RENAMED',
      metadata=metadata||'{"printed_invoice_number":"INV-OWNER-RECOVERY-RENAMED","source_invoice_number":"INV-OWNER-RECOVERY-RENAMED"}'::jsonb
      where id=$1`,[recoverRow.id]);
    const renamedPending=await storeOwnerAction(db,workspaceId,recoverAction);
    await addInbound(db,'wa-recovery-renamed-confirm','yes');
    assert.equal((await atomicOwnerConfirm(db,workspaceId,renamedPending,'wa-recovery-renamed-confirm')).reason,'stale');
    assert.equal((await db.query(`select count(*)::int as n from public.invoices
      where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2`,
    [workspaceId,recoverAction.idempotencyKey])).rows[0].n,1,'a renamed invoice must not be duplicated under the old proposal');
    await asService(db);
    await db.query('update public.whatsapp_pending_actions set consumed_at=now() where id=$1',[renamedPending.id]);

    const deletedAction=ownerCreateAction({invoiceNumber:'INV-OWNER-RECOVERY-DELETED',clientName:'Deleted Recovery Client',
      idempotencyKey:'wa_owner_create_deleted_001',sourceMessageId:'wa-deleted-source'});
    const deletedRow=await addSavedOwnerInvoice(db,workspaceId,deletedAction);
    await asOwner(db);
    const deleteProposal=await lifecycle(db,'prepare',workspaceId,{invoiceId:deletedRow.id,
      idempotencyKey:'dashboard_prepare_owner_deleted_001'});
    assert.equal(deleteProposal.ok,true);
    const deleted=await lifecycle(db,'confirm',workspaceId,{proposalId:deleteProposal.proposalId,
      userMessage:'yes',confirmationMessageId:'dashboard-confirm-owner-deleted'});
    assert.equal(deleted.action,'deleted',`confirm returned: ${JSON.stringify(deleted)}`);
    await asService(db);
    const deletedPending=await storeOwnerAction(db,workspaceId,deletedAction);
    await addInbound(db,'wa-deleted-confirm','yes');
    assert.equal((await atomicOwnerConfirm(db,workspaceId,deletedPending,'wa-deleted-confirm')).reason,'stale');
    await db.query('update public.whatsapp_pending_actions set consumed_at=now() where id=$1',[deletedPending.id]);
    assert.equal((await db.query(`select count(*)::int as n from public.invoices
      where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2`,
    [workspaceId,deletedAction.idempotencyKey])).rows[0].n,1,'a tombstoned invoice must not be revived or duplicated');

    const collision=await addInvoice(db,workspaceId,'INV-OWNER-COLLISION-SEED');
    const collisionNumber=(await db.query('select invoice_number from public.invoices where id=$1',[collision.id])).rows[0].invoice_number;
    await db.exec(`create function public.test_force_owner_invoice_collision() returns trigger
      language plpgsql as $$ declare collision_number text; begin
        select i.invoice_number into collision_number from public.invoices i
        where i.workspace_id=new.workspace_id order by i.created_at,i.id limit 1;
        new.invoice_number:=collision_number;
        return new;
      end $$;
      create trigger zzz_test_force_owner_invoice_collision before insert on public.invoices
      for each row execute function public.test_force_owner_invoice_collision();`);
    assert.ok(collisionNumber);
    const collisionAction=ownerCreateAction({invoiceNumber:'INV-OWNER-COLLISION-NEW',clientName:'Orphan Candidate',
      idempotencyKey:'wa_owner_create_collision_001',sourceMessageId:'wa-collision-source'});
    const collisionPending=await storeOwnerAction(db,workspaceId,collisionAction);
    await addInbound(db,'wa-collision-confirm','yes');
    const collisionResult=await atomicOwnerConfirm(db,workspaceId,collisionPending,'wa-collision-confirm');
    assert.equal(collisionResult.reason,'invoice_exists');
    assert.equal((await db.query('select count(*)::int as n from public.customers where workspace_id=$1 and name=$2',
      [workspaceId,'Orphan Candidate'])).rows[0].n,0);
  }finally{await db.close();}
});

test('invoice lifecycle enforces owner scope, exact confirmation, RLS, restore replay, stale state, and the 30-day window',async()=>{
  const {db,workspaceId}=await boot();
  try{
    const paid=await addInvoice(db,workspaceId,'INV-LIFECYCLE-A',{payment:true,file:true});
    await bindVerifiedOwner(db,workspaceId);

    const requestText=`Please delete invoice ${paid.invoice_number}`;
    await addInbound(db,'wa-lifecycle-request-a',requestText);
    const proposal=await lifecycle(db,'prepare',workspaceId,{invoiceId:paid.id,phone,
      idempotencyKey:'wa_prepare_lifecycle_a_001',userMessage:requestText,requestMessageId:'wa-lifecycle-request-a'});
    assert.equal(proposal.ok,true);
    assert.equal(proposal.requiresExactConfirmation,true,'a payment makes deletion require the invoice number');

    await addInbound(db,'wa-lifecycle-weak-confirm-a','yes');
    const weak=await lifecycle(db,'confirm',workspaceId,{proposalId:proposal.proposalId,phone,
      userMessage:'yes',confirmationMessageId:'wa-lifecycle-weak-confirm-a'});
    assert.equal(weak.code,'EXACT_CONFIRMATION_REQUIRED');
    const exactConfirmation=`DELETE ${paid.invoice_number}`;
    await addInbound(db,'wa-lifecycle-confirm-a',exactConfirmation);
    const deleted=await lifecycle(db,'confirm',workspaceId,{proposalId:proposal.proposalId,phone,
      userMessage:exactConfirmation,confirmationMessageId:'wa-lifecycle-confirm-a'});
    assert.equal(deleted.action,'deleted',JSON.stringify(deleted));

    await asOwner(db);
    assert.equal((await db.query('select count(*)::int as n from public.invoices where id=$1',[paid.id])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from public.payments where invoice_id=$1',[paid.id])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from public.invoice_files where invoice_id=$1',[paid.id])).rows[0].n,0);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as n from storage.objects where name like $1',
      [`${workspaceId}/${paid.id}/%`])).rows[0].n,1,'keep the source object available for 30-day undo');

    await asOwner(db);
    const undoKey='dashboard_undo_lifecycle_a_001';
    const restored=await lifecycle(db,'undo',workspaceId,{invoiceId:paid.id,idempotencyKey:undoKey});
    assert.equal(restored.action,'restored');
    const replay=await lifecycle(db,'undo',workspaceId,{invoiceId:paid.id,idempotencyKey:undoKey});
    assert.equal(replay.action,'restored');
    assert.equal(replay.replayed,true,'dashboard replay must match the undo actor, even after a WhatsApp deletion');
    const wrongTarget=await lifecycle(db,'undo',workspaceId,{invoiceId:'00000000-0000-4000-8000-000000000099',idempotencyKey:undoKey});
    assert.equal(wrongTarget.code,'REPLAYED','an undo key cannot be replayed against another invoice');
    assert.equal((await db.query('select count(*)::int as n from public.invoices where id=$1',[paid.id])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int as n from public.payments where invoice_id=$1',[paid.id])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int as n from public.invoice_files where invoice_id=$1',[paid.id])).rows[0].n,1);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as n from storage.objects where name like $1',
      [`${workspaceId}/${paid.id}/%`])).rows[0].n,1);

    await asOwner(db);
    const normal=await addInvoice(db,workspaceId,'INV-LIFECYCLE-B');
    const dashboardProposal=await lifecycle(db,'prepare',workspaceId,{invoiceId:normal.id,
      idempotencyKey:'dashboard_prepare_lifecycle_b_001'});
    assert.equal(dashboardProposal.requiresExactConfirmation,false);
    const dashboardDelete=await lifecycle(db,'confirm',workspaceId,{proposalId:dashboardProposal.proposalId,
      userMessage:'yes',confirmationMessageId:'dashboard-confirm-lifecycle-b'});
    assert.equal(dashboardDelete.action,'deleted');
    await asService(db);
    const restoreMessage=`RESTORE ${normal.invoice_number}`;
    await addInbound(db,'wa-lifecycle-undo-b',restoreMessage);
    const phoneRestore=await lifecycle(db,'undo',workspaceId,{invoiceId:normal.id,phone,
      idempotencyKey:'wa_undo_lifecycle_b_001',userMessage:restoreMessage,
      requestMessageId:'wa-lifecycle-undo-b'});
    assert.equal(phoneRestore.action,'restored');
    const phoneReplay=await lifecycle(db,'undo',workspaceId,{invoiceId:normal.id,phone,
      idempotencyKey:'wa_undo_lifecycle_b_001',userMessage:restoreMessage,
      requestMessageId:'wa-lifecycle-undo-b'});
    assert.equal(phoneReplay.action,'restored');
    assert.equal(phoneReplay.replayed,true,'WhatsApp replay must match the phone that restored the invoice');

    await asOwner(db);
    const staleInvoice=await addInvoice(db,workspaceId,'INV-LIFECYCLE-STALE');
    const staleProposal=await lifecycle(db,'prepare',workspaceId,{invoiceId:staleInvoice.id,
      idempotencyKey:'dashboard_prepare_lifecycle_stale_001'});
    await db.query("update public.invoices set notes='changed after review' where id=$1",[staleInvoice.id]);
    const stale=await lifecycle(db,'confirm',workspaceId,{proposalId:staleProposal.proposalId,
      userMessage:'yes',confirmationMessageId:'dashboard-confirm-lifecycle-stale'});
    assert.equal(stale.code,'ACTION_STALE');

    const sendingInvoice=await addInvoice(db,workspaceId,'INV-LIFECYCLE-SENDING');
    const settings=(await db.query('select updated_at from public.workspace_settings where workspace_id=$1',
      [workspaceId])).rows[0];
    await db.query(`insert into public.cetld_core_automation_delivery_claims(
        workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until)
      values($1,$2,now(),$3,$4,'sending',now()-interval '1 minute')`,
    [workspaceId,sendingInvoice.id,sendingInvoice.automation_version,settings.updated_at]);
    const sendingProposal=await lifecycle(db,'prepare',workspaceId,{invoiceId:sendingInvoice.id,
      idempotencyKey:'dashboard_prepare_lifecycle_sending_001'});
    assert.equal(sendingProposal.requiresExactConfirmation,true);
    const sendingConfirmation=`DELETE ${sendingInvoice.invoice_number}`;
    const blocked=await lifecycle(db,'confirm',workspaceId,{proposalId:sendingProposal.proposalId,
      userMessage:sendingConfirmation,confirmationMessageId:'dashboard-confirm-lifecycle-sending'});
    assert.equal(blocked.code,'ACTION_PENDING','an expired sending lease remains unresolved until provider state is reconciled');
    assert.equal((await db.query(`select status from public.cetld_core_automation_delivery_claims
      where invoice_id=$1`,[sendingInvoice.id])).rows[0].status,'sending');
    const canceledSendingProposal=await lifecycle(db,'cancel',workspaceId,{proposalId:sendingProposal.proposalId,
      userMessage:'cancel'});
    assert.equal(canceledSendingProposal.action,'cancelled');

    const aged=await addInvoice(db,workspaceId,'INV-LIFECYCLE-OLD');
    const agedProposal=await lifecycle(db,'prepare',workspaceId,{invoiceId:aged.id,
      idempotencyKey:'dashboard_prepare_lifecycle_old_001'});
    const agedDelete=await lifecycle(db,'confirm',workspaceId,{proposalId:agedProposal.proposalId,
      userMessage:'yes',confirmationMessageId:'dashboard-confirm-lifecycle-old'});
    assert.equal(agedDelete.action,'deleted');
    await db.exec('reset role;begin');
    await db.query(`insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
      values(pg_catalog.pg_backend_pid(),pg_catalog.txid_current(),$1)`,[aged.id]);
    await db.query(`update public.invoices set deleted_at=now()-interval '31 days',deleted_by=$2 where id=$1`,
      [aged.id,owner]);
    await db.query(`update public.invoice_lifecycle_proposals set deleted_at=now()-interval '31 days'
      where invoice_id=$1 and state='deleted'`,[aged.id]);
    await db.query(`delete from app.invoice_lifecycle_write_context
      where backend_pid=pg_catalog.pg_backend_pid() and transaction_id=pg_catalog.txid_current() and invoice_id=$1`,[aged.id]);
    await db.exec('commit');
    await asOwner(db);
    const expiredUndo=await lifecycle(db,'undo',workspaceId,{invoiceId:aged.id,
      idempotencyKey:'dashboard_undo_lifecycle_old_001'});
    assert.equal(expiredUndo.code,'UNDO_EXPIRED');

    const forged=await addInvoice(db,workspaceId,'INV-LIFECYCLE-FORGED');
    await db.query("select set_config('app.invoice_lifecycle_write_context','true',true)");
    await assert.rejects(db.query('update public.invoices set deleted_at=now(),deleted_by=$2 where id=$1',
      [forged.id,owner]),/owner lifecycle RPC/i);

    await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${stranger}';set role authenticated`);
    const foreignWorkspace=(await db.query("select (public.create_workspace('Foreign lifecycle','other-owner')).id"))
      .rows[0].id;
    await asOwner(db);
    await assert.equal((await lifecycle(db,'prepare',foreignWorkspace,{invoiceId:normal.id,
      idempotencyKey:'foreign_prepare_lifecycle_001'})).code,'OWNER_REQUIRED');
  }finally{await db.close();}
});
