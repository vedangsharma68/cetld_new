import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFollowUpPreferences, reminderBody} from '../automation/preferences.mjs';
import {resolveOwnerBinding} from '../automation/whatsapp/owner-binding.mjs';
import {createOwnerScopedStore} from '../ai/whatsapp-channel.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';
import {createConversationStore,parseMetaStatuses,conversationCallbackToken} from '../automation/whatsapp/conversation-store.mjs';
import {whatsappInbox,mergeWhatsAppMessages} from '../conversations-ui.mjs';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {installVerifiedOwnerRpc} from './fixtures/verified-owner-rpc.mjs';

const owner='00000000-0000-4000-8000-000000000001',workspace='00000000-0000-4000-8000-000000000002';
const customer='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004',factsInvoice='00000000-0000-4000-8000-000000000005';
const phone='+919871367051';
function fixture() {
  const tables={workspace_settings:[{workspace_id:workspace,whatsapp_owner_phone:phone,business_name:'Vedang Test Business'}],
    workspaces:[{id:workspace,owner_id:owner}],workspace_members:[{workspace_id:workspace,user_id:owner,role:'owner'}],
    whatsapp_owner_verifications:[{workspace_id:workspace,phone,requested_by:owner,verified_at:'2026-10-02',created_at:'2026-10-02'}],
    customers:[{id:customer,workspace_id:workspace,phone,metadata:{whatsapp_owner:true}}],
    whatsapp_global_suppressions:[],whatsapp_suppressions:[],whatsapp_consents:[{workspace_id:workspace,phone,customer_id:customer,revoked_at:null,consented_by:owner}],whatsapp_messages:[],
    invoices:[{id:customer,workspace_id:workspace,customer_id:customer,invoice_number:'INV-1'},
      {id:other,workspace_id:other,customer_id:other,invoice_number:'OTHER'}]};
  const db={tables,rpcs:[],rpcCalls:[],rpc:async(name,args)=>{db.rpcs.push({name,args});return {data:true};},
    from(table){let rows=tables[table]||[],filters=[],operation=null;
      const q={select(){return q},eq(key,value){filters.push(row=>row[key]===value);return q},
        is(key,value){filters.push(row=>(row[key]??null)===value);return q},
        not(key,op,value){filters.push(row=>(row[key]??null)!==value);return q},
        in(key,values){filters.push(row=>values.includes(row[key]));return q},
        order(){return q},range(){return q},limit(){return q},
        upsert(value){operation=()=>{if(!rows.some(row=>row.idempotency_key===value.idempotency_key&&row.workspace_id===value.workspace_id))rows.push({...value,id:String(rows.length)});return []};return q},
        update(patch){operation=()=>{for(const row of rows.filter(row=>filters.every(f=>f(row))))Object.assign(row,patch);return []};return q},
        maybeSingle(){return Promise.resolve({data:rows.find(row=>filters.every(f=>f(row)))||null})},
        then(resolve,reject){return Promise.resolve({data:operation?operation():rows.filter(row=>filters.every(f=>f(row)))}).then(resolve,reject)}};
      return q;
    }};
  installVerifiedOwnerRpc(db,()=>tables,{expectedPhone:phone});
  return db;
}

test('reminder copy requires the configured business and honors each tone', () => {
  for (const tone of ['gentle','professional','firm']) {
    const settings=normalizeFollowUpPreferences({tone,businessName:'Vedang Test Business'});
    assert.match(reminderBody({invoice_number:'INV-1'},settings),/Vedang Test Business/);
  }
  assert.throws(()=>reminderBody({invoice_number:'INV-1'},normalizeFollowUpPreferences({})),/business name/i);
});

test('custom reminder template is rendered into the branded owner-review draft',()=>{
  const settings=normalizeFollowUpPreferences({businessName:'Vedang Test Business',reminderTemplate:
    'Hello {{customer_name}}, invoice {{invoice_number}} has {{balance}} due {{due_date}}.'},'UTC');
  assert.equal(reminderBody({invoice_number:'INV-7',client:'Ada',balance:'₹2,500.00',due_date:'12 Oct 2026'},settings),
    'Hello Ada, invoice INV-7 has ₹2,500.00 due 12 Oct 2026.\n\nVedang Test Business');
  assert.throws(()=>normalizeFollowUpPreferences({businessName:'Business',reminderTemplate:'{{customer_phone}}'}),/placeholder/i);
});

