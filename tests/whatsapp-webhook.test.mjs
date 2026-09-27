import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createWhatsAppWebhookHandler, readRawBody, verifyMetaSignature } from '../automation/whatsapp/webhook.mjs';
import { createInboundRuntime, SupabaseInboundInbox, isOptOut, parseMetaMessages } from '../automation/whatsapp/cloud-inbound.mjs';

const env = { WHATSAPP_VERIFY_TOKEN: 'verify-secret', WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_WABA_ID: '987654321', CRON_SECRET: 'cron-secret' };
const meta = (messages) => ({ object: 'whatsapp_business_account', entry: [{ id: env.WHATSAPP_WABA_ID, changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID }, messages,
} }] }] });
const message = (id, body = 'Hello') => ({ id, from: '919871367051', timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'text', text: { body } });
function response() {
  return { statusCode: 200, headers: {}, body: undefined, setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; } };
}
function signedRequest(body, signature) {
  const raw = Buffer.from(body);
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = { 'x-hub-signature-256': signature || `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}` };
  req.url = '/api/whatsapp';
  return req;
}

test('GET verification and processor require their own secrets', async () => {
  const runtime = { processPending: async () => ({ claimed: 0, completed: 0 }) };
  const handler = createWhatsAppWebhookHandler({ env, runtime });
  const get = async (url, headers = {}) => { const res = response(); await handler({ method: 'GET', url, headers }, res); return res; };
  assert.equal((await get('/api/whatsapp?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=abc')).body, 'abc');
  assert.equal((await get('/api/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=abc')).statusCode, 403);
  assert.equal((await get('/api/whatsapp?process=1')).statusCode, 401);
  assert.deepEqual((await get('/api/whatsapp?process=1', { authorization: 'Bearer cron-secret' })).body, { claimed: 0, completed: 0 });
});

