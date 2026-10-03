import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stranger='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const phone='+919871367051';

async function boot({crlfLegacyWorkspaceData=false}={}){
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
  const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
  for(const name of migrations){
    if(crlfLegacyWorkspaceData&&name==='20261003141000_direct_owner_write.sql'){
      const current=(await db.query(`select
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)'::regprocedure) as propose,
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure) as decide`)).rows[0];
      await db.exec(current.propose.replace(/\n/g,'\r\n')+';\r\n'+current.decide.replace(/\n/g,'\r\n')+';');
      const legacy=(await db.query(`select
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)'::regprocedure) as propose,
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure) as decide`)).rows[0];
      assert.ok(legacy.propose.includes('\r\n'),'proposal legacy body should retain CRLF before upgrade');
      assert.ok(legacy.decide.includes('\r\n'),'decision legacy body should retain CRLF before upgrade');
    }
    const sql=await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
    await db.exec(sql.replace('create extension if not exists pgcrypto;',''));
  }
  await db.exec(`insert into auth.users(id) values('${owner}'),('${stranger}') on conflict(id) do nothing;
    set request.jwt.claim.role='authenticated';set role authenticated;set request.jwt.claim.sub='${owner}'`);
  const workspaceId=(await db.query("select (public.create_workspace('Direct writes','direct-write-test')).id")).rows[0].id;
  return {db,workspaceId};
}

async function asOwner(db,userId=owner){
  await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${userId}';set role authenticated`);
}
async function asService(db){
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
}
async function bindOwner(db,workspaceId){
  await asOwner(db);
  const verification=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  assert.match(verification.code,/^\d{6}$/);
  await asService(db);
  const result=(await db.query('select public.whatsapp_verify_owner_code($1,$2) as value',[phone,verification.code])).rows[0].value;
  assert.equal(result.ok,true);
}
async function addInbound(db,messageId,messageText,interactionId=null){
  await db.query(`insert into public.whatsapp_inbound_events(
    provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,interaction_id)
    values($1,'123456',$2,'text',$3,'processing',$4) on conflict(provider_message_id) do nothing`,[messageId,phone,messageText,interactionId]);
}
const keyFor=id=>`ownerwrite_${id.padEnd(32,'x').slice(0,32)}`;
async function write(db,{workspaceId,ownerId=owner,providerMessageId,quote,operation,targetId=null,expectedUpdatedAt=null,
  authorizationKind='instruction',interactionId=null,buttonDecision=null,pendingId=null,pendingVersion=null,payload={}}){
  await asService(db);
  return (await db.query(`select public.whatsapp_apply_direct_owner_write(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) as value`,[
    workspaceId,ownerId,phone,providerMessageId,interactionId,keyFor(providerMessageId),operation,targetId,expectedUpdatedAt,
    authorizationKind,quote,buttonDecision,pendingId,pendingVersion,JSON.stringify(payload)])).rows[0].value;
}

async function setConfirmationMode(db,workspaceId,mode){
  await asOwner(db);
  await db.query('update public.workspace_settings set owner_bot_preferences=owner_bot_preferences||$2::jsonb where workspace_id=$1',
    [workspaceId,JSON.stringify({confirmationMode:mode})]);
  await asService(db);
}

async function verifiedCustomerId(db){
  await db.exec('reset role');
  return (await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
}

async function seedPending(db,workspaceId,action){
  const customerId=await verifiedCustomerId(db);
  await db.exec('reset role');
  return (await db.query(`insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source)
    values($1,$2,$3,$4::jsonb,'whatsapp') returning id,version`,
    [workspaceId,customerId,phone,JSON.stringify(action)])).rows[0];
}

async function seedWorkspaceProposal(db,workspaceId,{operation,table,targetId=null,expectedUpdatedAt=null,values,requestMessageId}){
  const proposalId=randomUUID();
  await addInbound(db,requestMessageId,`Please ${operation} ${table}`);
  const customerId=await verifiedCustomerId(db);
  const pending=await seedPending(db,workspaceId,{type:'owner_workspace_data_change',proposalId,
    requestMessageId,sourceMessageId:requestMessageId,operation,table,
    expiresAt:new Date(Date.now()+5*60_000).toISOString()});
  await db.query(`insert into public.whatsapp_workspace_data_proposals(
    id,workspace_id,owner_id,customer_id,phone,operation,table_name,target_id,expected_updated_at,values,summary,
    request_message_id,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,now()+interval '5 minutes')`,
    [proposalId,workspaceId,owner,customerId,phone,operation,table,targetId,expectedUpdatedAt,
      JSON.stringify(values),`${operation} ${table}`,requestMessageId]);
  return {proposalId,pending};
}

async function proposeWorkspaceChange(db,workspaceId,{operation,table,targetId=null,expectedUpdatedAt=null,values,requestMessageId,summary}){
  const customerId=await verifiedCustomerId(db);
  const state=(await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',
    [workspaceId,customerId,phone])).rows[0];
  const result=(await db.query(`select public.whatsapp_workspace_data_propose(
    $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) as value`,[
    workspaceId,customerId,phone,requestMessageId,operation,table,targetId,expectedUpdatedAt,JSON.stringify(values),summary,
    state.generation,state.id,state.version])).rows[0].value;
  return {result,state};
}

