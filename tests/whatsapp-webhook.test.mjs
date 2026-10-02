import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createWhatsAppWebhookHandler, readRawBody, verifyMetaSignature } from '../automation/whatsapp/webhook.mjs';
import { createInboundRuntime, SupabaseInboundInbox, isOptOut, parseMetaMessages } from '../automation/whatsapp/cloud-inbound.mjs';
import { neutralText } from '../automation/whatsapp/cloud-outbound.mjs';
import { answerWorkspaceQuestion } from '../ai/assistant.mjs';

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

test('POST rejects missing secret, missing signature, and malformed signature before enqueue', async () => {
  const body = JSON.stringify(meta([message('wamid.unsigned')]));
  let enqueues = 0;
  const runtime = { enqueue: async () => { enqueues++; return []; } };
  for (const [settings, signature] of [
    [{ ...env, WHATSAPP_APP_SECRET: '' }, null],
    [env, ''],
    [env, 'sha256=not-a-valid-digest'],
  ]) {
    const request = signedRequest(body, signature ?? undefined);
    if (signature === '') delete request.headers['x-hub-signature-256'];
    const res = response();
    await createWhatsAppWebhookHandler({ env: settings, runtime })(request, res);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(enqueues, 0);
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

test('status-only callbacks are acknowledged and logged without enqueuing an event', async () => {
  const payload = meta([]);
  payload.entry[0].changes[0].value.statuses = [{
    id: 'wamid.outbound', status: 'failed', recipient_id: '919871367051', timestamp: '1750000000',
    errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable',
      error_data: { details: 'Delivery failed' } }],
  }];
  const enqueued = [];
  const logs = [];
  const runtime = { async enqueue(events) { enqueued.push(...events); return []; } };
  const handler = createWhatsAppWebhookHandler({ env, runtime, logger: { log: line => logs.push(line) } });
  const res = response();

  await handler(signedRequest(JSON.stringify(payload)), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  assert.deepEqual(enqueued, []);
  assert.ok(logs.some(line => line.startsWith('whatsapp-status ') && line.includes('"code":131026')));
  assert.ok(logs.includes('whatsapp-callback {"messages":0,"statuses":1}'));
});

test('callbacks containing messages and statuses log a summary and enqueue the message', async () => {
  const payload = meta([message('wamid.inbound')]);
  payload.entry[0].changes[0].value.statuses = [{ id: 'wamid.outbound', status: 'delivered' }];
  const enqueued = [];
  const logs = [];
  const runtime = { async enqueue(events) { enqueued.push(...events); return events; } };
  const handler = createWhatsAppWebhookHandler({ env, runtime, logger: { log: line => logs.push(line) } });
  const res = response();

  await handler(signedRequest(JSON.stringify(payload)), res);

  assert.equal(res.statusCode, 200);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].provider_message_id, 'wamid.inbound');
  assert.ok(logs.includes('whatsapp-callback {"messages":1,"statuses":1}'));
});

