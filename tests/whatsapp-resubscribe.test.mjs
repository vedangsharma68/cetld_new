import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createInboundRuntime, SupabaseInboundInbox, isResubscribe, isOptOut} from '../automation/whatsapp/cloud-inbound.mjs';
import {getSendEligibility} from '../automation/whatsapp/consent.mjs';

const phone = '+919871367051';
const logger = {log(){}, warn(){}, error(){}};

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