async function seedLifecycleDelete(db,workspaceId,invoice,sourceMessageId){
  const proposalId=randomUUID();
  await addInbound(db,sourceMessageId,`Delete invoice ${invoice.invoice_number}`);
  const customerId=await verifiedCustomerId(db);
  const pending=await seedPending(db,workspaceId,{type:'owner_invoice_delete_proposal',proposalId,
    invoiceId:invoice.id,sourceMessageId,expiresAt:new Date(Date.now()+5*60_000).toISOString()});
  await db.query(`insert into public.invoice_lifecycle_proposals(
    id,workspace_id,owner_id,invoice_id,actor_phone,idempotency_key,request_message_id,expected_updated_at,
    invoice_number,customer_name,total_amount,currency,invoice_status,requires_exact_confirmation,had_payment,
    had_sent_reminder,state,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,false,false,'pending',now()+interval '5 minutes')`,
    [proposalId,workspaceId,owner,invoice.id,phone,`button_delete_${proposalId.replaceAll('-','')}`,
      sourceMessageId,invoice.updated_at,invoice.invoice_number,'Button Client',invoice.total_amount,invoice.currency,invoice.status]);
  return {proposalId,pending,customerId};
}

async function createDirectInvoice(db,workspaceId,{messageId,invoiceNumber,customerName,amount='55.00',currency='INR'}){
  const quote=invoiceNumber?`Create invoice ${invoiceNumber} for ${customerName}`:`Create invoice for ${customerName}`;
  await addInbound(db,messageId,quote);
  const payload={
    customer_name:customerName,issue_date:'2026-10-01',due_date:'2026-10-31',
    total_amount:amount,notes:`${customerName} original`,
  };
  if(invoiceNumber)payload.invoice_number=invoiceNumber;
  if(currency)payload.currency=currency;
  return write(db,{workspaceId,providerMessageId:messageId,quote,operation:'invoice.create',payload});
}

