import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createZohoBoundReminderFixture} from './fixtures/zoho-bound-reminder.mjs';
import {definition,installedShapes} from './fixtures/zoho-installed-predecessors.mjs';
import {prepareOwnerReminderContent} from '../automation/whatsapp/owner-reminders.mjs';
import {buildDefaultInvoiceReminderDraft} from '../automation/whatsapp/reminder-parameters.mjs';
import {reminderFingerprint} from '../automation/whatsapp/reminder-fingerprint.mjs';
const file='20261027100000_zoho_first_party_reminder_bridge.sql',helper='app.legacy_reminder_approval_matches(uuid,public.invoices)';
const source=()=>readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const value=async(f,sql,args=[])=>(await f.db.query(sql,args)).rows[0];
const digest=x=>createHash('sha256').update(x).digest('hex');
const businesses=['invoices','customers','workspace_settings','whatsapp_consents','payments','cetld_accounting_connections','cetld_accounting_sync_records','cetld_core_automation_delivery_claims','whatsapp_messages','app.zoho_invoice_origins','app.zoho_customer_origins','app.zoho_capture_completion','app.zoho_bound_claims'];
async function businessHashes(f){return Promise.all(businesses.map(async t=>[t,(await value(f,`select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]'),'UTF8')),'hex') h from ${t} r`)).h]));}
async function helperAbsent(f){assert.equal((await value(f,'select to_regprocedure($1) v',[helper])).v,null);}

test('observed installed definitions are repaired canonically with unchanged security/OIDs/CRLF and zero installation business DML',async()=>{
 const f=await createZohoBoundReminderFixture({installBridge:false,installedShape:true});try{
  await helperAbsent(f);const before=await Promise.all(installedShapes.map(async([sig,hash])=>{const p=await definition(f.db,sig);assert.equal(digest(p.d),hash);return [sig,p];})),hashes=await businessHashes(f);
  await f.db.exec(await source());assert.deepEqual(await businessHashes(f),hashes);
  for(const [sig,p] of before){const next=await definition(f.db,sig);assert.equal(next.oid,p.oid);assert.deepEqual(next.security,p.security);if(!sig.includes('authorize_first_party')&&!sig.includes('record_first_party_receipt'))assert.equal(next.d,p.d,'unchanged CRLF function bytes');}
  assert.equal(digest((await definition(f.db,installedShapes[0][0])).d),'286ea00f8e2ebf9bf843bc13bf45fd2d9884e4208d523185ef11abe50469746a');
  const receipt=await definition(f.db,installedShapes[1][0]);assert.equal(receipt.prosrc.split('\r\n').length-1,71);assert.equal(digest(receipt.d.replaceAll('\r\n','\n')),'ff44a3b763a05f1c3a7e5a0c4376f9d77e718f5c4aa828bacb3da78ad87be05b');
  assert.equal(digest((await definition(f.db,helper)).d),'5f6f096cf89040c2682cdf299d105694f4f913c98b9c6ad99f91e2c0dc836415');
  for(const role of ['anon','authenticated','service_role'])assert.equal((await value(f,'select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,helper])).allowed,false);
  for(const sig of ['cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)','cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'])assert.equal((await definition(f.db,sig)).prosrc.split('\r\n').length-1,31);
 }finally{await f.close();}
});

test('unknown source/line-ending/ACL/helper/dependency/default-grant drift aborts atomically and restores the original missing-helper shape',async t=>{
 const f=await createZohoBoundReminderFixture({installBridge:false,installedShape:true});try{
  const sql=await source(),historical=await readFile(new URL('../supabase/migrations/20261023083356_per_message_reminder_review.sql',import.meta.url),'utf8'),canonical=historical.slice(historical.indexOf('create function app.legacy_reminder_approval_matches'),historical.indexOf('-- Extend the installed gate'));
  const before=await Promise.all(installedShapes.map(async([sig])=>[sig,(await definition(f.db,sig)).d])),hashes=await businessHashes(f);
  const mutations={
   final:async()=>{const p=await definition(f.db,installedShapes[0][0]);await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc+'\n-- unknown'));},
   receipt:async()=>{const p=await definition(f.db,installedShapes[1][0]);await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc.replace('\r\n','\n')));},
   unchangedMixed:async()=>{const p=await definition(f.db,installedShapes[2][0]);await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc.replace('\r\n','\n')));},
   ACL:()=>f.db.exec('grant execute on function public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text) to authenticated'),
   helperSource:()=>f.db.exec("create function app.legacy_reminder_approval_matches(uuid,public.invoices) returns boolean language sql stable security definer set search_path='' as $$select true$$;revoke all on function app.legacy_reminder_approval_matches(uuid,public.invoices) from public,anon,authenticated,service_role"),
   helperACL:()=>f.db.exec(canonical+';grant execute on function app.legacy_reminder_approval_matches(uuid,public.invoices) to authenticated'),
   owner:()=>f.db.exec('create role unexpected_compat_owner;alter function public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text) owner to unexpected_compat_owner'),
   helperSecurity:()=>f.db.exec(canonical+';alter function app.legacy_reminder_approval_matches(uuid,public.invoices) security invoker'),
   dependency:()=>f.db.exec('alter table public.whatsapp_direct_write_receipts rename to unavailable_receipt_dependency'),
   defaultGrant:()=>f.db.exec('create role unknown_compat_grantee;alter default privileges in schema app grant execute on functions to unknown_compat_grantee'),
  };
  for(const [name,mutate] of Object.entries(mutations))await t.test(name,async()=>{
   await f.db.exec('begin');await mutate();await assert.rejects(f.db.exec(sql),/drift|missing|mismatch/);await f.db.exec('rollback');
   await helperAbsent(f);for(const [sig,d] of before)assert.equal((await definition(f.db,sig)).d,d);assert.deepEqual(await businessHashes(f),hashes);
   assert.equal((await value(f,"select to_regclass('app.zoho_reminder_core_bindings') v")).v,null);
  });
 }finally{await f.close();}
});

