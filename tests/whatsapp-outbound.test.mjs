import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppOutbound, neutralText} from '../automation/whatsapp/cloud-outbound.mjs';
import {createWhatsAppAssistantChannel, createCustomerScopedStore} from '../ai/whatsapp-channel.mjs';
import {IDENTITY_ANSWER, SCOPE_ANSWER} from '../ai/assistant.mjs';

const PHONE = '+919871367051';
const OTHER = '+15551234567';
const NOW = '2026-09-27T12:00:00.000Z';
const baseEnv = {WHATSAPP_OUTBOUND_ENABLED: 'true', WHATSAPP_TEST_ALLOWLIST: PHONE, WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_GRAPH_API_VERSION: 'v24.0'};
const invoice = {workspaceId: 'workspace-a', customerId: 'customer-a', invoiceNumber: 'INV-1', status: 'sent', updatedAt: NOW};

test('assistant canned scope and identity replies pass the collection-language guard', () => {
  assert.equal(neutralText(SCOPE_ANSWER), SCOPE_ANSWER);
  assert.equal(neutralText(IDENTITY_ANSWER), IDENTITY_ANSWER);
});

function fakeSupabase({suppressed = false, globallySuppressed = false, consented = true, customer = true, attested = true} = {}) {
  const reads = [];
  return {
    reads,
    rpc() {},
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        async limit() {
          reads.push({table, filters: {...filters}});
          if (table === 'whatsapp_suppressions') return {data: (typeof suppressed === 'function' ? suppressed() : suppressed) ? [{workspace_id: 'workspace-a'}] : []};
          throw new Error(`unexpected limited table: ${table}`);
        },
        async maybeSingle() {
          reads.push({table, filters: {...filters}});
          if (table === 'whatsapp_global_suppressions') return {data: (typeof globallySuppressed === 'function' ? globallySuppressed() : globallySuppressed) ? {suppressed_at: NOW} : null};
          if (table === 'whatsapp_suppressions') return {data: (typeof suppressed === 'function' ? suppressed() : suppressed) ? {suppressed_at: NOW} : null};
          if (table === 'workspace_settings') return {data: {business_name: 'Acme Studio', whatsapp_owner_attested_at: attested ? NOW : null}};
          if (table === 'whatsapp_consents') return {data: consented ? {source: 'inbound_message', categories: ['invoice_updates'], customer_id: 'customer-a', revoked_at: null} : null};
          if (table === 'customers') return {data: customer ? {id: 'customer-a', phone: PHONE} : null};
          throw new Error(`unexpected table: ${table}`);
        },
      };
      return query;
    },
  };
}

function harness({env = baseEnv, supabase = fakeSupabase(), currentInvoice = invoice, authorizeInboundReply = async () => ({allowed: true}), claimInvoiceUpdate = async () => ({claimed: true})} = {}) {
  const calls = [];
  const logs = [];
  const outbound = createWhatsAppOutbound({
    env, supabase,
    invoiceStore: {async getCurrentInvoice() { return currentInvoice; }},
    authorizeInboundReply,
    claimInvoiceUpdate,
    clock: () => new Date(NOW),
    logger: {warn(row) { logs.push(row); }, error(row) { logs.push(row); }},
    async fetchImpl(url, options) {
      calls.push({url, options});
      return {ok: true, async json() { return {messages: [{id: 'wamid-test'}]}; }};
    },
  });
  return {outbound, calls, logs, supabase};
}

const sendInvoice = (outbound, overrides = {}) => outbound.sendInvoiceUpdateTemplate({
  workspaceId: 'workspace-a', to: PHONE, invoiceId: 'invoice-a', customerId: 'customer-a',
  businessName: 'Acme Studio', expectedUpdatedAt: NOW, idempotencyKey: 'invoice-a:event-1', ...overrides,
});

test('outbound is disabled by default and makes no network call', async () => {
  const {outbound, calls} = harness({env: {...baseEnv, WHATSAPP_OUTBOUND_ENABLED: undefined}});
  assert.deepEqual(await sendInvoice(outbound), {status: 'blocked', reason: 'disabled'});
  assert.deepEqual(await outbound.sendServiceReply({workspaceId: null, to: PHONE, kind: 'verification',
    businessName: 'CETLD', messageId: 'inbound-disabled', lastInboundAt: NOW}), {status: 'blocked', reason: 'disabled'});
  assert.equal(calls.length, 0);
});