test('direct owner invoice writes are message-bound, scoped, idempotent, and reversible',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    const quote='Create invoice INV-DIRECT-001 for Nova Studio for 125.50 INR';
    await addInbound(db,'wa-direct-create-001',quote);
    const payload={invoice_number:'INV-DIRECT-001',customer_name:'Nova Studio',customer_email:'billing@nova.example',
      customer_phone:'+14155550244',issue_date:'2026-10-01',due_date:'2026-10-31',total_amount:'125.50',subtotal:'100.00',
      tax:'25.50',currency:'INR',notes:'Project phase one'};
    const created=await write(db,{workspaceId,providerMessageId:'wa-direct-create-001',quote,operation:'invoice.create',payload});
    assert.equal(created.ok,true,JSON.stringify(created));
    assert.equal(created.entityType,'invoice');
    assert.match(created.record.invoice_number,/^INV-2026-[0-9]{4,}$/);
    assert.equal(created.record.metadata.printed_invoice_number,'INV-DIRECT-001');
    assert.equal(created.record.total_amount,'125.50');
    const persistedCreated=(await db.query(`select i.id,i.total_amount::text as total_amount,c.name as customer_name
      from public.invoices i join public.customers c on c.workspace_id=i.workspace_id and c.id=i.customer_id
      where i.workspace_id=$1 and i.id=$2`,[workspaceId,created.entityId])).rows[0];
    assert.deepEqual(persistedCreated,{id:created.entityId,total_amount:'125.50',customer_name:'Nova Studio'});
    const replay=await write(db,{workspaceId,providerMessageId:'wa-direct-create-001',quote,operation:'invoice.create',payload});
    assert.equal(replay.replayed,true);
    const payloadDrift=await write(db,{workspaceId,providerMessageId:'wa-direct-create-001',quote,operation:'invoice.create',
      payload:{...payload,total_amount:'126.00',subtotal:'100.50',tax:'25.50'}});
    assert.equal(payloadDrift.code,'REPLAY_MISMATCH');
    assert.equal((await db.query("select count(*)::int as n from public.invoices where workspace_id=$1 and metadata->>'printed_invoice_number'='INV-DIRECT-001'",[workspaceId])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int as n from public.customers where workspace_id=$1 and name='Nova Studio'",[workspaceId])).rows[0].n,1);

    await addInbound(db,'wa-direct-negative-001','Do not delete invoice INV-DIRECT-001');
    const negative=await write(db,{workspaceId,providerMessageId:'wa-direct-negative-001',quote:'Delete it',
      operation:'invoice.delete',targetId:created.entityId,expectedUpdatedAt:created.updatedAt});
    assert.equal(negative.code,'INVALID_AUTHORIZATION');
    assert.equal((await db.query('select deleted_at from public.invoices where id=$1',[created.entityId])).rows[0].deleted_at,null);

    const canonicalNumber=created.record.invoice_number;
    await addInbound(db,'wa-direct-stale-001',`Update invoice ${canonicalNumber} notes`);
    const stale=await write(db,{workspaceId,providerMessageId:'wa-direct-stale-001',quote:`Update invoice ${canonicalNumber} notes`,
      operation:'invoice.update',targetId:created.entityId,expectedUpdatedAt:'2000-01-01T00:00:00Z',payload:{notes:'Changed'}});
    assert.equal(stale.code,'STALE');
    assert.equal((await db.query('select notes from public.invoices where id=$1',[created.entityId])).rows[0].notes,'Project phase one');

    await addInbound(db,'wa-direct-bad-type-001','Set invoice notes to a number');
    const badType=await write(db,{workspaceId,providerMessageId:'wa-direct-bad-type-001',
      quote:'Set invoice notes to a number',operation:'invoice.update',targetId:created.entityId,
      expectedUpdatedAt:created.updatedAt,payload:{notes:123}});
    assert.equal(badType.code,'INVALID');
    await addInbound(db,'wa-direct-delete-payload-001',`Delete invoice ${canonicalNumber}`);
    const deleteWithPayload=await write(db,{workspaceId,providerMessageId:'wa-direct-delete-payload-001',
      quote:`Delete invoice ${canonicalNumber}`,operation:'invoice.delete',targetId:created.entityId,
      expectedUpdatedAt:created.updatedAt,payload:{force:true}});
    assert.equal(deleteWithPayload.code,'INVALID');

    await addInbound(db,'wa-direct-delete-001',`Delete invoice ${canonicalNumber}`);
    const deleted=await write(db,{workspaceId,providerMessageId:'wa-direct-delete-001',quote:`Delete invoice ${canonicalNumber}`,
      operation:'invoice.delete',targetId:created.entityId,expectedUpdatedAt:created.updatedAt});
    assert.equal(deleted.ok,true,JSON.stringify(deleted));
    assert.ok((await db.query('select deleted_at from public.invoices where id=$1',[created.entityId])).rows[0].deleted_at);
    await db.exec('reset role');
    assert.equal((await db.query(`select state from public.invoice_lifecycle_proposals
      where workspace_id=$1 and invoice_id=$2`,[workspaceId,created.entityId])).rows[0].state,'deleted');

    const deletedUpdatedAt=(await db.query('select updated_at from public.invoices where id=$1',[created.entityId])).rows[0].updated_at;
    await addInbound(db,'wa-direct-restore-001',`Restore invoice ${canonicalNumber}`);
    const restored=await write(db,{workspaceId,providerMessageId:'wa-direct-restore-001',quote:`Restore invoice ${canonicalNumber}`,
      operation:'invoice.restore',targetId:created.entityId,expectedUpdatedAt:deletedUpdatedAt});
    assert.equal(restored.ok,true,JSON.stringify(restored));
    assert.equal((await db.query('select deleted_at from public.invoices where id=$1',[created.entityId])).rows[0].deleted_at,null);

    const expiredInvoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-direct-expired-invoice-001',
      invoiceNumber:'INV-EXPIRED-UNDO',customerName:'Expired Undo Client'});
    await addInbound(db,'wa-direct-expired-delete-001',`Delete invoice ${expiredInvoice.record.invoice_number}`);
    const expiredDelete=await write(db,{workspaceId,providerMessageId:'wa-direct-expired-delete-001',
      quote:`Delete invoice ${expiredInvoice.record.invoice_number}`,operation:'invoice.delete',targetId:expiredInvoice.entityId,
      expectedUpdatedAt:expiredInvoice.updatedAt});
    assert.equal(expiredDelete.ok,true,JSON.stringify(expiredDelete));
    await db.exec(`reset role;begin;
      insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
        values(pg_backend_pid(),txid_current(),'${expiredInvoice.entityId}');
      update public.invoices set deleted_at=clock_timestamp()-interval '31 days' where id='${expiredInvoice.entityId}';
      update public.invoice_lifecycle_proposals set deleted_at=(select deleted_at from public.invoices where id='${expiredInvoice.entityId}')
        where workspace_id='${workspaceId}' and invoice_id='${expiredInvoice.entityId}' and state='deleted';
      delete from app.invoice_lifecycle_write_context where backend_pid=pg_backend_pid()
        and transaction_id=txid_current() and invoice_id='${expiredInvoice.entityId}';commit;`);
    const expiredVersion=(await db.query('select updated_at from public.invoices where id=$1',[expiredInvoice.entityId])).rows[0].updated_at;
    await addInbound(db,'wa-direct-expired-restore-001',`Restore invoice ${expiredInvoice.record.invoice_number}`);
    const expiredRestore=await write(db,{workspaceId,providerMessageId:'wa-direct-expired-restore-001',
      quote:`Restore invoice ${expiredInvoice.record.invoice_number}`,operation:'invoice.restore',targetId:expiredInvoice.entityId,
      expectedUpdatedAt:expiredVersion});
    assert.equal(expiredRestore.code,'UNDO_EXPIRED');
    assert.ok((await db.query('select deleted_at from public.invoices where id=$1',[expiredInvoice.entityId])).rows[0].deleted_at);

    const foreignWorkspace='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    assert.equal((await write(db,{workspaceId:foreignWorkspace,providerMessageId:'wa-direct-foreign-001',quote:'Create invoice INV-FOREIGN',
      operation:'invoice.create',payload})).code,'DENIED');
    assert.equal((await write(db,{workspaceId,ownerId:stranger,providerMessageId:'wa-direct-wrong-owner-001',
      quote:'Create invoice INV-WRONG-OWNER',operation:'invoice.create',payload})).code,'DENIED');

    await addInbound(db,'wa-direct-revoked-owner-001','Create invoice after disconnect');
    await asOwner(db);
    assert.equal((await db.query('select public.owner_unbind_whatsapp($1) as unbound',[workspaceId])).rows[0].unbound,true);
    const revoked=await write(db,{workspaceId,providerMessageId:'wa-direct-revoked-owner-001',
      quote:'Create invoice after disconnect',operation:'invoice.create',payload});
    assert.equal(revoked.code,'DENIED');
  }finally{await db.close();}
});

