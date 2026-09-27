import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppInvoiceTestHandler} from '../automation/whatsapp/test-send.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const customerId = '44444444-4444-4444-8444-444444444444';

function response() {
  return {code: null, body: null, setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }};
}

test('a non-owner cannot initiate a WhatsApp invoice test', async () => {
  const res = response();
  let loaded = false;
  const handler = createWhatsAppInvoiceTestHandler({
    env: {WHATSAPP_TEST_OPERATOR_USER_ID: userId, WHATSAPP_OUTBOUND_ENABLED: 'true'},
    authorize: async () => ({workspaceId, userId, role: 'member'}),
    loadSupabase: () => { loaded = true; throw Error('should not load'); },
  });
  await handler({method: 'POST', body: {workspaceId, invoiceId}}, res);
  assert.equal(res.code, 403);
  assert.equal(loaded, false);
});

test('test send derives the only recipient and template values from current rows', async () => {
  const rows = {
    invoices: {id: invoiceId, workspace_id: workspaceId, customer_id: customerId,
      invoice_number: 'INV-1048', status: 'sent', updated_at: '2026-09-27T10:00:00Z'},
    customers: {id: customerId, workspace_id: workspaceId, phone: '+919871367051'},
    workspace_settings: {workspace_id: workspaceId, business_name: 'Morrow Studio'},
  };
  const supabase = {rpc() {throw Error('transport mock must not claim');}, from(table) { return {select() {return this;}, eq() {return this;},
    async maybeSingle() {return {data: rows[table] || null, error: null};}}; }};
  const sent = [];
  const handler = createWhatsAppInvoiceTestHandler({
    env: {WHATSAPP_TEST_OPERATOR_USER_ID: userId, WHATSAPP_OUTBOUND_ENABLED: 'true'},
    authorize: async () => ({workspaceId, userId, role: 'owner'}),
    loadSupabase: () => supabase,
    outboundFactory: () => ({async sendInvoiceUpdateTemplate(input) {
      sent.push(input); return {status: 'accepted', providerMessageId: 'wamid.test'};
    }}),
  });
  const res = response();
  await handler({method: 'POST', body: {workspaceId, invoiceId}}, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, {status: 'accepted', providerMessageId: 'wamid.test'});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+919871367051');
  assert.equal(sent[0].customerId, customerId);
  assert.equal(sent[0].businessName, 'Morrow Studio');
  assert.equal(sent[0].expectedUpdatedAt, '2026-09-27T10:00:00Z');
  assert.match(sent[0].idempotencyKey, /^[a-f0-9]{64}$/);
});

test('same invoice revision crosses the real outbound path at most once', async () => {
  const rows = {
    invoices: {id: invoiceId, workspace_id: workspaceId, customer_id: customerId,
      invoice_number: 'INV-1048', status: 'sent', updated_at: '2026-09-27T10:00:00Z'},
    customers: {id: customerId, workspace_id: workspaceId, phone: '+919871367051'},
    workspace_settings: {workspace_id: workspaceId, business_name: 'Morrow Studio', whatsapp_owner_attested_at: '2026-09-26T10:00:00Z'},
    whatsapp_consents: {workspace_id: workspaceId, customer_id: customerId, phone: '+919871367051',
      categories: ['invoice_updates'], source: 'verbal', revoked_at: null},
  };
  let claimed = false;
  const logs = [];
  const supabase = {
    from(table) {const filters = {}; return {select() {return this;}, eq(field, value) {filters[field] = value; return this;},
      async maybeSingle() {
        const row = rows[table] || null;
        if (row && Object.entries(filters).some(([field, value]) => row[field] !== value)) return {data: null, error: null};
        return {data: row, error: null};
      }};},
    async rpc(name) {
      assert.equal(name, 'whatsapp_claim_invoice_update');
      if (claimed) return {data: false, error: null};
      claimed = true; return {data: true, error: null};
    },
  };
  const graph = [];
  const handler = createWhatsAppInvoiceTestHandler({
    env: {WHATSAPP_TEST_OPERATOR_USER_ID: userId, WHATSAPP_OUTBOUND_ENABLED: 'true', WHATSAPP_TEST_ALLOWLIST: '+919871367051',
      WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_GRAPH_API_VERSION: 'v24.0'},
    authorize: async () => ({workspaceId, userId, role: 'owner'}),
    loadSupabase: () => supabase,
    logger: {warn(entry) {logs.push(entry);}},
    fetchImpl: async (url, options) => {
      graph.push({url, body: JSON.parse(options.body)});
      return {ok: true, async json() {return {messages: [{id: 'wamid.test'}]};}};
    },
  });
  const first = response(), second = response();
  await handler({method: 'POST', body: {workspaceId, invoiceId}}, first);
  await handler({method: 'POST', body: {workspaceId, invoiceId}}, second);
  assert.equal(first.code, 200);
  assert.equal(second.code, 409);
  assert.equal(graph.length, 1);
  assert.equal(logs[0].reason, 'duplicate_invoice_update');
  assert.equal(graph[0].body.to, '919871367051');
  assert.equal(graph[0].body.template.name, 'cetld_invoice_update_test');
  assert.deepEqual(graph[0].body.template.components[0].parameters.map(item => item.text), ['Morrow Studio', 'INV-1048']);
});