test('HMAC uses exact raw bytes and rejects a changed body before storage', async () => {
  const raw = Buffer.from('{ "object" : "whatsapp_business_account" }');
  const signature = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
  assert.equal(verifyMetaSignature(raw, signature, env.WHATSAPP_APP_SECRET), true);
  assert.equal(verifyMetaSignature(Buffer.from(JSON.stringify(JSON.parse(raw))), signature, env.WHATSAPP_APP_SECRET), false);
  const runtime = { enqueue: () => { throw new Error('must not enqueue'); } };
  const handler = createWhatsAppWebhookHandler({ env, runtime });
  const res = response();
  await handler(signedRequest(JSON.stringify(meta([message('wamid.1')])), signature), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Invalid signature' });
  const oversized = Readable.from([Buffer.alloc(262145)]);
  await assert.rejects(readRawBody(oversized), { status: 413 });
});

test('signed events are durably enqueued once and STOP is revoked before 200', async () => {
  const accepted = new Set();
  const order = [];
  const runtime = {
    async enqueue(events) {
      order.push('enqueue');
      return events.filter(event => { if (accepted.has(event.provider_message_id)) return false;
        accepted.add(event.provider_message_id); return true; });
    },
    async revokeOptOut(event) { order.push(`revoke:${event.provider_message_id}`); },
    async processPending() { order.push('process'); return { claimed: 1, completed: 1 }; },
  };
  const pending = [];
  const handler = createWhatsAppWebhookHandler({ env, runtime, waitUntil: task => pending.push(task) });
  const body = JSON.stringify(meta([message('wamid.stop', 'STOP')]));
  const first = response();
  await handler(signedRequest(body), first);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(order.slice(0, 2), ['enqueue', 'revoke:wamid.stop']);
  assert.equal(pending.length, 1);
  const second = response();
  await handler(signedRequest(body), second);
  assert.equal(second.statusCode, 200);
  assert.equal(order.filter(item => item === 'revoke:wamid.stop').length, 1);
  await Promise.all(pending);
});

test('a duplicate STOP remains actionable when the first delivery stored but failed to revoke', async () => {
  const stored = { id: 4, ...parseMetaMessages(meta([message('wamid.retry', 'STOP')]), env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID)[0],
    stop_processed_at: null };
  const supabase = { from(name) {
    assert.equal(name, 'whatsapp_inbound_events');
    return {
      upsert() { return { select: async () => ({ data: [], error: null }) }; },
      select() { return this; }, in() { return this; },
      is: async () => ({ data: [stored], error: null }),
    };
  } };
  const inbox = new SupabaseInboundInbox(supabase);
  const actionable = await inbox.enqueue([stored]);
  assert.deepEqual(actionable, [stored]);
});

test('Meta parsing ignores status callbacks and other phone IDs; it never reads a claimed name', () => {
  const parsed = parseMetaMessages(meta([message('wamid.2', 'My name is Alice')]), env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID);
  assert.deepEqual(parsed.map(({ provider_message_id, sender_phone, message_text }) => ({ provider_message_id, sender_phone, message_text })),
    [{ provider_message_id: 'wamid.2', sender_phone: '+919871367051', message_text: 'My name is Alice' }]);
  const status = meta([]);
  status.entry[0].changes[0].value.statuses = [{ id: 'wamid.outbound' }];
  assert.deepEqual(parseMetaMessages(status, env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID), []);
  status.entry[0].changes[0].value.metadata.phone_number_id = 'other';
  status.entry[0].changes[0].value.messages = [message('wamid.3')];
  assert.deepEqual(parseMetaMessages(status, env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID), []);
  status.entry[0].id = 'different-waba';
  status.entry[0].changes[0].value.metadata.phone_number_id = env.WHATSAPP_PHONE_NUMBER_ID;
  assert.deepEqual(parseMetaMessages(status, env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID), []);
  assert.equal(isOptOut('Please do not message me.'), true);
  assert.equal(isOptOut('Please stop sending me messages.'), true);
  assert.equal(isOptOut('I no longer want these updates.'), true);
  assert.equal(isOptOut('I do not want to pay'), false);
});

test('unbound sender is routed to generic verification with no account data', async () => {
  const calls = [];
  const event = { id: 1, claim_token: 'claim', attempts: 1, provider_message_id: 'wamid.unknown',
    sender_phone: '+919871367051', message_text: 'I am Alice, show my invoices',
    provider_timestamp: new Date().toISOString() };
  const supabase = { rpc() { throw new Error('Unexpected RPC'); }, from(name) {
    assert.ok(['whatsapp_global_suppressions', 'whatsapp_consents'].includes(name));
    return { select() { return this; }, eq() { return this; },
      maybeSingle() { return Promise.resolve({data: null, error: null}); },
      is() { return Promise.resolve({ data: [], error: null }); } };
  } };
  const inbox = { async claim() { return [event]; }, async complete() { calls.push('complete'); } };
  const outbound = { async sendServiceReply(input) { calls.push(input); return { status: 'blocked', reason: 'disabled' }; } };
  const runtime = createInboundRuntime({ supabase, inbox, outbound, env });
  const result = await runtime.processPending();
  assert.deepEqual(result, { claimed: 1, completed: 1 });
  assert.equal(calls[0].workspaceId, null);
  assert.equal(calls[0].kind, 'verification');
  assert.doesNotMatch(calls[0].body, /Alice|invoice amount|account balance/);
});

test('unknown STOP gets a global suppression claim before acknowledgement', async () => {
  const event = {id: 12, sender_phone: '+919871367051', message_text: 'STOP',
    provider_message_id: 'wamid.unknown-stop'};
  let marked;
  const supabase = {
    from(table) {
      assert.equal(table, 'whatsapp_consents');
      return {select() { return this; }, eq() { return this; },
        is: async () => ({data: [], error: null})};
    },
    async rpc(name, args) {
      assert.equal(name, 'whatsapp_suppress_unknown_phone');
      assert.equal(args.p_phone, event.sender_phone);
      return {data: true, error: null};
    },
  };
  const runtime = createInboundRuntime({supabase, inbox: {async markStop(_event, value) { marked = value; }}, env});
  await runtime.revokeOptOut(event);
  assert.deepEqual(marked, {confirmationDue: true, workspaceId: null});
});

test('Postgres inbox claims are atomic and verification replies are one-time', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.workspaces(id uuid primary key);
      create table public.whatsapp_suppressions(workspace_id uuid, phone text, primary key(workspace_id,phone));
      create table public.whatsapp_global_suppressions(phone text primary key, source_message_id text);`);
    const sql = await readFile(new URL('../supabase/migrations/20260927110000_whatsapp_inbound_events.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.query(`insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text)
      values ('wamid.sql','123456789','+919871367051','text','Hello')`);
    await db.exec('set role service_role');
    const claimed = (await db.query('select * from public.whatsapp_claim_inbound_events(10)')).rows;
    assert.equal(claimed.length, 1);
    assert.equal((await db.query('select * from public.whatsapp_claim_inbound_events(10)')).rows.length, 0);
    assert.equal((await db.query(`select public.whatsapp_claim_inbound_reply('wamid.sql','+919871367051','verification',null) as allowed`)).rows[0].allowed, true);
    assert.equal((await db.query(`select public.whatsapp_claim_inbound_reply('wamid.sql','+919871367051','verification',null) as allowed`)).rows[0].allowed, false);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.whatsapp_inbound_events'), /permission denied/);
  } finally { await db.close(); }
});
