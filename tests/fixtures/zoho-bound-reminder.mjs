import {createClient} from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readdir,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './offline-sql-network.mjs';
import {SupabaseAccountingStore,TokenCipher,connectionAad,createAccountingIntegration} from '../../automation/accounting/index.mjs';
import {CoreAutomationStore} from '../../automation/core-store.mjs';
import {FollowUpEngine} from '../../automation/engine.mjs';
import {createFirstPartyReminderRuntime} from '../../automation/first-party-reminder-runtime.mjs';
import {createOwnerReminderRuntime} from '../../automation/whatsapp/owner-reminders.mjs';
export async function createZohoBoundReminderFixture({installBridge=true,crlf=false}={}){
let gets=0,posts=0;let row;const controls={remote:null,onGet:null,onPost:null,afterHttp:null,beforeHttp:null},postBodies=[];
const database=new PGlite();
await database.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
 grant usage on schema auth,storage to authenticated,anon,service_role;
 grant select on auth.users to service_role;
 grant execute on function auth.uid(),auth.role() to authenticated,anon,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;`);
const f=await createOfflineSqlNetwork({database,externalFetch:async(url,options)=>{
 if(url.origin==='https://www.zohoapis.in'){gets++;assert.equal(url.pathname,'/books/v3/invoices/99001');assert.equal(url.searchParams.get('organization_id'),'90001');assert.equal(options.redirect,'error');await controls.onGet?.();if(controls.remote instanceof Response)return controls.remote;
 const remote={invoice_id:'99001',customer_id:'88001',currency_code:'USD',total:5,payment_made:0,balance:5,status:'sent',date:'2026-10-01',due_date:'2026-10-20',reference_number:`cetld:${row.id}`,credits_applied:0,write_off_amount:0,...controls.remote};return Response.json({code:0,invoice:remote});}
 if(url.origin==='https://graph.facebook.com'){posts++;assert.equal(url.pathname,'/v23.0/123456789/messages');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');postBodies.push(JSON.parse(options.body));if(controls.onPost)return controls.onPost();return Response.json({messages:[{id:'wamid.offline.capture.1'}]});}
 throw Error('NETWORK SENTINEL');
}});
const transport=async(input,options)=>{options=await controls.beforeHttp?.(new URL(String(input)),options)||options;const r=await f.fetchImpl(input,options);await controls.afterHttp?.(new URL(String(input)),options,r);return r;};
f.supabase=createClient('https://fixture.supabase.test','offline-service',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:transport}});
try{
// Exact chronological main + held PR204 chain, never reinstall an earlier
// optional sender after a later security patch.
for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
if(name==='20261027100000_zoho_first_party_reminder_bridge.sql'&&!installBridge)continue;
if(crlf&&name==='20261026090000_contain_unproven_external_reminders.sql')for(const sig of ['cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)','cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)']){const p=(await f.db.query('select pg_get_functiondef(oid) d,prosrc from pg_proc where oid=$1::regprocedure',[sig])).rows[0];await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc.replaceAll('\n','\r\n')));}
await f.db.exec((await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
}
await f.db.exec('grant all on all tables in schema public to service_role;grant all on all sequences in schema public to service_role');
const owner=randomUUID(),ownerPhone='+12025550107',customerPhone='+919871367051';
await f.db.query('insert into auth.users(id) values($1)',[owner]);
await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
const ws=(await f.db.query("select (create_workspace('Offline bridge',$1)).id",[randomUUID()])).rows[0].id;
const verification=(await f.db.query('select * from owner_start_whatsapp_verification($1,$2)',[ws,ownerPhone])).rows[0];
await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
assert.equal((await f.db.query('select whatsapp_verify_owner_code($1,$2) value',[ownerPhone,verification.code])).rows[0].value.ok,true);
const cust=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Offline client',$2) returning id",[ws,customerPhone])).rows[0].id;
await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,categories,source,consent_text_version) values($1,$2,$3,array['invoice_updates'],'inbound_message','offline-v1')",[ws,cust,customerPhone]);
await f.db.query("update workspace_settings set business_name='Offline company',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[ws,{tone:'professional',contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:3,firstReminderDays:0}]);
row=(await f.db.query("insert into invoices(workspace_id,customer_id,customer_phone,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,'ORIGIN-1','2026-10-01','2026-10-20','USD',5,'sent','{\"invoice_direction\":\"receivable\"}') returning *",[ws,cust,customerPhone])).rows[0];
const ast=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'offline-service',fetchImpl:transport}),cipher=new TokenCipher(Buffer.alloc(32,7)),identity={userId:owner,workspaceId:ws,provider:'zoho_books'};
const token={accessToken:'offline-secret',refreshToken:'offline-refresh',expiresAt:Date.now()+3600000,region:'in',apiDomain:'https://www.zohoapis.in',accountsDomain:'https://accounts.zoho.in'};
await ast.insertConnection({...identity,providerAccountId:'90001',status:'connected',region:'in',apiDomain:token.apiDomain,accountsDomain:token.accountsDomain,tokenExpiresAt:token.expiresAt,...cipher.encrypt(token,connectionAad('zoho_books',ws))});
const epoch=(await ast.zohoOperationContext(identity)).epochId;
const op=await ast.captureCompletionProtocol(identity,row.id,'reserve',{p_expected_updated_at:row.updated_at,p_expected_version:row.automation_version,p_expected_epoch:epoch});
const start=await ast.captureCompletionProtocol(identity,row.id,'start',{p_operation_id:op.operationId});
await ast.captureCompletionProtocol(identity,row.id,'complete',{p_operation_id:op.operationId,p_capture_nonce:start.captureNonce,p_outcome:'captured',p_external_id:'99001',p_customer_external_id:'88001',p_currency:'USD',p_total:5,p_paid:0,p_balance:5,p_status:'sent',p_date:row.issue_date,p_due_date:row.due_date,p_reference:`cetld:${row.id}`,p_remote_number:row.invoice_number});
const integration=createAccountingIntegration({store:ast,cipher}),scope={ownerId:owner,workspaceId:ws,phone:ownerPhone};
const rt=async(message)=>{const messageId='offline-owner-'+randomUUID();await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,ownerPhone,message]);return createOwnerReminderRuntime({supabase:f.supabase,scope,message,messageId,authorize:async()=>true});};
const approve=async()=>{
 const prepared=await (await rt('send reminder')).execute({operation:'sendReminderNow',filters:[{column:'id',operator:'eq',value:row.id}]});
 assert.equal(prepared.ok,true,JSON.stringify(prepared));
 const pending=(await f.db.query('select * from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null order by generation desc limit 1',[ws])).rows[0];
 const approved=await (await rt('yes')).decide({pending,decision:'confirm'});assert.equal(approved.ok,true,JSON.stringify(approved));return {prepared,approved};
};
const env={WHATSAPP_PROVIDER:'first_party_meta',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_GRAPH_API_VERSION:'v23.0',WHATSAPP_ACCESS_TOKEN:'offline-graph',WHATSAPP_TEST_ALLOWLIST:customerPhone,AUTOMATION_WORKSPACES:JSON.stringify([scope])};
const store=new CoreAutomationStore({url:'https://fixture.supabase.test',key:'offline-service',fetchImpl:transport});
const makeRuntime=(options={})=>createFirstPartyReminderRuntime({env,scope,store,supabase:f.supabase,accounting:options.accounting||integration,fetchImpl:transport});
const run=async(options)=>{const runtime=makeRuntime(options);return new FollowUpEngine({store:runtime.store,provider:runtime.provider,paymentChecker:runtime.paymentChecker}).run({...scope,invoiceId:row.id});};
return {...f,transport,controls,postBodies,ast,cipher,identity,token,integration,owner,ownerPhone,customerPhone,cust,ws,row,env,scope,store,rt,approve,run,makeRuntime,counts:()=>({gets,posts}),reset:()=>{gets=0;posts=0;postBodies.length=0;Object.assign(controls,{remote:null,onGet:null,onPost:null,afterHttp:null,beforeHttp:null});f.intercept(null);},read:async()=>(await f.db.query('select * from invoices where id=$1',[row.id])).rows[0]};
}catch(e){await f.close();throw e;}
}