test('a duplicate STOP remains actionable when the first delivery stored but failed to revoke', async () => {
  const stored = { id: 4, ...parseMetaMessages(meta([message('wamid.retry', 'STOP')]), env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID)[0],
    stop_processed_at: null };
  const supabase = { from(name) {
    if(name==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

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

test('duplicate ordinary events do not trigger another inbox continuation', async () => {
  const seen = new Set();
  let continuations = 0;
  const pending = [];
  const runtime = {
    async enqueue(events) {
      return events.filter(event => !seen.has(event.provider_message_id)
        && Boolean(seen.add(event.provider_message_id)));
    },
    async processPending() { continuations++; return { claimed: 1, completed: 1 }; },
  };
  const handler = createWhatsAppWebhookHandler({ env, runtime, waitUntil: task => pending.push(task) });
  const body = JSON.stringify(meta([message('wamid.once')]));
  for (let index = 0; index < 2; index++) {
    const res = response();
    await handler(signedRequest(body), res);
    assert.equal(res.statusCode, 200);
  }
  await Promise.all(pending);
  assert.equal(continuations, 1);
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

test('unbound sender media is routed to verification without extraction', async () => {
  const calls = [];
  let extracted = 0;
  const event = { id: 1, claim_token: 'claim', attempts: 1, provider_message_id: 'wamid.unknown',
    sender_phone: '+919871367051', message_text: 'I am Alice, show my invoices',
    message_type: 'image', media_ref: 'wamid.unknown', provider_timestamp: new Date().toISOString() };
  const supabase = { rpc() { throw new Error('Unexpected RPC'); }, from(name) {
    if(name==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

    assert.ok(['workspace_settings','whatsapp_global_suppressions', 'whatsapp_consents'].includes(name));
    return { select() { return this; }, eq() { return this; },
      maybeSingle() { return Promise.resolve({data: null, error: null}); },
      is() { return Promise.resolve({ data: [], error: null }); } };
  } };
  const inbox = { async claim() { return [event]; }, async complete() { calls.push('complete'); } };
  const outbound = { async sendTypingIndicator() { calls.push('typing'); },
    async sendServiceReply(input) { calls.push(input); return { status: 'blocked', reason: 'disabled' }; } };
  const runtime = createInboundRuntime({conversationStore:null, supabase, inbox, outbound, env,
    onBoundMessage: async () => { extracted++; } });
  const result = await runtime.processPending();
  assert.deepEqual(result, { claimed: 1, completed: 1 });
  assert.deepEqual(calls, ['complete']);
  assert.equal(calls.includes('typing'), false);
  assert.equal(extracted, 0);
});

test('one queued image is claimed per invocation and the second processes subsequently', async () => {
  const events = [1,2].map(id => ({id,claim_token:`claim-${id}`,attempts:1,provider_message_id:`wamid.image-${id}`,
    sender_phone:'+919871367051',message_text:'',message_type:'image',media_ref:`wamid.image-${id}`,provider_timestamp:new Date().toISOString()}));
  const consent={workspace_id:'workspace-a',customer_id:'customer-a',source:'inbound_message',categories:['invoice_updates'],revoked_at:null};
  const rows={whatsapp_global_suppressions:null,whatsapp_consents:[consent],whatsapp_suppressions:[],
    workspace_settings:{whatsapp_owner_attested_at:new Date().toISOString()},
    customers:{id:'customer-a',workspace_id:'workspace-a',phone:'+919871367051'}};
  const supabase={rpc(){},from(table){
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};
const query={select(){return query;},eq(){return query;},is(){return Promise.resolve({data:rows[table],error:null});},
    maybeSingle(){return Promise.resolve({data:rows[table],error:null});},then(resolve){return Promise.resolve({data:rows[table],error:null}).then(resolve);}};return query;}};
  const completed=[],extracted=[];
  const inbox={async claim(){return events.length?[events.shift()]:[];},async getMedia(event){return {bytes:Buffer.from([event.id]),mimeType:'image/png'};},
    async complete(event){completed.push(event.id);}};
  const runtime=createInboundRuntime({conversationStore:null,supabase,inbox,env,outbound:{async sendTypingIndicator(){}},
    onBoundMessage:async input=>{extracted.push(input.messageId);return ''}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.deepEqual(events.map(event=>event.id),[2]);
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.deepEqual(extracted,['wamid.image-1','wamid.image-2']);
  assert.deepEqual(completed,[1,2]);
});

test('bound customer hi webhook completes and attempts a guarded greeting service reply', async () => {
  const pending = [];
  const queued = [];
  const completed = [];
  const sends = [];
  const event = { id: 21, claim_token: 'claim', attempts: 1, provider_message_id: 'wamid.bound-hi',
    sender_phone: '+919871367051', message_text: 'hi', provider_timestamp: new Date().toISOString() };
  const consent = {workspace_id: 'workspace-a', customer_id: 'customer-a', source: 'inbound_message',
    categories: ['invoice_updates'], revoked_at: null};
  const rows = {
    whatsapp_global_suppressions: null,
    whatsapp_consents: [consent],
    whatsapp_suppressions: [],
    workspace_settings: {whatsapp_owner_attested_at: new Date().toISOString(), business_name: 'Acme Studio'},
    customers: {id: 'customer-a', workspace_id: 'workspace-a', phone: '+919871367051'},
  };
  const supabase = {rpc() {}, from(table) {
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

    const query = {
      select() { return query; }, eq() { return query; }, is() { return Promise.resolve({data: rows[table], error: null}); },
      maybeSingle() { return Promise.resolve({data: rows[table], error: null}); },
      then(resolve) { return Promise.resolve({data: rows[table], error: null}).then(resolve); },
    };
    return query;
  }};
  const inbox = {
    async enqueue(events) { queued.push(...events); return events; },
    async claim() { return queued.length ? [event] : []; },
    async complete(item, errorCode) { completed.push({item, errorCode}); },
  };
  const outbound = {async sendTypingIndicator(input) { sends.push({kind: 'typing', ...input}); }, async sendServiceReply(input) {
    neutralText(input.body);
    sends.push(input);
    return {status: 'accepted'};
  }};
  const runtime = createInboundRuntime({conversationStore:null,supabase, inbox, outbound, env,
    onBoundMessage: async ({message: text}) => (await answerWorkspaceQuestion({
      message: text, store: {query() { return []; }}, provider: null,
    })).answer});
  const handler = createWhatsAppWebhookHandler({env, runtime, waitUntil: task => pending.push(task)});
  const res = response();

  await handler(signedRequest(JSON.stringify(meta([message('wamid.bound-hi', 'hi')]))), res);
  await Promise.all(pending);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {received: true});
  assert.equal(completed.length, 1);
  assert.equal(completed[0].errorCode, undefined);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], {kind: 'typing', messageId: 'wamid.bound-hi'});
  assert.equal(sends[1].kind, 'normal');
  assert.match(sends[1].body, /^Hi! I'm here for your Cetld workspace/);
});

test('typing indicator is skipped for STOP and a thrown indicator cannot fail a bound event', async () => {
  const stop = {id: 30, claim_token: 'stop-claim', attempts: 1, provider_message_id: 'wamid.stop-skip',
    sender_phone: '+919871367051', message_text: 'STOP', stop_processed_at: new Date().toISOString(),
    stop_confirmation_due: false};
  let typing = 0;
  const stopInbox = {async claim() { return [stop]; }, async complete() {}};
  const stopRuntime = createInboundRuntime({conversationStore:null,supabase: {}, inbox: stopInbox, outbound: {
    async sendTypingIndicator() { typing++; }, async sendServiceReply() {}}, env});
  assert.deepEqual(await stopRuntime.processPending(), {claimed: 1, completed: 1});
  assert.equal(typing, 0);

  // Reuse the bound-path test's binding shape while making the UX-only call fail.
  const event = {...stop, id: 31, provider_message_id: 'wamid.typing-fails', message_text: 'hello', stop_processed_at: null};
  const consent = {workspace_id: 'workspace-a', customer_id: 'customer-a', source: 'inbound_message',
    categories: ['invoice_updates'], revoked_at: null};
  const rows = {whatsapp_global_suppressions: null, whatsapp_consents: [consent], whatsapp_suppressions: [],
    workspace_settings: {whatsapp_owner_attested_at: new Date().toISOString(), business_name: 'Acme Studio'},
    customers: {id: 'customer-a', workspace_id: 'workspace-a', phone: '+919871367051'}};
  const supabase = {rpc() {}, from(table) {
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};
 const query = {select() { return query; }, eq() { return query; },
    is: async () => ({data: rows[table], error: null}), maybeSingle: async () => ({data: rows[table], error: null}),
    then(resolve) { return Promise.resolve({data: rows[table], error: null}).then(resolve); }}; return query; }};
  let completed = false;
  const runtime = createInboundRuntime({conversationStore:null,supabase, inbox: {async claim() { return [event]; }, async complete() { completed = true; }},
    outbound: {async sendTypingIndicator() { typing++; throw new Error('Graph down'); }, async sendServiceReply() {}},
    logger: {error() {}}, onBoundMessage: async () => null, env});
  assert.deepEqual(await runtime.processPending(), {claimed: 1, completed: 1});
  assert.equal(typing, 1);
  assert.equal(completed, true);
});

test('planner fallback is sent and completed as done with bounded diagnostics and no queue retry', async () => {
  const event = {id: 23, claim_token: 'claim', attempts: 1, provider_message_id: 'wamid.planner-failure',
    sender_phone: '+919871367051', message_text: 'What do I owe?', provider_timestamp: new Date().toISOString()};
  const consent = {workspace_id: 'workspace-a', customer_id: 'customer-a', source: 'inbound_message',
    categories: ['invoice_updates'], revoked_at: null};
  const rows = {
    whatsapp_global_suppressions: null, whatsapp_consents: [consent], whatsapp_suppressions: [],
    workspace_settings: {whatsapp_owner_attested_at: new Date().toISOString(), business_name: 'Acme Studio'},
    customers: {id: 'customer-a', workspace_id: 'workspace-a', phone: '+919871367051'},
  };
  const supabase = {rpc() {}, from(table) {
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

    const query = {select() { return query; }, eq() { return query; },
      is() { return Promise.resolve({data: rows[table], error: null}); },
      maybeSingle() { return Promise.resolve({data: rows[table], error: null}); },
      then(resolve) { return Promise.resolve({data: rows[table], error: null}).then(resolve); }};
    return query;
  }};
  const completions = [];
  const sends = [];
  const inbox = {async claim() { return [event]; }, async complete(...args) { completions.push(args); }};
  const runtime = createInboundRuntime({conversationStore:null,supabase, inbox, env,
    outbound: {async sendServiceReply(input) { sends.push(input); return {status: 'accepted'}; }},
    onBoundMessage: async () => ({
      answer: "I couldn't safely check that just now. Please try again.",
      plannerFailure: {provider: 'AIProvider', model: 'free-model', status: 429, reason: 'provider_error'},
    })});

  assert.deepEqual(await runtime.processPending(), {claimed: 1, completed: 1});
  assert.equal(sends[0].body, "I couldn't safely check that just now. Please try again.");
  assert.equal(completions[0][1], 'ASSISTANT_PLANNER_FAILED');
  assert.deepEqual(JSON.parse(completions[0][2]),
    {provider: 'AIProvider', model: 'free-model', status: 429, reason: 'provider_error'});
  assert.equal(completions[0][3], false);
});

test('inbox stores terminal planner diagnostics while marking the event done', async () => {
  let update;
  const supabase = {from(table) {
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

    assert.equal(table, 'whatsapp_inbound_events');
    return {update(value) { update = value; return this; }, eq() { return this; },
      then(resolve) { return Promise.resolve({data: null, error: null}).then(resolve); }};
  }};
  const inbox = new SupabaseInboundInbox(supabase);
  await inbox.complete({id: 23, claim_token: 'claim', attempts: 1, next_attempt_at: 'unchanged'},
    'ASSISTANT_PLANNER_FAILED', '{"reason":"provider_error"}', false);
  assert.equal(update.status, 'done');
  assert.ok(update.processed_at);
  assert.equal(update.next_attempt_at, 'unchanged');
  assert.equal(update.error_code, 'ASSISTANT_PLANNER_FAILED');
  assert.equal(update.error_detail, '{"reason":"provider_error"}');
});

test('inbound processing failure log and durable event include the truncated error message', async () => {
  const logs = [];
  const event = {id: 22, claim_token: 'claim', attempts: 1, provider_message_id: 'wamid.failure',
    sender_phone: '+919871367051', message_text: 'hello'};
  let completion;
  const inbox = {async claim() { return [event]; }, async complete(...args) { completion = args; }};
  const supabase = {rpc() {}, from() { throw new Error('database lookup failed: ' + 'x'.repeat(250)); }};
  const runtime = createInboundRuntime({conversationStore:null,supabase, inbox, env,
    logger: {error(label, fields) { logs.push({label, fields}); }}});

  assert.deepEqual(await runtime.processPending(), {claimed: 1, completed: 0});
  assert.equal(logs[0].label, 'WhatsApp inbound event failed');
  assert.equal(logs[0].fields.name, 'Error');
  assert.equal(logs[0].fields.message, ('database lookup failed: ' + 'x'.repeat(250)).slice(0, 200));
  assert.equal(completion[1], 'PROCESSING_FAILED');
  assert.equal(completion[2], 'database lookup failed: ' + 'x'.repeat(250));
});

test('processing stops before the deadline and leaves the next event pending', async () => {
  const pending = [
    {id: 2, attempts: 1, provider_message_id: 'wamid.new', sender_phone: '+919871367051',
      message_text: 'STOP', stop_processed_at: new Date().toISOString(), stop_confirmation_due: false},
    {id: 1, attempts: 1, provider_message_id: 'wamid.old', sender_phone: '+919871367051',
      message_text: 'STOP', stop_processed_at: new Date().toISOString(), stop_confirmation_due: false},
  ];
  const completed = [], deferred = [];
  const times = [0, 0, 36_000];
  const inbox = {async claim(limit) { assert.equal(limit, 1); return pending.splice(0, 1); },
    async complete(event) { completed.push(event.id); },
    async defer(event) { deferred.push(event.id); pending.unshift(event); }};
  const runtime = createInboundRuntime({conversationStore:null,supabase: {}, inbox, env: {...env, WHATSAPP_PROCESS_BUDGET_MS: '40000'},
    clock: () => times.shift() ?? 36_000});

  assert.deepEqual(await runtime.processPending(), {claimed: 1, completed: 0});
  assert.deepEqual(completed, []);
  assert.deepEqual(deferred, [2]);
  assert.deepEqual(pending.map(event => event.id), [2, 1]);
});

test('a final-attempt event receives exactly one fallback and is never retried', async () => {
  const event = {id: 5, attempts: 5, provider_message_id: 'wamid.final', sender_phone: '+919871367051',
    message_text: 'slow question', received_at: new Date().toISOString()};
  const sends = [];
  const completions = [];
  let claims = 0;
  const inbox = {async claim() { claims++; return claims === 1 ? [event] : []; },
    async complete(...args) { completions.push(args); }};
  const runtime = createInboundRuntime({conversationStore:null,supabase: {}, inbox, env, logger: {error() {}},
    outbound: {async sendServiceReply(input) { sends.push(input); }}});

  assert.deepEqual(await runtime.processPending(), {claimed: 1, completed: 1});
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body, "I couldn't safely check that just now. Please try again.");
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0].slice(1), ['PROCESSING_FAILED', null, false]);
});

test('a transient failure before the final attempt remains retryable', async () => {
  const event = {id: 4, attempts: 4, provider_message_id: 'wamid.transient', sender_phone: '+919871367051',
    message_text: 'question'};
  const completions = [];
  let claimed = false;
  const inbox = {async claim() { if (claimed) return []; claimed = true; return [event]; },
    async complete(...args) { completions.push(args); }};
  const runtime = createInboundRuntime({conversationStore:null,supabase: {from() { throw new Error('temporary database failure'); }},
    inbox, env, logger: {error() {}}});

  assert.deepEqual(await runtime.processPending(), {claimed: 1, completed: 0});
  assert.deepEqual(completions[0].slice(1), ['PROCESSING_FAILED', 'temporary database failure']);
});

test('unknown STOP gets a global suppression claim before acknowledgement', async () => {
  const event = {id: 12, sender_phone: '+919871367051', message_text: 'STOP',
    provider_message_id: 'wamid.unknown-stop'};
  let marked;
  const supabase = {
    from(table) {
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

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
  const runtime = createInboundRuntime({conversationStore:null,supabase, inbox: {async markStop(_event, value) { marked = value; }}, env});
  await runtime.revokeOptOut(event);
  assert.deepEqual(marked, {confirmationDue: true, workspaceId: null});
});

test('a retried STOP recovers its workspace confirmation after revocation committed', async () => {
  const event = { id: 13, sender_phone: '+919871367051', message_text: 'STOP',
    provider_message_id: 'wamid.retry-after-revoke' };
  const calls = [];
  const supabase = {
    from(table) {
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

      assert.equal(table, 'whatsapp_consents');
      return {
        select() { return this; },
        eq() { return this; },
        is() { throw new Error('Revoked consent must remain visible to STOP recovery'); },
        then(resolve) { return Promise.resolve({ data: [{ workspace_id: 'workspace-a' }], error: null }).then(resolve); },
      };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'whatsapp_suppress_unknown_phone') return { data: false, error: null };
      assert.equal(name, 'whatsapp_revoke_phone');
      return { data: [{ revoked: false, confirmation_due: true }], error: null };
    },
  };
  const runtime = createInboundRuntime({conversationStore:null, supabase, inbox: {
    async markStop(_event, value) { calls.push({ markStop: value }); },
  }, env });
  await runtime.revokeOptOut(event);
  assert.deepEqual(calls.at(-1), { markStop: { confirmationDue: true, workspaceId: 'workspace-a' } });
});

test('STOP installs phone-wide suppression before discovering workspace consents', async () => {
  const calls = [];
  const event = { id: 14, sender_phone: '+919871367051', message_text: 'STOP', provider_message_id: 'wamid.race' };
  const supabase = {
    from(table) {
    if(table==='whatsapp_owner_verifications')return {select(){return this},eq(){return this},not(){return this},order(){return this},limit(){return Promise.resolve({data:[]})}};

      assert.equal(table, 'whatsapp_consents');
      return { select() { return this; }, eq() { return this; },
        then(resolve) { calls.push('read-consents'); return Promise.resolve({
          data: [{ workspace_id: 'workspace-a' }], error: null,
        }).then(resolve); } };
    },
    async rpc(name) {
      calls.push(name);
      if (name === 'whatsapp_suppress_unknown_phone') return { data: false, error: null };
      if (name === 'whatsapp_revoke_phone') return { data: [{ revoked: true, confirmation_due: true }], error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const runtime = createInboundRuntime({conversationStore:null, supabase, inbox: {
    async markStop() { calls.push('mark-stop'); },
  }, env });
  await runtime.revokeOptOut(event);
  assert.deepEqual(calls, ['whatsapp_suppress_unknown_phone', 'read-consents', 'whatsapp_revoke_phone', 'mark-stop']);
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

test('Postgres inbox claims newest events first', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.workspaces(id uuid primary key);
      create table public.whatsapp_suppressions(workspace_id uuid, phone text, primary key(workspace_id,phone));
      create table public.whatsapp_global_suppressions(phone text primary key, source_message_id text);`);
    for (const migration of ['20260927110000_whatsapp_inbound_events.sql', '20260930110000_whatsapp_inbound_newest_first.sql']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
    }
    await db.query(`insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text)
      values ('wamid.old','123456789','+919871367051','text','Old'),
             ('wamid.new','123456789','+919871367051','text','New')`);
    await db.exec('set role service_role');
    const claimed = (await db.query('select * from public.whatsapp_claim_inbound_events(1)')).rows;
    assert.equal(claimed[0].provider_message_id, 'wamid.new');
  } finally { await db.close(); }
});