test('configured owner is recognized from verified phone possession and changes revoke workspace reads',async()=>{
  const db=fixture();
  assert.deepEqual(await resolveOwnerBinding({supabase:db,phone}),{workspaceId:workspace,ownerId:owner,businessName:'Vedang Test Business',audience:'owner',customerId:customer});
  const store=createOwnerScopedStore({supabase:db,workspaceId:workspace,ownerId:owner,phone,
    authorize:async()=>Boolean(await resolveOwnerBinding({supabase:db,phone}))});
  assert.deepEqual((await store.query('invoices',{select:'id,invoice_number'})).map(row=>row.invoice_number),['INV-1']);
  db.tables.workspace_settings[0].whatsapp_owner_phone='+919999999999';
  await assert.rejects(store.query('invoices',{select:'id'}),/binding changed/);
});

test('owner lookup refuses an ambiguous phone, an invalid owner membership, or suppression',async()=>{
  const db=fixture();
  db.tables.workspace_settings.push({...db.tables.workspace_settings[0],workspace_id:other});
  db.tables.whatsapp_owner_verifications.push({workspace_id:other,phone,requested_by:owner,verified_at:'2026-10-02'});
  db.tables.workspaces.push({id:other,owner_id:owner});db.tables.workspace_members.push({workspace_id:other,user_id:owner,role:'owner'});
  db.tables.customers.push({id:other,workspace_id:other,phone,metadata:{whatsapp_owner:true}});
  db.tables.whatsapp_consents.push({workspace_id:other,phone,customer_id:other,revoked_at:null,consented_by:owner});
  assert.equal(await resolveOwnerBinding({supabase:db,phone}),null);
  db.tables.workspace_settings.pop();db.tables.whatsapp_owner_verifications.pop();db.tables.workspaces.pop();db.tables.workspace_members.pop();
  db.tables.customers.pop();db.tables.whatsapp_consents.pop();db.tables.workspace_members[0].role='admin';
  assert.equal(await resolveOwnerBinding({supabase:db,phone}),null);
  db.tables.workspace_members[0].role='owner';db.tables.whatsapp_global_suppressions.push({phone});
  assert.equal(await resolveOwnerBinding({supabase:db,phone}),null);
});

