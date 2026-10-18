import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createInboundRuntime, SupabaseInboundInbox, isResubscribe, isOptOut} from '../automation/whatsapp/cloud-inbound.mjs';
import {getSendEligibility} from '../automation/whatsapp/consent.mjs';

const phone = '+919871367051';
const logger = {log(){}, warn(){}, error(){}};

test('verified owner STOP → START/UNSTOP preserves proof and resumes normal owner turns', async () => {
  const deliveries=[];
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    assert.equal(url.origin,'https://graph.facebook.com');
    const payload=JSON.parse(options.body);
    if(payload.to)assert.equal(payload.to,phone.slice(1));
    deliveries.push(payload);
    return Response.json({messages:[{id:`wamid.owner.reply.${deliveries.length}`}]});
  }});
  try {
    const {db,supabase}=f,ownerId=randomUUID();
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (create_workspace('Disposable consent QA','consent-qa')).id")).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const resolve=async()=>(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows;
    const binding=await resolve();
    assert.equal(binding.length,1);assert.equal(binding[0].workspace_id,workspaceId);
    const customers=(await db.query('select * from customers order by id')).rows;
    const proofs=(await db.query('select * from whatsapp_owner_verifications order by id')).rows;
    await db.query("update whatsapp_consents set source='inbound_message' where workspace_id=$1",[workspaceId]);
    const consentBefore=(await db.query('select * from whatsapp_consents')).rows[0];
    assert.equal(consentBefore.consented_by,ownerId);
    assert.equal(consentBefore.consent_text_version,'owner_binding_v1');
    assert.equal(consentBefore.source,'inbound_message');
    // It is function-only and idempotent even with an existing verified owner.
    const migration=await readFile(new URL('../supabase/migrations/20261018215058_whatsapp_start_preserve_owner_binding.sql',import.meta.url),'utf8');
    await db.exec(migration);await db.exec(migration);
    assert.deepEqual((await db.query('select * from whatsapp_consents')).rows,[consentBefore]);
    let ownerCalls=0,modelCalls=0;
    const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger,
      providerFactory:()=>({async generate(){modelCalls++;return {model:CF_PRIMARY_MODEL,content:'Your owner connection is active.'};}})});
    const inbox=new SupabaseInboundInbox(supabase);
    const runtime=createInboundRuntime({supabase,inbox,fetchImpl:f.fetchImpl,logger,
      env:{WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'offline-fixture',
        WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_GRAPH_API_VERSION:'v24.0'},
      onOwnerMessage:async args=>{ownerCalls++;assert.equal(args.workspaceId,workspaceId);assert.equal(args.ownerId,ownerId);return handler(args);},
      onBoundMessage:()=>{throw Error('Verified owner must not enter the customer handler');}});
    let sequence=0;
    const event=async text=>(await inbox.enqueue([{provider_message_id:`wamid.owner.consent.${++sequence}`,
      phone_number_id:'1234567890',sender_phone:phone,message_type:'text',message_text:text,
      provider_timestamp:new Date().toISOString()}]))[0];
    for(const keyword of ['START','UNSTOP']) {
      const callsBefore=ownerCalls;
      await runtime.revokeOptOut(await event('STOP'));
      assert.equal((await runtime.processPending()).completed,1);
      assert.deepEqual(await resolve(),[]);
      const revoked=(await db.query('select * from whatsapp_consents')).rows[0];
      assert.ok(revoked.revoked_at);assert.equal(revoked.revoked_via,'stop');
      assert.equal(revoked.consented_by,ownerId);
      await event('Are you there?');
      assert.equal((await runtime.processPending()).completed,1);
      assert.equal(ownerCalls,callsBefore);
      await event(keyword);
      assert.equal((await runtime.processPending()).completed,1);
      assert.deepEqual(await resolve(),binding);
      const restored=(await db.query('select * from whatsapp_consents')).rows[0];
      assert.equal(restored.consented_by,ownerId);assert.equal(restored.revoked_at,null);
      assert.equal(restored.revoked_via,null);assert.ok(restored.consented_at>=consentBefore.consented_at);
      assert.deepEqual(restored.categories,consentBefore.categories);
      const text=await event('Is my owner connection active?');
      assert.equal((await runtime.processPending()).completed,1);
      assert.equal(ownerCalls,callsBefore+1);
      const saved=(await db.query('select * from whatsapp_inbound_events where id=$1',[text.id])).rows[0];
      assert.equal(saved.status,'done');assert.equal(saved.error_code,null);
      assert.ok(deliveries.some(payload=>payload.text?.body==='Your owner connection is active.'));
      assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='owner' and direction='outbound' and body='Your owner connection is active.' and status='accepted'")).rows[0].n,ownerCalls);
    }
    assert.ok(modelCalls>=2);
    assert.deepEqual((await db.query('select * from customers order by id')).rows,customers);
    assert.deepEqual((await db.query('select * from whatsapp_owner_verifications order by id')).rows,proofs);
    assert.equal(f.errors.length,0,JSON.stringify(f.errors));
  } finally {await f.close();}
});