test('default test allowlist blocks other numbers before DB or network access and logs block', async () => {
  const {outbound, calls, logs, supabase} = harness();
  assert.deepEqual(await sendInvoice(outbound, {to: OTHER}), {status: 'blocked', reason: 'test_allowlist'});
  assert.equal(supabase.reads.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(logs[0].event, 'whatsapp_outbound_blocked');
  assert.equal(logs[0].recipient, '***4567');
  assert.doesNotMatch(JSON.stringify(logs), /15551234567/);
});

test('enabled outbound still requires an explicit server-side test allowlist', async () => {
  const {outbound, calls, supabase} = harness({env: {...baseEnv, WHATSAPP_TEST_ALLOWLIST: undefined}});
  assert.deepEqual(await sendInvoice(outbound), {status: 'blocked', reason: 'invalid_test_allowlist'});
  assert.equal(supabase.reads.length, 0);
  assert.equal(calls.length, 0);
});

test('custom allowlist cannot expand sending beyond Vedang test number', async () => {
  const {outbound, calls} = harness({env: {...baseEnv, WHATSAPP_TEST_ALLOWLIST: `${PHONE},${OTHER}`}});
  assert.equal((await sendInvoice(outbound, {to: OTHER})).reason, 'test_allowlist');
  assert.equal(calls.length, 0);
});

test('empty or malformed allowlist blocks all sending', async () => {
  for (const WHATSAPP_TEST_ALLOWLIST of ['', 'not-a-phone', `${PHONE},bad`]) {
    const {outbound, calls} = harness({env: {...baseEnv, WHATSAPP_TEST_ALLOWLIST}});
    assert.equal((await sendInvoice(outbound)).reason, 'invalid_test_allowlist');
    assert.equal(calls.length, 0);
  }
});

test('Graph version must be explicitly configured before network access', async () => {
  const {outbound, calls} = harness({env: {...baseEnv, WHATSAPP_GRAPH_API_VERSION: undefined}});
  assert.equal((await sendInvoice(outbound)).reason, 'missing_graph_api_version');
  assert.equal(calls.length, 0);
});

test('suppression and missing consent each block a template before Graph', async () => {
  for (const setting of [{globallySuppressed: true}, {suppressed: true}, {consented: false}, {attested: false}]) {
    const {outbound, calls, supabase} = harness({supabase: fakeSupabase(setting)});
    assert.equal((await sendInvoice(outbound)).status, 'blocked');
    assert.equal(supabase.reads[0].table, 'whatsapp_global_suppressions');
    assert.equal(calls.length, 0);
  }
});

test('template send rechecks current invoice and uses only neutral fixed template', async () => {
  const stale = harness({currentInvoice: {...invoice, status: 'void'}});
  assert.equal((await sendInvoice(stale.outbound)).reason, 'invoice_state_changed');
  assert.equal(stale.calls.length, 0);
  const active = harness();
  assert.equal((await sendInvoice(active.outbound)).status, 'accepted');
  assert.equal(active.calls.length, 1);
  const payload = JSON.parse(active.calls[0].options.body);
  assert.equal(payload.to, PHONE.slice(1));
  assert.equal(payload.template.name, 'cetld_invoice_update_test');
  assert.deepEqual(payload.template.components[0].parameters.map(item => item.text), ['Acme Studio', 'INV-1']);
  assert.equal('body' in payload, false);
});

test('template requires durable invoice event claim before Graph', async () => {
  const missing = harness({claimInvoiceUpdate: null});
  assert.equal((await sendInvoice(missing.outbound)).reason, 'missing_invoice_claim');
  assert.equal(missing.calls.length, 0);
  const duplicate = harness({claimInvoiceUpdate: async () => ({claimed: false, reason: 'already_claimed'})});
  assert.equal((await sendInvoice(duplicate.outbound)).reason, 'already_claimed');
  assert.equal(duplicate.calls.length, 0);
  const seen = [];
  const accepted = harness({claimInvoiceUpdate: async input => { seen.push(input); return {claimed: true}; }});
  assert.equal((await sendInvoice(accepted.outbound)).status, 'accepted');
  assert.deepEqual(seen[0], {workspaceId: 'workspace-a', invoiceId: 'invoice-a', customerId: 'customer-a', phone: PHONE,
    idempotencyKey: 'invoice-a:event-1', expectedUpdatedAt: NOW});
});

test('STOP committed during invoice claim blocks Graph after the claim', async () => {
  let stopped = false;
  const attempt = harness({supabase: fakeSupabase({suppressed: () => stopped}),
    claimInvoiceUpdate: async () => { stopped = true; return {claimed: true}; }});
  assert.equal((await sendInvoice(attempt.outbound)).reason, 'suppressed');
  assert.equal(attempt.calls.length, 0);
});

test('sender identity must match current workspace business name', async () => {
  const attempt = harness();
  assert.equal((await sendInvoice(attempt.outbound, {businessName: 'Different Business'})).reason, 'business_name_mismatch');
  assert.equal(attempt.calls.length, 0);
});

test('collection words and stale invoice state never reach Graph', async () => {
  for (const invoiceNumber of ['DEBT-1', 'INV-DUE-1', 'REMINDER-1']) {
    const attempt = harness({currentInvoice: {...invoice, invoiceNumber}});
    assert.equal((await sendInvoice(attempt.outbound)).reason, 'collection_content');
    assert.equal(attempt.calls.length, 0);
  }
  const stale = harness({currentInvoice: {...invoice, updatedAt: '2026-09-27T12:01:00.000Z'}});
  assert.equal((await sendInvoice(stale.outbound)).reason, 'invoice_state_changed');
  assert.equal(stale.calls.length, 0);
  const overdue = harness({currentInvoice: {...invoice, status: 'overdue'}});
  assert.equal((await sendInvoice(overdue.outbound)).reason, 'invoice_state_changed');
  assert.equal(overdue.calls.length, 0);
});

test('service replies require an open 24-hour window and atomic inbound authorization', async () => {
  const closed = harness();
  const args = {workspaceId: 'workspace-a', to: PHONE, body: 'Your details are available in cetld.',
    businessName: 'Acme Studio', kind: 'normal', messageId: 'inbound-1'};
  assert.equal((await closed.outbound.sendServiceReply({...args, lastInboundAt: '2026-09-26T11:59:59.000Z'})).reason, 'service_window_closed');
  assert.equal(closed.calls.length, 0);
  const denied = harness({authorizeInboundReply: async () => ({allowed: false, reason: 'duplicate'})});
  assert.equal((await denied.outbound.sendServiceReply({...args, lastInboundAt: NOW})).reason, 'duplicate');
  assert.equal(denied.calls.length, 0);
  const accepted = harness();
  assert.equal((await accepted.outbound.sendServiceReply({...args, lastInboundAt: NOW})).status, 'accepted');
  assert.equal(JSON.parse(accepted.calls[0].options.body).text.body, args.body);
  const unix = harness();
  assert.equal((await unix.outbound.sendServiceReply({...args, lastInboundAt: String(Date.parse(NOW) / 1000)})).status, 'accepted');
});

test('STOP confirmation is the only suppression exception and still needs one-time claim', async () => {
  let claims = 0;
  const {outbound, calls} = harness({supabase: fakeSupabase({suppressed: true}), authorizeInboundReply: async () => ({allowed: ++claims === 1})});
  const args = {workspaceId: 'workspace-a', to: PHONE, kind: 'stop_confirmation', messageId: 'stop-1',
    businessName: 'Acme Studio', lastInboundAt: NOW};
  assert.equal((await outbound.sendServiceReply(args)).status, 'accepted');
  assert.equal((await outbound.sendServiceReply(args)).status, 'blocked');
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(calls[0].options.body).text.body, /opted out/);
});