test('button execution binds a real interaction to the current pending version and honors cancellation',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    const quote='Create invoice INV-BUTTON-001 for Button Client';
    await addInbound(db,'wa-button-source-001',quote);
    const action={type:'owner_invoice_create',sourceMessageId:'wa-button-source-001',idempotencyKey:'wa_owner_create_button_001',
      expiresAt:new Date(Date.now()+300000).toISOString(),invoice:{invoiceNumber:'INV-BUTTON-001',clientName:'Button Client',
        clientEmail:null,clientPhone:null,clientPhoneRaw:null,invoiceDate:'2026-10-01',dueDate:'2026-10-31',currency:'INR',
        total:55,subtotal:null,tax:null,outstanding:55,notes:null,lineItems:[],alreadyPaid:false,direction:'receivable'}};
    await asService(db);
    const binding=(await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
    const pending=(await db.query(`insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source)
      values($1,$2,$3,$4::jsonb,'whatsapp') returning id,version`,[workspaceId,binding.customer_id,phone,JSON.stringify(action)])).rows[0];
    await asOwner(db);
    await db.query(`update public.workspace_settings set owner_bot_preferences='{"confirmationMode":"buttons"}'::jsonb where workspace_id=$1`,[workspaceId]);
    await asService(db);
    await addInbound(db,'wa-button-confirm-001','Confirm','oab1.valid.confirm');
    const confirmed=await write(db,{workspaceId,providerMessageId:'wa-button-confirm-001',interactionId:'oab1.valid.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:pending.id,pendingVersion:pending.version});
    assert.equal(confirmed.ok,true,JSON.stringify(confirmed));
    assert.equal(confirmed.entityType,'invoice');
    assert.equal((await db.query("select count(*)::int as n from public.invoices where workspace_id=$1 and metadata->>'printed_invoice_number'='INV-BUTTON-001'",[workspaceId])).rows[0].n,1);
    assert.ok((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[pending.id])).rows[0].consumed_at);
  }finally{await db.close();}
});