test('resubscribe accepts only standalone START/UNSTOP, leaving STOP recognition intact', () => {
  for (const text of ['START', 'unstop', '  StArT\n']) assert.equal(isResubscribe(text), true);
  for (const text of ['', 'restart', 'START invoice', 'do not START', 'UNSTOP please', 'STOP', null])
    assert.equal(isResubscribe(text), false);
  for (const text of ['STOP', 'unsubscribe', 'Please stop messaging me!']) assert.equal(isOptOut(text), true);
});

test('offline PostgreSQL and real inbound/outbound stores cover STOP → START/UNSTOP safely', async t => {
  const graph = [];
  const f = await createOfflineSqlNetwork({externalFetch: async (url, options) => {
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(options.method, 'POST');
    const payload = JSON.parse(options.body);
    assert.equal(payload.to, phone.slice(1)); // Never forward any request to a network.
    graph.push(payload);
    return Response.json({messages:[{id:`wamid.fixture.reply.${graph.length}`} ]});
  }});
  try {
    const owner = randomUUID();
    await f.db.query('insert into auth.users(id) values($1)', [owner]);
    const workspaces = [];
    for (let i = 0; i < 3; i++) {
      const workspace = randomUUID(), customer = randomUUID();
      await f.db.query('insert into workspaces(id,owner_id,name,slug) values($1,$2,$3,$4)', [workspace,owner,`Fixture ${i}`,workspace]);
      await f.db.query('insert into workspace_settings(workspace_id,business_name) values($1,$2)', [workspace,`Fixture ${i}`]);
      await f.db.query("insert into customers(id,workspace_id,name,phone) values($1,$2,'Fixture customer',$3)", [customer,workspace,phone]);
      await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','fixture-v1',array['invoice_updates'])", [workspace,customer,phone]);
      workspaces.push(workspace);
    }
    // The third binding has since changed: START must not reconnect it.
    await f.db.query('update customers set phone=null where workspace_id=$1', [workspaces[2]]);
    const beforeCustomers = (await f.db.query('select * from customers order by id')).rows;
    const inbox = new SupabaseInboundInbox(f.supabase);
    const runtime = createInboundRuntime({supabase:f.supabase, inbox, fetchImpl:f.fetchImpl, logger,
      env:{WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,
        WHATSAPP_ACCESS_TOKEN:'offline-fixture',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_GRAPH_API_VERSION:'v24.0'},
      onBoundMessage:()=>{throw Error('Consent keywords must not reach the assistant');},
      onOwnerMessage:()=>{throw Error('Consent keywords must not reach owner actions');}});
    let sequence = 0;
    async function event(text, {type='text', processing=false}={}) {
      const [row] = await inbox.enqueue([{provider_message_id:`wamid.fixture.consent.${++sequence}`,
        phone_number_id:'1234567890',sender_phone:phone,message_type:type,message_text:text,
        provider_timestamp:new Date(Date.now()-1000).toISOString()}]);
      if (!processing) return row;
      return (await f.db.query("update whatsapp_inbound_events set status='processing',claim_token=gen_random_uuid() where id=$1 returning *", [row.id])).rows[0];
    }
    async function stop() {
      const row = await event('STOP');
      await runtime.revokeOptOut(row);
      const result = await runtime.processPending();
      assert.equal(result.completed, 1);
      return row;
    }
    const restore = row => f.db.query('select whatsapp_resubscribe_phone($1,$2,$3) as ok', [row.provider_message_id,phone,row.claim_token]);
    const claim = row => inbox.claimReply({workspaceId:null,phone,kind:'start_confirmation',messageId:row.provider_message_id});

    await t.test('STOP blocks sends; START clears both barriers, restores current consent and confirms once', async () => {
      await stop();
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[0],phone})).allowed, false);
      const start = await event(' \tStArT \n');
      const before = graph.length;
      assert.equal((await runtime.processPending()).completed, 1);
      assert.equal(graph.length, before+1);
      assert.match(graph.at(-1).text.body, /re-subscribe request.*receive WhatsApp updates again/s);
      assert.match(graph.at(-1).text.body, /Reply STOP/);
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[0],phone})).allowed, true);
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[1],phone})).allowed, true);
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[2],phone})).allowed, false);
      const consent = (await f.db.query('select * from whatsapp_consents where workspace_id=$1', [workspaces[0]])).rows[0];
      assert.equal(consent.revoked_via,null); assert.equal(consent.source,'inbound_message');
      assert.equal(consent.consented_by,null); // START cannot fabricate an owner binding.
      assert.deepEqual(consent.categories,['invoice_updates']);
      await inbox.enqueue([{provider_message_id:start.provider_message_id,phone_number_id:start.phone_number_id,
        sender_phone:phone,message_type:'text',message_text:start.message_text}]);
      assert.equal((await runtime.processPending()).claimed,0);
      assert.equal(graph.length,before+1);
    });

    await t.test('UNSTOP restores after another STOP, and STOP still works afterward', async () => {
      await stop();
      await event('unstop');
      assert.equal((await runtime.processPending()).completed,1);
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[0],phone})).allowed,true);
      await stop();
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[0],phone})).allowed,false);
      assert.match(graph.at(-1).text.body,/opted out/);
    });

    await t.test('wrong sender, lease, keyword or media cannot restore consent or claim confirmation', async () => {
      const row = await event('START', {processing:true});
      assert.equal((await f.db.query('select whatsapp_resubscribe_phone($1,$2,$3) as ok',[row.provider_message_id,'+919871367052',row.claim_token])).rows[0].ok,false);
      assert.equal((await f.db.query('select whatsapp_resubscribe_phone($1,$2,$3) as ok',[row.provider_message_id,phone,randomUUID()])).rows[0].ok,false);
      assert.equal((await claim(row)).allowed,false);
      for (const [text,type] of [['start invoice','text'],['START','image'],['UNSTOP','interactive']]) {
        const invalid = await event(text, {type,processing:true});
        assert.equal((await restore(invalid)).rows[0].ok,false);
      }
      await f.db.exec("update whatsapp_inbound_events set status='done' where start_processed_at is null and stop_processed_at is null");
    });

    await t.test('queued old START and a retried applied START cannot undo a later STOP', async () => {
      const old = await event('START', {processing:true});
      // It was queued before STOP, even though the worker will handle it later.
      await f.db.query("update whatsapp_inbound_events set received_at=now()-interval '1 minute',provider_timestamp=now()-interval '1 minute' where id=$1", [old.id]);
      await stop();
      assert.equal((await restore(old)).rows[0].ok,false);
      const fresh = await event('START', {processing:true});
      assert.equal((await restore(fresh)).rows[0].ok,true);
      await stop();
      assert.equal((await restore(fresh)).rows[0].ok,true); // Replay result, no mutation.
      assert.equal((await claim(fresh)).allowed,false);
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[0],phone})).allowed,false);
    });

    await t.test('confirmation is one-time, platform scoped, and fails closed for a later STOP', async () => {
      const fresh = await event('UNSTOP', {processing:true});
      assert.equal((await restore(fresh)).rows[0].ok,true);
      assert.equal((await inbox.claimReply({workspaceId:workspaces[0],phone,kind:'start_confirmation',messageId:fresh.provider_message_id})).allowed,false);
      assert.equal((await claim(fresh)).allowed,true);
      assert.equal((await claim(fresh)).allowed,false);
    });

    await t.test('manual revocation is preserved; unknown sender gets no fabricated consent', async () => {
      await f.db.query("select * from whatsapp_revoke_phone($1,$2,'manual',null)", [workspaces[0],phone]);
      const fresh = await event('START', {processing:true});
      assert.equal((await restore(fresh)).rows[0].ok,true);
      assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:workspaces[0],phone})).allowed,false);
      assert.equal((await claim(fresh)).allowed,false);
      const manual = (await f.db.query('select revoked_via from whatsapp_consents where workspace_id=$1',[workspaces[0]])).rows[0];
      assert.equal(manual.revoked_via,'manual');
      await f.db.exec('delete from whatsapp_consents; delete from whatsapp_suppressions');
      await f.db.query('select whatsapp_suppress_unknown_phone($1,$2)',[phone,'wamid.fixture.unknown']);
      const unknown = await event('UNSTOP', {processing:true});
      assert.equal((await restore(unknown)).rows[0].ok,true);
      assert.equal((await claim(unknown)).allowed,true);
      assert.equal((await f.db.query('select count(*)::int n from whatsapp_consents')).rows[0].n,0);
    });

    await t.test('unprivileged roles cannot re-subscribe or claim confirmations', async () => {
      for (const role of ['anon','authenticated']) {
        await f.db.exec(`set role ${role}`);
        await assert.rejects(f.db.query('select whatsapp_resubscribe_phone($1,$2,$3)',['wamid.fixture',phone,randomUUID()]),/permission denied/);
        await assert.rejects(f.db.query("select whatsapp_claim_resubscribe_reply($1,$2,'start_confirmation',null)",['wamid.fixture',phone]),/permission denied/);
        await f.db.exec('reset role');
      }
      assert.deepEqual((await f.db.query('select * from customers order by id')).rows,beforeCustomers);
      assert.equal(f.errors.length,0);
    });
  } finally { await f.close(); }
});