test('unknown STOP gets one platform-branded confirmation after verified claim', async () => {
  let claims = 0;
  const {outbound, calls} = harness({authorizeInboundReply: async () => ({allowed: ++claims === 1})});
  const args = {workspaceId: null, to: PHONE, kind: 'stop_confirmation', messageId: 'unknown-stop',
    businessName: 'CETLD', lastInboundAt: NOW};
  assert.equal((await outbound.sendServiceReply(args)).status, 'accepted');
  assert.equal((await outbound.sendServiceReply(args)).status, 'blocked');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).text.body, "You've been opted out of WhatsApp updates. We won't message you again.");
});

test('unknown sender gets only fixed verification text after inbound authorization', async () => {
  const {outbound, calls} = harness({supabase: fakeSupabase({consented: false})});
  assert.equal((await outbound.sendServiceReply({workspaceId: null, to: PHONE, kind: 'verification',
    body: 'Invoice INV-9 is paid', businessName: 'CETLD', messageId: 'unknown-1', lastInboundAt: NOW})).status, 'accepted');
  assert.doesNotMatch(JSON.parse(calls[0].options.body).text.body, /INV-9|paid/i);
});

test('STOP committed during inbound reply authorization blocks verification Graph reply', async () => {
  for (const scope of ['global', 'workspace']) {
    let stopped = false;
    const attempt = harness({supabase: fakeSupabase({globallySuppressed: () => scope === 'global' && stopped,
      suppressed: () => scope === 'workspace' && stopped}),
      authorizeInboundReply: async () => { stopped = true; return {allowed: true}; }});
    assert.equal((await attempt.outbound.sendServiceReply({workspaceId: null, to: PHONE, kind: 'verification',
      businessName: 'CETLD', messageId: 'unknown-race', lastInboundAt: NOW})).reason,
    scope === 'global' ? 'globally_suppressed' : 'suppressed');
    assert.equal(attempt.calls.length, 0);
  }
});

