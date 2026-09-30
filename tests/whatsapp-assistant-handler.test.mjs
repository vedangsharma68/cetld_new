import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';

const scope = {workspaceId: 'workspace-a', customerId: 'customer-a', phone: '+919871367051', message: 'What is my invoice status?'};

function fakeSupabase({customerId = 'customer-a'} = {}) {
  return {rpc() {}, from(table) {
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