async function forgeMetadata(f,invoiceId){
 const invoice=await f.store.getInvoice({...f.scope,invoiceId}),settings=(await f.supabase.from('workspace_settings').select('*').eq('workspace_id',f.ws).single()).data,customer=(await f.supabase.from('customers').select('id,name,phone,reminder_tone').eq('id',f.cust).single()).data;
 const d=prepareOwnerReminderContent({invoice,settings,customer}),delivery={type:'template',...d.template,body:d.preview,buttonVariant:false};
 await f.db.query("update invoices set followup_state='approved',next_follow_up_at=clock_timestamp()-interval '1 second',metadata=metadata||jsonb_build_object('followup_state','approved','next_follow_up_at',clock_timestamp()-interval '1 second','approved_reminder_delivery',$2::jsonb,'approved_reminder_text',$3::text,'approved_preferences_updated_at',$4::text) where id=$1",[invoiceId,delivery,d.approvalText,settings.updated_at]);
 return {settings,customer,delivery,body:d.preview};
}

test('installed missing-helper repair cannot bless owner metadata or changed versionless approval words into bound authority',async t=>{
 const f=await createZohoBoundReminderFixture({installedShape:true});try{
  for(const realApproval of [false,true])await t.test('saved real approval='+realApproval,async()=>{
   await f.db.exec('begin');f.reset();try{
    if(realApproval){await f.approve();await f.db.query("update invoices set metadata=metadata||jsonb_build_object('approved_reminder_text','Forged words'||chr(10)||chr(10)||'Offline company') where id=$1",[f.row.id]);}
    else await forgeMetadata(f,f.row.id);
    assert.notEqual((await f.run().catch(()=>({status:'blocked'}))).status,'sent');assert.deepEqual(f.counts(),{gets:0,posts:0});
    for(const table of ['cetld_core_automation_delivery_claims','app.zoho_bound_claims'])assert.equal(Number((await value(f,`select count(*) n from ${table}`)).n),0);
   }finally{f.reset();await f.db.exec('rollback');}
  });
 }finally{await f.close();}
});

test('repaired unwrapped final gate independently refuses crafted versionless service snapshots without a real owner approval receipt',async()=>{
 const f=await createZohoBoundReminderFixture({installedShape:true});try{
  const id=(await value(f,"insert into invoices(workspace_id,customer_id,customer_phone,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,'FORGED-LOCAL','2026-10-01','2026-10-20','USD',5,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[f.ws,f.cust,f.customerPhone])).id;
  const {settings,customer,delivery,body}=await forgeMetadata(f,id),scope={...f.scope,invoiceId:id};
  const [claim]=await f.store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});assert.ok(claim);
  assert.equal((await f.store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at})).authorized,true);
  const invoice=await f.store.getInvoice(scope),consent=(await f.supabase.from('whatsapp_consents').select('*').eq('workspace_id',f.ws).eq('customer_id',f.cust).single()).data;
  const snapshot={invoiceId:id,customerId:f.cust,phone:f.customerPhone,body,invoiceVersion:invoice.automation_version,invoiceUpdatedAt:invoice.updated_at,preferencesUpdatedAt:settings.updated_at,delivery,consentId:consent.id,consentCreatedAt:consent.created_at,
   template:{name:delivery.name,language:delivery.language,revision:delivery.revision,body:(await value(f,'select body from app.first_party_reminder_templates where name=$1 and revision=$2',[delivery.name,delivery.revision])).body,wabaId:f.env.WHATSAPP_WABA_ID,phoneNumberId:f.env.WHATSAPP_PHONE_NUMBER_ID,parameters:delivery.parameters},defaultDraft:buildDefaultInvoiceReminderDraft({invoice,settings,customer})};
  const r=await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{p_owner_id:f.owner,p_workspace_id:f.ws,p_claim_id:claim.id,p_snapshot:snapshot,p_snapshot_hash:reminderFingerprint(snapshot)});
  assert.equal(r.error,null);assert.equal(r.data.authorized,false);assert.equal(r.data.reason,'needs_re_review');assert.deepEqual(f.counts(),{gets:0,posts:0});
  assert.equal(Number((await value(f,'select count(*) n from app.first_party_reminder_dispatches')).n),0);
 }finally{await f.close();}
});