test('WhatsApp assistant requires current binding and a customer-scoped store', async () => {
  let answers = 0;
  const channel = createWhatsAppAssistantChannel({
    authorizeChannel: async scope => ({...scope, allowed: true}),
    createCustomerScopedStore: async () => ({query() { return []; }}),
    answer: async () => { answers++; return {answer: 'Invoice is sent.', pendingAction: null}; },
  });
  const scope = {workspaceId: 'workspace-a', customerId: 'customer-a', phone: PHONE};
  assert.equal((await channel.ask({...scope, message: 'What is my invoice status?'})).answer, 'Invoice is sent.');
  assert.equal(answers, 1);
  assert.equal((await channel.ask({...scope, message: 'yes'})).requiresInAppConfirmation, true);
  assert.equal(answers, 1);
  assert.equal(channel.confirmFromWhatsApp().executed, false);
});

test('WhatsApp final replies are concise, answer-only, and omit standalone progress labels', async () => {
  const requests = [];
  const provider = {async generate(request) {
    requests.push(request);
    return {content: 'Thinking…\n\nINV-42 has USD 500 due on 1 October.'};
  }};
  const planningRequest = {messages: [{role: 'system', content: 'Plan the query.'}], tools: [], toolChoice: 'required'};
  const finalRequest = {messages: [
    {role: 'system', content: 'You are the cetld Assistant. Answer only what the user asked, concisely; use only supplied records.'},
    {role: 'user', content: 'Question: What is due?\nVerified record: INV-42, USD 500, due 1 October.'},
  ], maxTokens: 700, temperature: 0.1};
  const channel = createWhatsAppAssistantChannel({
    provider,
    authorizeChannel: async scope => ({...scope, allowed: true}),
    createCustomerScopedStore: async () => ({query() { return []; }}),
    answer: async ({provider: scopedProvider}) => {
      await scopedProvider.generate(planningRequest);
      const generated = await scopedProvider.generate(finalRequest);
      return {answer: generated.content, pendingAction: null};
    },
  });
  const result = await channel.ask({workspaceId: 'workspace-a', customerId: 'customer-a', phone: PHONE, message: 'What is due?'});

  assert.deepEqual(requests[0], planningRequest, 'tool planning remains untouched');
  assert.match(requests[1].messages[0].content, /WhatsApp reply guidance/i);
  assert.match(requests[1].messages[0].content, /1-2 short sentences/i);
  assert.match(requests[1].messages[0].content, /progress|status/i);
  assert.equal(requests[1].messages[1].content, finalRequest.messages[1].content);
  assert.equal(result.answer, 'INV-42 has USD 500 due on 1 October.');
  assert.doesNotMatch(result.answer, /thinking|looking up|searching/i);
});

test('WhatsApp replaces a progress-only model result with a short retry message', async () => {
  const channel = createWhatsAppAssistantChannel({
    authorizeChannel: async scope => ({...scope, allowed: true}),
    createCustomerScopedStore: async () => ({query() { return []; }}),
    answer: async () => ({answer: 'Thinking…', pendingAction: null}),
  });

  const result = await channel.ask({workspaceId: 'workspace-a', customerId: 'customer-a', phone: PHONE, message: 'What is due?'});
  assert.equal(result.answer, 'I couldn’t prepare a reply just now. Please try again.');
  assert.doesNotMatch(result.answer, /thinking/i);
});