test('first owner message routes to their workspace and permanent history rather than QA customer scope',async()=>{
  const db=fixture(),seen=[],events=[{id:1,attempts:1,provider_message_id:'incoming',sender_phone:phone,
    message_text:'hi',message_type:'text',provider_timestamp:new Date().toISOString()}];
  const runtime=createInboundRuntime({supabase:db,inbox:{claim:async()=>events.splice(0,1),complete:async()=>{}},
    outbound:{sendTypingIndicator:async()=>{},sendServiceReply:async input=>{seen.push(input);return {status:'accepted'}}},
    onOwnerMessage:async input=>{assert.equal(input.ownerId,owner);return 'Hello owner.'},
    onBoundMessage:()=>{throw Error('must not route the owner as a customer')}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.equal(seen[0].workspaceId,workspace);assert.equal(seen[0].audience,'owner');
  assert.equal(db.tables.whatsapp_messages[0].audience,'owner');
  assert.equal(db.tables.whatsapp_messages[0].status,'received');
});

test('owner reply uses fresh owner authorization and stores exactly what Meta accepts',async()=>{
  const db=fixture(),payloads=[];
  const outbound=createWhatsAppOutbound({supabase:db,env:{WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,
    WHATSAPP_ACCESS_TOKEN:'test',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v23.0'},
    authorizeInboundReply:async()=>({allowed:true}),fetchImpl:async(url,options)=>{
      payloads.push(JSON.parse(options.body));return {ok:true,json:async()=>({messages:[{id:'sent-1'}]})};}});
  const result=await outbound.sendServiceReply({workspaceId:workspace,to:phone,body:'Your workspace is connected.',
    audience:'owner',kind:'normal',businessName:'Vedang Test Business',messageId:'inbound-1',lastInboundAt:new Date().toISOString()});
  assert.equal(result.status,'accepted');
  assert.equal(db.tables.whatsapp_messages[0].body,payloads[0].text.body);
  assert.equal(db.tables.whatsapp_messages[0].provider_message_id,'sent-1');
  assert.equal(db.tables.whatsapp_messages[0].status,'accepted');
  assert.equal(db.tables.whatsapp_messages[0].body,'Your workspace is connected.');
  assert.equal(payloads[0].text.body,'Your workspace is connected.');
});

test('signed callback extraction scopes statuses to this WABA and phone and inbox escapes message content',()=>{
  const payload={entry:[{id:'other',changes:[{field:'messages',value:{metadata:{phone_number_id:'phone'},statuses:[{id:'bad',recipient_id:'919871367051',status:'read'}]}}]},
    {id:'waba',changes:[{field:'messages',value:{metadata:{phone_number_id:'phone'},statuses:[{id:'ok',recipient_id:'919871367051',status:'delivered'}]}}]}]};
  assert.deepEqual(parseMetaStatuses(payload,'phone','waba'),[{messageId:'ok',phone,status:'delivered'}]);
  const html=whatsappInbox({messages:[{id:'1',phone,audience:'owner',direction:'outbound',body:'<script>alert(1)</script>',status:'accepted',created_at:new Date().toISOString()}]});
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('Accepted by Meta'));
});

test('database validates settings, isolates history, and keeps delivery statuses from regressing',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`
      create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema app;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      create table public.workspaces(id uuid primary key,owner_id uuid);
      create table public.workspace_members(workspace_id uuid,user_id uuid,role text);
      create function app.is_workspace_member(ws uuid) returns boolean language sql security definer as $$select exists(select 1 from public.workspace_members where workspace_id=ws and user_id=auth.uid())$$;
      create table public.workspace_settings(workspace_id uuid primary key,business_name text,default_timezone text default 'UTC',follow_up_preferences jsonb default '{}',updated_at timestamptz default now());
      create table public.customers(id uuid primary key,workspace_id uuid,phone text);
      create table public.invoices(id uuid primary key,workspace_id uuid,customer_id uuid,invoice_number text,issue_date date,due_date date,
        currency text default 'INR',total_amount numeric,amount_paid numeric default 0,status text default 'draft',metadata jsonb default '{}');
      create table public.whatsapp_global_suppressions(phone text primary key,source_message_id text);
      create table public.whatsapp_suppressions(phone text,workspace_id uuid);
      create table public.whatsapp_invoice_update_claims(workspace_id uuid,invoice_id uuid,idempotency_key text,unique(workspace_id,invoice_id,idempotency_key));
      create function public.whatsapp_claim_invoice_update(ws uuid,inv uuid,c uuid,p text,k text,revision timestamptz)
        returns boolean language plpgsql as $$declare affected int;begin
          if revision='2000-01-01'::timestamptz then return false;end if;
          insert into public.whatsapp_invoice_update_claims values(ws,inv,k)on conflict do nothing;
          get diagnostics affected=row_count;return affected>0;end;$$;
      insert into auth.users values('${owner}');insert into public.workspaces values('${workspace}','${owner}'),('${other}','${other}');
      insert into public.workspace_members values('${workspace}','${owner}','owner');
      insert into public.workspace_settings(workspace_id,business_name)values('${workspace}','Vedang Test Business'),('${other}','Other Business');
      insert into public.customers values('${customer}','${workspace}','${phone}');
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/20260927140000_core_followup_pipeline.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20260927110000_whatsapp_inbound_events.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261002020102_owner_followup_conversations.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261003140200_followup_message_template.sql',import.meta.url),'utf8'));
    await db.exec(`update public.workspace_settings set follow_up_preferences=jsonb_build_object('reminderTemplate',E'Hello\\r\\n{{customer_name}}\\t{{business_name}}') where workspace_id='${workspace}'`);
    assert.equal((await db.query(`select follow_up_preferences->>'reminderTemplate' as template from public.workspace_settings where workspace_id='${workspace}'`)).rows[0].template,
      'Hello\n{{customer_name}} {{business_name}}');
    await db.exec(`update public.workspace_settings set follow_up_preferences=jsonb_build_object('reminderTemplate','A — B') where workspace_id='${workspace}'`);
    assert.equal((await db.query(`select follow_up_preferences->>'reminderTemplate' as template from public.workspace_settings where workspace_id='${workspace}'`)).rows[0].template,'A, B');
    await assert.rejects(db.exec(`update public.workspace_settings set follow_up_preferences=jsonb_build_object('reminderTemplate','{{account_number}}') where workspace_id='${workspace}'`),/placeholder/i);
    await assert.rejects(db.exec(`update public.workspace_settings set follow_up_preferences=jsonb_build_object('reminderTemplate',repeat('x',1001)) where workspace_id='${workspace}'`),/1,000 characters/i);
    await assert.rejects(db.exec(`update public.workspace_settings set follow_up_preferences=jsonb_build_object('reminderTemplate','line'||chr(1)) where workspace_id='${workspace}'`),/control character/i);
    await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false);
      update public.workspace_settings set follow_up_preferences=jsonb_build_object('reminderTemplate','Owner template {{invoice_number}}') where workspace_id='${workspace}';
      select set_config('request.jwt.claim.sub','',false)`);
    assert.equal((await db.query(`select follow_up_preferences->>'reminderTemplate' as template from public.workspace_settings where workspace_id='${workspace}'`)).rows[0].template,
      'Owner template {{invoice_number}}');
    await db.exec(`update public.workspace_settings set whatsapp_owner_phone='${phone}' where workspace_id='${workspace}'`);
    await db.exec(`insert into public.invoices(id,workspace_id,customer_id,total_amount,due_date,status,metadata)
      values('${factsInvoice}','${workspace}','${customer}',100,current_date+5,'sent',jsonb_build_object(
        'invoice_direction','receivable','followup_state','approved','reminder_text','Old rendered draft',
        'approved_reminder_text','Old approved draft'||chr(10)||chr(10)||'Vedang Test Business',
        'approved_preferences_updated_at',now()))`);
    await db.exec(`update public.invoices set total_amount=125,due_date=due_date+2,
      metadata=jsonb_set(metadata,'{client_name}',to_jsonb('New customer'::text),true)
      where id='${factsInvoice}'`);
    const invalidatedFacts=(await db.query(`select followup_state,next_follow_up_at,total_amount,
      metadata->>'client_name' as client_name,metadata->>'reminder_text' as draft,
      metadata->>'approved_reminder_text' as approved,
      metadata->>'approved_preferences_updated_at' as approved_preferences_updated_at
      from public.invoices where id='${factsInvoice}'`)).rows[0];
    assert.equal(invalidatedFacts.followup_state,'draft');
    assert.equal(invalidatedFacts.next_follow_up_at,null);
    assert.equal(Number(invalidatedFacts.total_amount),125);
    assert.equal(invalidatedFacts.client_name,'New customer');
    assert.equal(invalidatedFacts.draft,null);
    assert.equal(invalidatedFacts.approved,null);
    assert.equal(invalidatedFacts.approved_preferences_updated_at,null);
    // Exercise approval, reply policy, and business changes through real triggers.
    await db.exec(`insert into public.invoices(id,workspace_id,customer_id,total_amount,due_date,status,metadata)
      values('${customer}','${workspace}','${customer}',100,current_date+1,'sent','{"invoice_direction":"receivable"}')`);
    await assert.rejects(db.exec(`update public.invoices set metadata=metadata||'{"followup_state":"approved","approved_reminder_text":"Unsigned"}'
      where id='${customer}'`),/business name/i);
    await assert.rejects(db.exec(`update public.invoices set metadata=metadata||jsonb_build_object('followup_state','approved',
      'approved_reminder_text','Reminder'||chr(10)||chr(10)||'— Vedang Test Business') where id='${customer}'`),/business name/i);
    const approve=()=>db.exec(`update public.invoices set metadata=metadata||jsonb_build_object('followup_state','approved',
      'approved_reminder_text','Reminder'||chr(10)||chr(10)||'Vedang Test Business') where id='${customer}'`);
    await db.exec(`update public.workspace_settings set follow_up_preferences='{"pauseOnReply":false}' where workspace_id='${workspace}'`);
    await approve();
    await db.exec(`select public.whatsapp_pause_customer_followups('${workspace}','${customer}','reply-no-pause')`);
    assert.equal((await db.query(`select followup_state from public.invoices where id='${customer}'`)).rows[0].followup_state,'approved');
    await db.exec(`update public.workspace_settings set follow_up_preferences='{"pauseOnReply":true}' where workspace_id='${workspace}'`);
    await approve();
    await db.exec(`select public.whatsapp_pause_customer_followups('${workspace}','${customer}','reply-pause')`);
    const paused=(await db.query(`select followup_state,next_follow_up_at,metadata->>'approved_reminder_text' as approved from public.invoices where id='${customer}'`)).rows[0];
    assert.deepEqual(paused,{followup_state:'paused',next_follow_up_at:null,approved:null});
    await approve();
    await db.exec(`update public.workspace_settings set business_name='CETLD test' where workspace_id='${workspace}'`);
    assert.equal((await db.query(`select followup_state from public.invoices where id='${customer}'`)).rows[0].followup_state,'paused');
    await db.exec(`update public.workspace_settings set business_name='Vedang Test Business' where workspace_id='${workspace}'`);
    await approve();
    await db.exec(`update public.invoices set metadata=metadata||'{"reminder_text":"Old wording"}' where id='${customer}'`);
    await db.exec(`update public.workspace_settings set follow_up_preferences=follow_up_preferences||jsonb_build_object('reminderTemplate','Hi {{customer_name}} {{invoice_number}} {{balance}} {{due_date}}') where workspace_id='${workspace}'`);
    const changedTemplate=(await db.query(`select followup_state,metadata->>'approved_reminder_text' as approved,metadata->>'reminder_text' as draft from public.invoices where id='${customer}'`)).rows[0];
    assert.deepEqual(changedTemplate,{followup_state:'paused',approved:null,draft:null});
    await db.exec(`update public.invoices set amount_paid=100 where id='${customer}'`);await approve();
    assert.equal((await db.query(`select followup_state from public.invoices where id='${customer}'`)).rows[0].followup_state,'cancelled');
    await db.exec(`insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,status)
      values('owner-claim','123456','${phone}','text','processing')`);
    assert.equal((await db.query(`select public.whatsapp_claim_owner_reply('owner-claim','${phone}','${workspace}') as claimed`)).rows[0].claimed,true);
    assert.equal((await db.query(`select public.whatsapp_claim_owner_reply('owner-claim','${phone}','${workspace}') as claimed`)).rows[0].claimed,false);
    await assert.rejects(db.exec(`update public.workspace_settings set business_name=null where workspace_id='${workspace}'`),/business name/i);
    await assert.rejects(db.exec(`update public.workspace_settings set follow_up_preferences='{"cadenceDays":0}' where workspace_id='${workspace}'`),/timing/i);
    await assert.rejects(db.exec(`update public.workspace_settings set whatsapp_owner_phone='${phone}' where workspace_id='${other}'`),/unique/i);
    await db.exec(`insert into public.whatsapp_messages(workspace_id,phone,direction,body,kind,status,idempotency_key,provider_message_id)
      values('${workspace}','${phone}','outbound','Test','text','accepted','test','provider-id')`);
    await db.exec(`select public.whatsapp_record_delivery_status('provider-id','${phone}','read');
      select public.whatsapp_record_delivery_status('provider-id','${phone}','sent')`);
    assert.equal((await db.query('select status from public.whatsapp_messages')).rows[0].status,'read');
    await db.exec(`insert into public.whatsapp_messages(workspace_id,phone,direction,body,kind,status,idempotency_key,callback_token)
      values('${workspace}','${phone}','outbound','Recover me','text','pending','recover','${'a'.repeat(64)}')`);
    await db.exec(`select public.whatsapp_record_delivery_status('recover-id','+919999999999','read','${'a'.repeat(64)}')`);
    assert.equal((await db.query("select provider_message_id from public.whatsapp_messages where idempotency_key='recover'")).rows[0].provider_message_id,null);
    await db.exec(`select public.whatsapp_record_delivery_status('recover-id','${phone}','delivered','${'a'.repeat(64)}')`);
    const recovered=(await db.query("select provider_message_id,status from public.whatsapp_messages where idempotency_key='recover'")).rows[0];
    assert.deepEqual(recovered,{provider_message_id:'recover-id',status:'delivered'});
    await db.exec(`insert into public.whatsapp_messages(workspace_id,phone,direction,body,kind,status,idempotency_key)
      values('${workspace}','${phone}','outbound','In flight','normal','pending','reply:owner-claim'),
        ('${workspace}','${phone}','outbound','Not allowed','normal','pending','reply:not-claimed');
      select public.whatsapp_block_unclaimed_reply('${workspace}','owner-claim');
      select public.whatsapp_block_unclaimed_reply('${workspace}','not-claimed')`);
    assert.equal((await db.query("select status from public.whatsapp_messages where idempotency_key='reply:owner-claim'")).rows[0].status,'pending');
    assert.equal((await db.query("select status from public.whatsapp_messages where idempotency_key='reply:not-claimed'")).rows[0].status,'blocked');
    await db.exec(`insert into public.whatsapp_messages(workspace_id,customer_id,invoice_id,phone,direction,audience,body,kind,status,idempotency_key)
      values('${workspace}','${customer}','${customer}','${phone}','outbound','customer','Stale template','invoice_update','pending','template:stale-template'),
        ('${workspace}','${customer}','${customer}','${phone}','outbound','customer','In-flight template','invoice_update','pending','template:claimed-template');
      select public.whatsapp_claim_logged_invoice_update('${workspace}','${customer}','${customer}','${phone}','stale-template','2000-01-01');
      select public.whatsapp_claim_logged_invoice_update('${workspace}','${customer}','${customer}','${phone}','claimed-template','2026-10-02');
      select public.whatsapp_claim_logged_invoice_update('${workspace}','${customer}','${customer}','${phone}','claimed-template','2026-10-02')`);
    assert.equal((await db.query("select status from public.whatsapp_messages where idempotency_key='template:stale-template'")).rows[0].status,'blocked');
    assert.equal((await db.query("select status from public.whatsapp_messages where idempotency_key='template:claimed-template'")).rows[0].status,'pending');
    await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
    await assert.rejects(db.exec(`update public.workspace_settings set follow_up_preferences=follow_up_preferences||jsonb_build_object('reminderTemplate','Unauthorized') where workspace_id='${workspace}'`),/owner/i);
    await assert.rejects(db.exec(`update public.workspace_settings set whatsapp_owner_phone=null where workspace_id='${workspace}'`),/owner/i);
    await db.exec(`select set_config('request.jwt.claim.sub','',false)`);
    await db.exec(`select public.whatsapp_pause_customer_followups('${workspace}','${customer}','incoming-summary');
      select public.whatsapp_pause_customer_followups('${workspace}','${customer}','incoming-summary')`);
    assert.equal((await db.query("select count(*)::int as count from public.cetld_core_automation_events where type='customer_reply' and idempotency_key='whatsapp_reply:incoming-summary'")).rows[0].count,1);
    await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${other}',false)`);
    assert.equal((await db.query('select * from public.whatsapp_messages')).rows.length,0);
    await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
    assert.equal((await db.query('select * from public.whatsapp_messages')).rows.length,6);
    await assert.rejects(db.exec(`update public.whatsapp_messages set body='forged'`),/permission denied/i);
  }finally{await db.close();}
});


