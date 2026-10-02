import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';

const scope = {workspaceId: 'workspace-a', customerId: 'customer-a', phone: '+919871367051', message: 'What is my invoice status?'};

function fakeSupabase({customerId = 'customer-a', turns = [], memoryError = null} = {}) {
  return {rpc() {}, from(table) {
    if (table === 'whatsapp_conversation_turns') {
      if (memoryError) throw memoryError;
      const query = {select() { return query; }, eq() { return query; }, order() { return query; },
        limit() { return Promise.resolve({data: [...turns].reverse(), error: null}); },
        range() { return Promise.resolve({data: [], error: null}); },
        insert(row) { turns.push({...row, id: turns.length + 1, created_at: new Date().toISOString()}); return Promise.resolve({error: null}); },
        delete() { return query; }, in() { return Promise.resolve({error: null}); }};
      return query;
    }
    const query = {select() { return query; }, eq() { return query; },
      async maybeSingle() {
        if (table === 'workspace_ai_settings') return {data: {primary_model: 'gemini-3.5-flash', fallback_model: null}};
        if (table === 'whatsapp_global_suppressions') return {data: null};
        if (table === 'workspace_settings') return {data: {whatsapp_owner_attested_at: '2026-09-27T00:00:00.000Z'}};
        if (table === 'whatsapp_suppressions') return {data: null};
        if (table === 'whatsapp_consents') return {data: {source: 'verbal', revoked_at: null, categories: ['invoice_updates'], customer_id: customerId}};
        if (table === 'customers') return {data: {id: customerId}};
        throw new Error(`Unexpected table ${table}`);
      }};
    return query;
  }};
}

test('stored WhatsApp turns flow into ask and the inbound user turn is persisted', async () => {
  const turns = [
    {id: 1, role: 'user', content: 'Show invoice INV-1', created_at: '2026-09-30T10:00:00Z'},
    {id: 2, role: 'assistant', content: 'INV-1 is open.', created_at: '2026-09-30T10:00:01Z'},
  ];
  const handler = createWhatsAppBoundMessageHandler({supabase: fakeSupabase({turns}), logger: {error() {}},
    providerFactory: () => ({}), channelFactory: () => ({async ask(input) {
      assert.deepEqual(input.history, [{role: 'user', content: 'Show invoice INV-1'},
        {role: 'assistant', content: 'INV-1 is open.'}]);
      return {answer: 'It is still open.'};
    }})});
  assert.equal(await handler({...scope, message: 'Is it still open?'}), 'It is still open.');
  assert.equal(turns.at(-1).content, 'Is it still open?');
});

test('missing conversation table falls back to empty history and still answers', async () => {
  const logs = [];
  const handler = createWhatsAppBoundMessageHandler({
    supabase: fakeSupabase({memoryError: new Error('relation does not exist')}), logger: {error(...args) { logs.push(args); }},
    providerFactory: () => ({}), channelFactory: () => ({async ask(input) {
      assert.deepEqual(input.history, []);
      return {answer: 'Invoice INV-1 is sent.'};
    }})});
  assert.equal(await handler(scope), 'Invoice INV-1 is sent.');
  assert.equal(logs.length, 2);
});

test('WhatsApp functions have enough execution time for AI-backed replies', async () => {
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(vercel.functions['api/whatsapp.js'].maxDuration, 60);
  assert.equal(vercel.functions['api/whatsapp-process.js'].maxDuration, 60);
  assert.deepEqual(vercel.crons, [{path:'/api/whatsapp-process',schedule:'0 0 * * *'}]);
});

test('verified inbound binding is rechecked before the customer-scoped assistant runs', async () => {
  let asks = 0;
  const handler = createWhatsAppBoundMessageHandler({supabase: fakeSupabase(),
    providerFactory: () => ({}),
    channelFactory: ({authorizeChannel}) => ({async ask(input) {
      asks++;
      const result = await authorizeChannel(input);
      assert.equal(result.allowed, true);
      return {answer: 'Invoice INV-1 is sent.'};
    }}),
  });
  assert.equal(await handler(scope), 'Invoice INV-1 is sent.');
  assert.equal(asks, 1);
});

test('WhatsApp provider attempts are bounded to fit the function duration', async () => {
  let providerOptions;
  const fetchImpl = () => {};
  const handler = createWhatsAppBoundMessageHandler({
    supabase: fakeSupabase(),
    env: {GEMINI_API_KEY: 'gemini-key', OPENROUTER_API_KEY: 'openrouter-key'},
    fetchImpl,
    providerFactory(options) {
      providerOptions = options;
      return {};
    },
    channelFactory: () => ({async ask() { return {answer: 'Invoice INV-1 is sent.'}; }}),
  });

  await handler(scope);

  assert.equal(providerOptions.timeoutMs, 8000);
  assert.equal(providerOptions.maxAttempts, 1);
  assert.equal(providerOptions.geminiApiKey, 'gemini-key');
  assert.equal(providerOptions.openRouterApiKey, 'openrouter-key');
  assert.equal(providerOptions.fetchImpl, fetchImpl);
});