test('direct customer, workspace settings, and AI settings updates are scoped and merge partial preferences',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    await db.exec('reset role');
    const ownerContact=(await db.query(`select c.id,c.updated_at from public.whatsapp_resolve_verified_owner($1) r
      join public.customers c on c.workspace_id=r.workspace_id and c.id=r.customer_id`,[phone])).rows[0];
    await addInbound(db,'wa-owner-contact-update-001','Rename my owner contact');
    const ownerUpdate=await write(db,{workspaceId,providerMessageId:'wa-owner-contact-update-001',
      quote:'Rename my owner contact',operation:'customer.update',targetId:ownerContact.id,
      expectedUpdatedAt:ownerContact.updated_at,payload:{name:'Reassigned Owner Contact'}});
    assert.equal(ownerUpdate.code,'DENIED');
    await addInbound(db,'wa-owner-contact-delete-001','Delete my owner contact');
    const ownerDelete=await write(db,{workspaceId,providerMessageId:'wa-owner-contact-delete-001',
      quote:'Delete my owner contact',operation:'customer.delete',targetId:ownerContact.id,
      expectedUpdatedAt:ownerContact.updated_at});
    assert.equal(ownerDelete.code,'DENIED');

    await db.exec('reset role');
    const flaggedContact=(await db.query(`insert into public.customers(workspace_id,name,metadata)
      values($1,'Flagged Owner Contact','{"whatsapp_owner":"true"}'::jsonb) returning id,updated_at`,[workspaceId])).rows[0];
    await addInbound(db,'wa-flagged-contact-update-001','Rename flagged contact');
    const flaggedUpdate=await write(db,{workspaceId,providerMessageId:'wa-flagged-contact-update-001',
      quote:'Rename flagged contact',operation:'customer.update',targetId:flaggedContact.id,
      expectedUpdatedAt:flaggedContact.updated_at,payload:{name:'Reassigned Flagged Contact'}});
    assert.equal(flaggedUpdate.code,'DENIED');

    await addInbound(db,'wa-customer-create-001','Add customer Cedar Works');
    const customer=await write(db,{workspaceId,providerMessageId:'wa-customer-create-001',quote:'Add customer Cedar Works',
      operation:'customer.create',payload:{name:'Cedar Works',company_name:'Cedar',email:'billing@cedar.example'}});
    assert.equal(customer.ok,true,JSON.stringify(customer));
    const customerId=customer.entityId;

    await addInbound(db,'wa-customer-update-001','Rename customer Cedar Works to Cedar Studio');
    const updatedCustomer=await write(db,{workspaceId,providerMessageId:'wa-customer-update-001',
      quote:'Rename customer Cedar Works to Cedar Studio',operation:'customer.update',targetId:customerId,
      expectedUpdatedAt:customer.updatedAt,payload:{name:'Cedar Studio'}});
    assert.equal(updatedCustomer.ok,true,JSON.stringify(updatedCustomer));
    assert.equal(updatedCustomer.record.name,'Cedar Studio');

    await addInbound(db,'wa-customer-delete-001','Remove customer Cedar Studio');
    const removedCustomer=await write(db,{workspaceId,providerMessageId:'wa-customer-delete-001',
      quote:'Remove customer Cedar Studio',operation:'customer.delete',targetId:customerId,
      expectedUpdatedAt:updatedCustomer.updatedAt});
    assert.equal(removedCustomer.ok,true,JSON.stringify(removedCustomer));
    assert.equal(removedCustomer.action,'customer.deleted');
    assert.equal(removedCustomer.record.name,'Cedar Studio');
    assert.equal((await db.query('select count(*)::int as n from public.customers where workspace_id=$1 and id=$2',[workspaceId,customerId])).rows[0].n,0);

    await asService(db);
    const settings=(await db.query('select updated_at,owner_bot_preferences from public.workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
    await addInbound(db,'wa-settings-update-001','Set currency to USD and shorten reminders');
    const reminderTemplate='Hello {{customer_name}}, invoice {{invoice_number}} is due {{due_date}}.';
    const settingsResult=await write(db,{workspaceId,providerMessageId:'wa-settings-update-001',
      quote:'Set currency to USD and shorten reminders',operation:'settings.update',targetId:workspaceId,
      expectedUpdatedAt:settings.updated_at,payload:{default_currency:'USD',default_timezone:'Asia/Kolkata',
        follow_up_preferences:{reminderTemplate,allowedWeekdays:[1,2,5],escalation:'pause',stopOnPayment:true},
        owner_bot_preferences:{assistantName:'Nia'}}});
    assert.equal(settingsResult.ok,true,JSON.stringify(settingsResult));
    assert.equal(settingsResult.record.default_currency,'USD');
    assert.equal(settingsResult.record.follow_up_preferences.reminderTemplate,reminderTemplate);
    assert.deepEqual(settingsResult.record.follow_up_preferences.allowedWeekdays,[1,2,5]);
    assert.equal(settingsResult.record.follow_up_preferences.escalation,'pause');
    assert.equal(settingsResult.record.follow_up_preferences.stopOnPayment,true);
    assert.equal(settingsResult.record.owner_bot_preferences.assistantName,'Nia');
    assert.equal(settingsResult.record.owner_bot_preferences.tone,settings.owner_bot_preferences.tone);

    const defaultCurrencyInvoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-default-currency-001',
      invoiceNumber:null,customerName:'Currency Client',amount:'55.00',currency:null});
    assert.equal(defaultCurrencyInvoice.ok,true,JSON.stringify(defaultCurrencyInvoice));
    assert.equal(defaultCurrencyInvoice.record.currency,'USD');
    assert.match(defaultCurrencyInvoice.record.invoice_number,/^INV-2026-[0-9]{4,}$/);
    assert.equal(defaultCurrencyInvoice.record.metadata.printed_invoice_number,undefined);

    await addInbound(db,'wa-ai-create-001','Set primary model to gemini-3.5-flash');
    const aiCreated=await write(db,{workspaceId,providerMessageId:'wa-ai-create-001',quote:'Set primary model to gemini-3.5-flash',
      operation:'ai_settings.update',targetId:workspaceId,payload:{primary_model:'gemini-3.5-flash',fallback_model:null}});
    assert.equal(aiCreated.ok,true,JSON.stringify(aiCreated));
    assert.equal(aiCreated.record.primary_model,'gemini-3.5-flash');
    await addInbound(db,'wa-ai-update-001','Set fallback model to space-bunny-free');
    const aiUpdated=await write(db,{workspaceId,providerMessageId:'wa-ai-update-001',quote:'Set fallback model to space-bunny-free',
      operation:'ai_settings.update',targetId:workspaceId,expectedUpdatedAt:aiCreated.updatedAt,
      payload:{fallback_model:'space-bunny-free'}});
    assert.equal(aiUpdated.ok,true,JSON.stringify(aiUpdated));
    assert.equal(aiUpdated.record.fallback_model,'space-bunny-free');
  }finally{await db.close();}
});