test('WhatsApp preserves quoted progress words after the answer begins', async () => {
  const channel = createWhatsAppAssistantChannel({
    authorizeChannel: async scope => ({...scope, allowed: true}),
    createCustomerScopedStore: async () => ({query() { return []; }}),
    answer: async () => ({answer: 'INV-42 is current.\nLatest customer reply:\nThinking…', pendingAction: null}),
  });

  const result = await channel.ask({workspaceId: 'workspace-a', customerId: 'customer-a', phone: PHONE, message: 'What is due?'});
  assert.equal(result.answer, 'INV-42 is current.\nLatest customer reply:\nThinking…');
});

test('WhatsApp pending action is retained server-side for signed-in app review only', async () => {
  const saved = [];
  const channel = createWhatsAppAssistantChannel({
    authorizeChannel: async scope => ({...scope, allowed: true}),
    createCustomerScopedStore: async () => ({query() { return []; }}),
    answer: async () => ({answer: 'Create invoice?', pendingAction: {type: 'create_invoice', payload: {secret: 'internal'}}}),
    storePendingAction: async value => saved.push(value),
  });
  const result = await channel.ask({workspaceId: 'workspace-a', customerId: 'customer-a', phone: PHONE, message: 'Create an invoice'});
  assert.equal(saved.length, 1);
  assert.equal(result.pendingAction, null);
  assert.equal(result.requiresInAppConfirmation, true);
  assert.doesNotMatch(JSON.stringify(result), /internal|secret/);
});

test('without a durable pending-action store WhatsApp sends user to signed-in app', async () => {
  const channel = createWhatsAppAssistantChannel({
    authorizeChannel: async scope => ({...scope, allowed: true}),
    createCustomerScopedStore: async () => ({query() { return []; }}),
    answer: async () => ({answer: 'Create it?', pendingAction: {type: 'create_invoice'}}),
  });
  const result = await channel.ask({workspaceId: 'workspace-a', customerId: 'customer-a', phone: PHONE, message: 'Please create an invoice'});
  assert.equal(result.pendingAction, null);
  assert.match(result.answer, /open cetld while signed in/);
});

test('customer-scoped store applies workspace and customer predicates to invoice queries', async () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const calls = [];
  const supabase = {from(table) {
    const query = {table, filters: {}, select(value) { this.projection = value; return this; },
      eq(key, value) { this.filters[key] = value; return this; }, in(key, value) { this.filters[key] = value; return this; },
      ilike(key, value) { this.filters[key] = value; return this; }, order() { return this; },
      range() { calls.push({table, filters: {...this.filters}, projection: this.projection}); return Promise.resolve({data: []}); },
      limit() { return Promise.resolve({data: []}); }};
    return query;
  }};
  const store = createCustomerScopedStore({supabase, workspaceId, customerId});
  await store.query('invoices', {select: 'id,invoice_number', filters: {invoice_number: 'ilike.INV-1'}});
  assert.deepEqual(calls[0].filters, {workspace_id: workspaceId, customer_id: customerId, invoice_number: 'INV-1'});
  assert.match(calls[0].projection, /workspace_id/);
  assert.match(calls[0].projection, /customer_id/);
  await assert.rejects(() => store.query('invoices', {select: 'id', filters: {workspace_id: 'eq.other'}}), /unsupported filter/);
});

test('customer-scoped store excludes payments when customer owns no invoices', async () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const calls = [];
  const supabase = {from(table) {
    calls.push(table);
    const query = {select() { return this; }, eq() { return this; }, limit() { return Promise.resolve({data: [], count: 0}); }};
    return query;
  }};
  const store = createCustomerScopedStore({supabase, workspaceId, customerId});
  assert.deepEqual(await store.query('payments', {select: 'id,invoice_id,amount'}), []);
  assert.deepEqual(calls, ['invoices']);
});

test('customer-scoped store fails closed on capped invoice ownership result', async () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const supabase = {from() {
    return {select() { return this; }, eq() { return this; }, limit() {
      return Promise.resolve({data: [{id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', workspace_id: workspaceId, customer_id: customerId}], count: 2});
    }};
  }};
  const store = createCustomerScopedStore({supabase, workspaceId, customerId});
  await assert.rejects(() => store.query('payments', {select: 'id,invoice_id,amount'}), /cannot verify invoice ownership/);
});