const outboundEnv={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'test',
  WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v23.0'};
const ownerReply=()=>({workspaceId:workspace,to:phone,body:'Hello.',audience:'owner',businessName:'Vedang Test Business',
  messageId:'retry-history',lastInboundAt:new Date().toISOString()});

test('a history outage happens before the reply claim and an unsent reply remains retryable',async()=>{
  const db=fixture(),store=createConversationStore(db);
  let outage=true,claims=0,sends=0;
  const outbound=createWhatsAppOutbound({supabase:db,env:outboundEnv,conversationStore:{
    ...store,record:async input=>{if(outage)throw Error('history unavailable');return store.record(input);}},
    authorizeInboundReply:async()=>({allowed:++claims===1}),fetchImpl:async()=>{sends++;return {ok:true,json:async()=>({messages:[{id:'recovered-send'}]})}}});
  await assert.rejects(outbound.sendServiceReply(ownerReply()),/history unavailable/);
  assert.equal(claims,0);assert.equal(sends,0);
  outage=false;assert.equal((await outbound.sendServiceReply(ownerReply())).status,'accepted');
  assert.equal(claims,1);assert.equal(sends,1);
});

test('an accepted receipt outage preserves callback correlation without retrying Graph',async()=>{
  const db=fixture(),store=createConversationStore(db);let sends=0,claims=0,payload;
  const outbound=createWhatsAppOutbound({supabase:db,env:outboundEnv,logger:{error(){}},
    conversationStore:{...store,finish:async()=>{throw Error('receipt temporarily unavailable')}},
    authorizeInboundReply:async()=>({allowed:++claims===1}),fetchImpl:async(url,options)=>{
      payload=JSON.parse(options.body);sends++;return {ok:true,json:async()=>({messages:[{id:'accepted-id'}]})};}});
  const result=await outbound.sendServiceReply(ownerReply());
  assert.equal(result.status,'accepted');assert.equal(result.historySyncPending,true);
  assert.equal(sends,1);assert.equal(db.tables.whatsapp_messages[0].callback_token,payload.biz_opaque_callback_data);
  assert.equal(payload.biz_opaque_callback_data,conversationCallbackToken(workspace,'reply:retry-history'));
  assert.equal((await outbound.sendServiceReply(ownerReply())).status,'blocked');assert.equal(sends,1);
  const statuses=parseMetaStatuses({entry:[{id:'waba',changes:[{field:'messages',value:{metadata:{phone_number_id:'pid'},
    statuses:[{id:'accepted-id',recipient_id:phone.slice(1),status:'delivered',biz_opaque_callback_data:payload.biz_opaque_callback_data}]}}]}]},'pid','waba');
  assert.equal(statuses[0].callbackToken,payload.biz_opaque_callback_data);
  await store.status(statuses[0]);assert.equal(db.rpcs.at(-1).args.p_callback_token,payload.biz_opaque_callback_data);
});

test('a suppressed owner STOP remains in permanent history without authorizing a normal reply',async()=>{
  const db=fixture();
  db.tables.whatsapp_global_suppressions.push({phone});
  const events=[{id:1,attempts:1,provider_message_id:'owner-stop',sender_phone:phone,message_type:'text',
    message_text:'STOP',stop_processed_at:new Date().toISOString(),stop_confirmation_due:false,
    provider_timestamp:new Date().toISOString()}];
  const runtime=createInboundRuntime({supabase:db,inbox:{claim:async()=>events.splice(0,1),complete:async()=>{}},
    outbound:{sendServiceReply:()=>{throw Error('No reply due')}}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.equal(db.tables.whatsapp_messages[0].body,'STOP');assert.equal(db.tables.whatsapp_messages[0].audience,'owner');
  assert.equal(await resolveOwnerBinding({supabase:db,phone}),null);
});

test('retrying a saved owner response after rebinding as a customer cannot expose owner data',async()=>{
  const db=fixture(),store=createConversationStore(db);let claims=0,sends=0;
  await store.record({workspaceId:workspace,phone,direction:'outbound',audience:'owner',body:'Owner-only ledger answer.\n\nVedang Test Business',
    kind:'normal',status:'pending',key:'reply:retry-history'});
  db.tables.workspace_settings[0].whatsapp_owner_phone=null;
  db.tables.workspace_settings[0].whatsapp_owner_attested_at=new Date().toISOString();
  db.tables.whatsapp_consents=[];db.tables.whatsapp_consents.push({workspace_id:workspace,customer_id:customer,phone,source:'verbal',categories:['invoice_updates'],revoked_at:null});
  db.tables.customers=[{id:customer,workspace_id:workspace,phone}];
  const outbound=createWhatsAppOutbound({supabase:db,env:outboundEnv,
    authorizeInboundReply:async()=>{claims++;return {allowed:true}},fetchImpl:async()=>{sends++;throw Error('Must not send')}});
  await assert.rejects(outbound.sendServiceReply({...ownerReply(),audience:'customer',body:'Customer-scoped answer.'}),/recipient scope changed/);
  assert.equal(claims,0);assert.equal(sends,0);
});

test('changing a customer binding during reply authorization blocks text and media before dispatch',async()=>{
  for(const mediaReply of [false,true]){
    const db=fixture();let messageSends=0;
    db.tables.workspace_settings[0].whatsapp_owner_phone=null;
    db.tables.workspace_settings[0].whatsapp_owner_attested_at=new Date().toISOString();
    db.tables.whatsapp_consents=[];db.tables.whatsapp_consents.push({workspace_id:workspace,customer_id:customer,phone,source:'verbal',categories:['invoice_updates'],revoked_at:null});
    db.tables.customers=[{id:customer,workspace_id:workspace,phone},{id:other,workspace_id:workspace,phone}];
    const outbound=createWhatsAppOutbound({supabase:db,env:outboundEnv,authorizeInboundReply:async()=>{
      db.tables.whatsapp_consents[0].customer_id=other;return {allowed:true};},
      fetchImpl:async url=>{if(url.endsWith('/media'))return {ok:true,json:async()=>({id:'upload'})};
        messageSends++;throw Error('No messages should be dispatched');}});
    const input={...ownerReply(),audience:'customer',caption:'Your invoice.',media:{bytes:new Uint8Array([1]),mime_type:'application/pdf'}};
    const result=await (mediaReply?outbound.sendServiceMedia(input):outbound.sendServiceReply(input));
    assert.equal(result.status,'blocked');assert.equal(result.reason,'customer_binding_changed');assert.equal(messageSends,0);
    assert.equal(db.tables.whatsapp_messages[0].status,'blocked');
  }
});


test('a newly linked owner receives invoice files without a client attestation and history keeps the owner audience',async()=>{
 const db=fixture();let sends=0;
 const outbound=createWhatsAppOutbound({supabase:db,env:outboundEnv,
  authorizeInboundReply:async input=>{assert.equal(input.audience,'owner');return {allowed:true}},
  fetchImpl:async(url,options)=>{
   if(url.endsWith('/media'))return {ok:true,json:async()=>({id:'uploaded-file'})};
   const body=JSON.parse(options.body);assert.equal(body.document.id,'uploaded-file');sends++;
   return {ok:true,json:async()=>({messages:[{id:'owner-file'}]})};
  }});
 const result=await outbound.sendServiceMedia({...ownerReply(),media:{bytes:Buffer.from('test'),mime_type:'application/pdf',file_name:'invoice.pdf'},caption:'Here is your invoice.'});
 assert.equal(result.status,'accepted');assert.equal(sends,1);assert.equal(db.tables.whatsapp_messages[0].audience,'owner');
 assert.equal(db.tables.whatsapp_messages[0].customer_id,null);
});
test('an editable owner customer flag without verified phone possession never grants owner access',async()=>{
 const db=fixture();db.tables.whatsapp_owner_verifications=[];
 assert.equal(await resolveOwnerBinding({supabase:db,phone}),null);
});


test('history refresh retains older messages, updates receipts, and sorts same-time numeric IDs correctly',()=>{
 const base={created_at:'2026-10-02T01:00:00Z',phone,audience:'owner',direction:'outbound'};
 const old=[{...base,id:'9',body:'Nine',status:'accepted'},{...base,id:'10',body:'Ten',status:'sent'}];
 const rows=mergeWhatsAppMessages(old,[{...base,id:'10',body:'Ten',status:'read'},{...base,id:'11',body:'Eleven',status:'sent'}]);
 assert.deepEqual(rows.map(row=>row.id),['11','10','9']);assert.equal(rows[1].status,'read');
 const html=whatsappInbox({messages:rows});assert.ok(html.indexOf('Nine')<html.indexOf('Ten'));assert.ok(html.indexOf('Ten')<html.indexOf('Eleven'));
});


test('history cursor selects the oldest full-precision timestamp even when transaction IDs are reversed',()=>{
 const rows=mergeWhatsAppMessages([],[
  {id:'1',created_at:'2026-10-02T01:00:00.123999+00:00'},
  {id:'2',created_at:'2026-10-02T01:00:00.123001+00:00'},
  {id:'3',created_at:'2026-10-02T06:30:00.123001+05:30'}
 ]);
 assert.deepEqual(rows.map(row=>row.id),['1','3','2']);assert.equal(rows.at(-1).id,'2');
});