test('button owner invoice update and settlement verify pending version and current interaction',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    const invoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-button-update-invoice-001',
      invoiceNumber:'INV-BUTTON-UPDATE',customerName:'Button Update Client',amount:'70.00'});
    const paidInvoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-button-payment-invoice-001',
      invoiceNumber:'INV-BUTTON-PAYMENT',customerName:'Button Payment Client',amount:'80.00'});
    assert.equal(invoice.ok,true,JSON.stringify(invoice));
    assert.equal(paidInvoice.ok,true,JSON.stringify(paidInvoice));
    await setConfirmationMode(db,workspaceId,'buttons');

    const updateSource='wa-button-update-source-001';
    await addInbound(db,updateSource,'Please revise the notes');
    const updatePending=await seedPending(db,workspaceId,{type:'owner_invoice_update',sourceMessageId:updateSource,
      invoiceId:invoice.entityId,expectedUpdatedAt:invoice.updatedAt,changes:{notes:'Button updated notes'},
      expiresAt:new Date(Date.now()+5*60_000).toISOString()});
    const updateClick='oab1.update.confirm';
    await addInbound(db,'wa-button-update-click-001','Confirm',updateClick);
    const wrongInteraction=await write(db,{workspaceId,providerMessageId:'wa-button-update-click-001',interactionId:'oab1.other.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:updatePending.id,pendingVersion:updatePending.version});
    assert.equal(wrongInteraction.code,'INVALID_AUTHORIZATION');
    const staleVersion=await write(db,{workspaceId,providerMessageId:'wa-button-update-click-001',interactionId:updateClick,
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:updatePending.id,pendingVersion:updatePending.version+1});
    assert.equal(staleVersion.code,'NO_PENDING_ACTION');
    const updated=await write(db,{workspaceId,providerMessageId:'wa-button-update-click-001',interactionId:updateClick,
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:updatePending.id,pendingVersion:updatePending.version});
    assert.equal(updated.ok,true,JSON.stringify(updated));
    assert.equal(updated.action,'invoice.updated');
    assert.equal(updated.record.notes,'Button updated notes');

    const paymentSource='wa-button-payment-source-001';
    await addInbound(db,paymentSource,'Please mark this invoice as paid');
    const paymentPending=await seedPending(db,workspaceId,{type:'owner_invoice_payment',sourceMessageId:paymentSource,
      invoiceId:paidInvoice.entityId,expectedUpdatedAt:paidInvoice.updatedAt,changes:{status:'paid'},
      expiresAt:new Date(Date.now()+5*60_000).toISOString()});
    const paymentClick='oab1.payment.confirm';
    await addInbound(db,'wa-button-payment-click-001','Confirm',paymentClick);
    const paymentResult=await write(db,{workspaceId,providerMessageId:'wa-button-payment-click-001',interactionId:paymentClick,
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:paymentPending.id,pendingVersion:paymentPending.version});
    assert.equal(paymentResult.ok,true,JSON.stringify(paymentResult));
    assert.equal(paymentResult.action,'invoice.paid');
    assert.equal(paymentResult.record.status,'paid');
    assert.equal(paymentResult.record.amount_paid,'80.00');
    assert.equal((await db.query('select count(*)::int as n from public.payments where workspace_id=$1 and invoice_id=$2',[workspaceId,paidInvoice.entityId])).rows[0].n,1);
  }finally{await db.close();}
});

