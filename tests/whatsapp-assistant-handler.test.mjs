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