test('a customer mismatch fails channel authorization', async () => {
  const handler = createWhatsAppBoundMessageHandler({supabase: fakeSupabase({customerId: 'other-customer'}),
    providerFactory: () => ({}),
    channelFactory: ({authorizeChannel}) => ({async ask(input) {
      assert.equal((await authorizeChannel(input)).allowed, false);
      return {answer: 'Please verify your number.'};
    }}),
  });
  assert.equal(await handler(scope), 'Please verify your number.');
});

test('planner failure is retried exactly once and its final diagnostic is returned', async () => {
  let asks = 0;
  const handler = createWhatsAppBoundMessageHandler({supabase: fakeSupabase(),
    providerFactory: () => ({}),
    channelFactory: () => ({async ask() {
      asks++;
      return {answer: "I couldn't safely check that just now. Please try again.", model: null,
        usedFallback: true, evidence: {plannerFailure: {provider: 'AIProvider', model: 'free-model',
          status: 429, reason: 'provider_error'}}};
    }}),
  });
  assert.deepEqual(await handler(scope), {
    answer: "I couldn't safely check that just now. Please try again.",
    plannerFailure: {provider: 'AIProvider', model: 'free-model', status: 429, reason: 'provider_error'},
  });
  assert.equal(asks, 2);
});

test('a successful planner retry returns the recovered answer without diagnostics', async () => {
  let asks = 0;
  const handler = createWhatsAppBoundMessageHandler({supabase: fakeSupabase(),
    providerFactory: () => ({}),
    channelFactory: () => ({async ask() {
      asks++;
      return asks === 1
        ? {answer: 'safe fallback', model: null, usedFallback: true}
        : {answer: 'Invoice INV-1 is paid.', model: 'free-model', usedFallback: false};
    }}),
  });
  assert.equal(await handler(scope), 'Invoice INV-1 is paid.');
  assert.equal(asks, 2);
});

function contactFlow({consentAnswer = 'yes'} = {}) {
  let row = {id: 12, action: {type: 'invoice_debtor_phone', stage: 'awaiting_phone', invoiceId: 'invoice-1',
    clientName: 'Acme', clientPhoneRaw: '(415) 555-0244'}};
  const rpcCalls = [];
  const db = fakeSupabase();
  db.rpc = async (name, args) => { rpcCalls.push({name, args}); return {data: {id: 'consent-1'}, error: null}; };
  const pending = {async loadPendingAction() { return row; }, async consumePendingAction() { row = null; return {}; },
    async loadPendingActionState() { return {generation: 1, id: null, version: null}; },
    async storePendingAction({action}) { row = {id: 13, action}; return row; }, async loadInvoiceReview() { return null; }};
  const writes = [];
  const handler = createWhatsAppBoundMessageHandler({supabase: db, providerFactory: () => ({}),
    pendingActionStoreFactory: () => pending, invoiceStoreFactory: () => ({async saveDebtorPhone(input) { writes.push(input); }}),
    channelFactory: () => ({async ask() { throw new Error('provider must not be called'); }})});
  return {handler, writes, rpcCalls, consentAnswer};
}

test('pending invoice phone answer requires E.164, saves it, then records only a clear yes', async () => {
  const flow = contactFlow();
  assert.match(await flow.handler({...scope, message: '415 bananas'}), /full WhatsApp number with country code/i);
  assert.equal(flow.writes.length, 0);
  assert.match(await flow.handler({...scope, message: '+1 (415) 555-0244'}), /Saved \+14155550244.*Reply yes or no/s);
  assert.deepEqual(flow.writes, [{invoiceId: 'invoice-1', phone: '+14155550244'}]);
  assert.equal(flow.rpcCalls.length, 0);
  assert.equal(await flow.handler({...scope, message: 'yes'}), 'Consent recorded for +14155550244.');
  assert.equal(flow.rpcCalls[0].name, 'whatsapp_record_verbal_consent_service');
  assert.equal(flow.rpcCalls[0].args.p_consent_text_version, 'invoice_updates_v1');
});

test('a country-code-only answer completes the printed local number without guessing', async () => {
  const flow = contactFlow();
  assert.match(await flow.handler({...scope, message: '+1'}), /Saved \+14155550244/);
  assert.deepEqual(flow.writes, [{invoiceId: 'invoice-1', phone: '+14155550244'}]);
});

test('no or silence never records invoice-update consent', async () => {
  const no = contactFlow();
  await no.handler({...scope, message: '+14155550244'});
  assert.match(await no.handler({...scope, message: 'no'}), /Reminders will not be sent/);
  assert.equal(no.rpcCalls.length, 0);
  const unclear = contactFlow();
  await unclear.handler({...scope, message: '+14155550244'});
  assert.match(await unclear.handler({...scope, message: 'maybe'}), /Reply yes or no/);
  assert.equal(unclear.rpcCalls.length, 0);
});