test('button AI settings, cancel, expiry, and invoice delete use the stored proposal and exact interaction',async()=>{
  const {db,workspaceId}=await boot({crlfLegacyWorkspaceData:true});
  try{
    await bindOwner(db,workspaceId);
    await addInbound(db,'wa-button-ai-initial-001','Set primary model to gemini-3.5-flash');
    const aiCreated=await write(db,{workspaceId,providerMessageId:'wa-button-ai-initial-001',
      quote:'Set primary model to gemini-3.5-flash',operation:'ai_settings.update',targetId:workspaceId,
      payload:{primary_model:'gemini-3.5-flash',fallback_model:null}});
    assert.equal(aiCreated.ok,true,JSON.stringify(aiCreated));
    const invoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-button-delete-invoice-001',
      invoiceNumber:'INV-BUTTON-DELETE',customerName:'Button Delete Client'});
    assert.equal(invoice.ok,true,JSON.stringify(invoice));
    await setConfirmationMode(db,workspaceId,'buttons');

    const aiProposal=await seedWorkspaceProposal(db,workspaceId,{operation:'update',table:'workspace_ai_settings',
      targetId:workspaceId,expectedUpdatedAt:aiCreated.updatedAt,
      values:{primary_model:'gemini-3.5-flash-lite',fallback_model:'space-bunny-free'},
      requestMessageId:'wa-button-ai-request-001'});
    await addInbound(db,'wa-button-ai-click-001','Confirm','oab1.ai.confirm');
    const aiResult=await write(db,{workspaceId,providerMessageId:'wa-button-ai-click-001',interactionId:'oab1.ai.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:aiProposal.pending.id,
      pendingVersion:aiProposal.pending.version});
    assert.equal(aiResult.ok,true,JSON.stringify(aiResult));
    assert.equal(aiResult.action,'ai_settings.updated');
    assert.equal(aiResult.record.primary_model,'gemini-3.5-flash-lite');
    assert.equal(aiResult.record.fallback_model,'space-bunny-free');

    await asOwner(db);
    await db.query(`update public.workspace_settings set owner_bot_preferences='{"assistantName":"Nia","tone":"friendly","confirmationMode":"buttons"}'::jsonb
      where workspace_id=$1`,[workspaceId]);
    await asService(db);
    const settingsBefore=(await db.query(`select updated_at,owner_bot_preferences from public.workspace_settings where workspace_id=$1`,[workspaceId])).rows[0];
    const template='Hello {{customer_name}} - invoice {{invoice_number}} is due {{due_date}}.';
    await addInbound(db,'wa-button-settings-request-001','Update workspace settings');
    const settingsProposal=await proposeWorkspaceChange(db,workspaceId,{operation:'update',table:'workspace_settings',
      targetId:workspaceId,expectedUpdatedAt:settingsBefore.updated_at,
      values:{business_name:'Northside Billing',owner_bot_preferences:{assistantName:'Avery'},
        follow_up_preferences:{reminderTemplate:template,allowedWeekdays:[1,2,5],escalation:'pause',stopOnPayment:true}},
      requestMessageId:'wa-button-settings-request-001',summary:'Update workspace settings'});
    assert.equal(settingsProposal.result.ok,true,JSON.stringify(settingsProposal.result));
    const settingsPending=await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',
      [workspaceId,await verifiedCustomerId(db),phone]);
    assert.equal(settingsPending.rows[0].action.type,'owner_workspace_data_change');
    await addInbound(db,'wa-button-settings-click-001','Confirm','oab1.settings.confirm');
    const settingsResult=await write(db,{workspaceId,providerMessageId:'wa-button-settings-click-001',
      interactionId:'oab1.settings.confirm',operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',
      pendingId:settingsPending.rows[0].id,pendingVersion:settingsPending.rows[0].version});
    assert.equal(settingsResult.ok,true,JSON.stringify(settingsResult));
    assert.equal(settingsResult.action,'settings.updated');
    assert.equal(settingsResult.record.business_name,'Northside Billing');
    assert.equal(settingsResult.record.follow_up_preferences.reminderTemplate,template);
    assert.equal(settingsResult.record.owner_bot_preferences.assistantName,'Avery');
    assert.equal(settingsResult.record.owner_bot_preferences.tone,'friendly');
    assert.equal(settingsResult.record.owner_bot_preferences.confirmationMode,'buttons');
    assert.deepEqual(settingsResult.record.follow_up_preferences.allowedWeekdays,[1,2,5]);
    assert.equal(settingsResult.record.follow_up_preferences.escalation,'pause');
    assert.equal(settingsResult.record.follow_up_preferences.stopOnPayment,true);

    const cancelProposal=await seedWorkspaceProposal(db,workspaceId,{operation:'create',table:'customers',
      values:{name:'Cancelled Customer'},requestMessageId:'wa-button-cancel-request-001'});
    await addInbound(db,'wa-button-cancel-click-001','Cancel','oab1.cancel.cancel');
    const cancelled=await write(db,{workspaceId,providerMessageId:'wa-button-cancel-click-001',interactionId:'oab1.cancel.cancel',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'cancel',pendingId:cancelProposal.pending.id,
      pendingVersion:cancelProposal.pending.version});
    assert.equal(cancelled.ok,true,JSON.stringify(cancelled));
    assert.equal(cancelled.action,'pending.cancelled');
    await db.exec('reset role');
    assert.equal((await db.query('select state from public.whatsapp_workspace_data_proposals where id=$1',[cancelProposal.proposalId])).rows[0].state,'cancelled');
    assert.equal((await db.query("select count(*)::int as n from public.customers where workspace_id=$1 and name='Cancelled Customer'",[workspaceId])).rows[0].n,0);

    const deleteProposal=await seedLifecycleDelete(db,workspaceId,invoice.record,'wa-button-delete-request-001');
    await addInbound(db,'wa-button-delete-click-001','Confirm','oab1.delete.confirm');
    const deleted=await write(db,{workspaceId,providerMessageId:'wa-button-delete-click-001',interactionId:'oab1.delete.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:deleteProposal.pending.id,
      pendingVersion:deleteProposal.pending.version});
    assert.equal(deleted.ok,true,JSON.stringify(deleted));
    assert.equal(deleted.action,'invoice.deleted');
    assert.ok(deleted.record.deleted_at);
    assert.ok((await db.query('select deleted_at from public.invoices where workspace_id=$1 and id=$2',[workspaceId,invoice.entityId])).rows[0].deleted_at);

    const expiredSource='wa-button-expired-source-001';
    await addInbound(db,expiredSource,'Create another invoice');
    const expiredPending=await seedPending(db,workspaceId,{type:'owner_invoice_create',sourceMessageId:expiredSource,
      expiresAt:new Date(Date.now()-60_000).toISOString()});
    await addInbound(db,'wa-button-expired-click-001','Confirm','oab1.expired.confirm');
    const expired=await write(db,{workspaceId,providerMessageId:'wa-button-expired-click-001',interactionId:'oab1.expired.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:expiredPending.id,
      pendingVersion:expiredPending.version});
    assert.equal(expired.code,'EXPIRED');
    assert.ok((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[expiredPending.id])).rows[0].consumed_at);
  }finally{await db.close();}
});
