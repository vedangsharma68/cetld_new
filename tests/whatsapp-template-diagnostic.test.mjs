import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppInvoiceTestHandler} from '../automation/whatsapp/test-send.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '33333333-3333-4333-8333-333333333333';
const recipient = '+919871367051';
const names = ['cetld_invoice_update_v2', 'cetld_invoice_update_btn_v2', 'cetld_invoice_gentle_v1', 'cetld_invoice_gentle_btn_v1'];
const env = {WHATSAPP_TEST_OPERATOR_USER_ID: userId, WHATSAPP_OUTBOUND_ENABLED: 'true', WHATSAPP_TEST_ALLOWLIST: recipient,
  WHATSAPP_ACCESS_TOKEN: 'private-server-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_WABA_ID: '9876543210',
  WHATSAPP_GRAPH_API_VERSION: 'v24.0', SUPABASE_SERVICE_ROLE_KEY: 'private-service-key'};
const query = {workspaceId, action: 'templates', recipient, language: 'en'};
const template = name => ({id: '5555555555', name, language: 'en', status: 'APPROVED', category: 'UTILITY',
  parameter_format: 'POSITIONAL', components: [{type: 'BODY', text: 'Invoice {{1}} due {{2}}', example: {body_text: [['private example']]}},
    {type: 'BUTTONS', buttons: [{type: 'URL', text: 'View invoice', url: 'https://example.com/{{1}}', example: ['private example']}]}],
  access_token: env.WHATSAPP_ACCESS_TOKEN});
function setup({environment = {}, authorize, graph} = {}) {
  const calls = [], authorizations = [];
  const handler = createWhatsAppInvoiceTestHandler({env: {...env, ...environment},
    authorize: async (...args) => {authorizations.push(args); return authorize ? authorize(...args) : {workspaceId, userId, role: 'owner'};},
    loadSupabase() {throw Error('must not access service role/database');},
    outboundFactory() {throw Error('must not instantiate message sender');},
    fetchImpl: async (url, options) => {
      calls.push({url, options}); const parsed = new URL(url);
      const payload = graph ? await graph(parsed, calls.length) : parsed.pathname.endsWith('/phone_numbers')
        ? {data: [{id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+91 73033 38959'}]}
        : {data: [template(parsed.searchParams.get('name')), template('unapproved_name'), {...template(parsed.searchParams.get('name')), language: 'hi'}]};
      return payload instanceof Response ? payload : Response.json(payload);
    }});
  async function run({input = query, method = 'GET'} = {}) {
    const res = {code: null, body: null, headers: {}, setHeader(key, value) {this.headers[key] = value;},
      status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};
    await handler({method, query: input, body: input, headers: {authorization: 'Bearer caller-jwt-unchanged'}}, res); return res;
  }
  return {run, calls, authorizations};
}

test('fixed read reuses owner/operator authorization and emits only four sanitized English templates', async () => {
  const {run, calls, authorizations} = setup(); const res = await run();
  assert.equal(res.code, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(authorizations.length, 1); assert.equal(authorizations[0][1], workspaceId);
  assert.equal(authorizations[0][0].headers.authorization, 'Bearer caller-jwt-unchanged');
  assert.deepEqual(res.body.templates.map(row => row.name), names);
  assert.equal(res.body.recipient, recipient); assert.equal(res.body.readOnly, true); assert.equal(calls.length, 5);
  for (const {url, options} of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`);
    assert.ok(url.startsWith('https://graph.facebook.com/v24.0/9876543210/')); assert.ok(!url.includes(env.WHATSAPP_ACCESS_TOKEN));
  }
  const serialized = JSON.stringify(res.body);
  for (const value of [env.WHATSAPP_ACCESS_TOKEN, env.SUPABASE_SERVICE_ROLE_KEY, 'private example', 'unapproved_name', 'previewToken']) assert.ok(!serialized.includes(value));
  assert.equal(res.body.templates[0].components[1].buttons[0].url, 'https://example.com/{{1}}');
});

test('unauthorized, disabled and different scope calls never reach Graph', async () => {
  for (const options of [
    {authorize: () => ({workspaceId, userId, role: 'member'})}, {environment: {WHATSAPP_TEST_OPERATOR_USER_ID: ''}},
    {environment: {WHATSAPP_TEST_OPERATOR_USER_ID: 'another-user'}}, {environment: {WHATSAPP_OUTBOUND_ENABLED: 'false'}},
    {environment: {WHATSAPP_TEST_ALLOWLIST: ''}}, {environment: {WHATSAPP_ACCESS_TOKEN: ''}},
    {environment: {WHATSAPP_WABA_ID: '../other-account'}}, {environment: {WHATSAPP_PHONE_NUMBER_ID: ''}},
    {environment: {WHATSAPP_GRAPH_API_VERSION: ''}},
  ]) {const s = setup(options); assert.ok((await s.run()).code >= 400); assert.equal(s.calls.length, 0);}
  for (const input of [{...query, recipient: '+919818685252'}, {...query, language: 'hi'}, {...query, name: names[0]}, {...query, invoiceId: workspaceId}]) {
    const s = setup(); assert.ok((await s.run({input})).code >= 400); assert.equal(s.calls.length, 0);
  }
  const s = setup(); assert.equal((await s.run({method: 'POST'})).code, 400); assert.equal(s.calls.length, 0);
});

test('configured sender must belong to configured account and match the known bot', async () => {
  for (const data of [[], [{id: 'other-phone', display_phone_number: '+91 73033 38959'}],
    [{id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+91 99999 99999'}]]) {
    const s = setup({graph: () => ({data})}); assert.equal((await s.run()).body.error, 'WHATSAPP_TEMPLATE_ACCOUNT_MISMATCH'); assert.equal(s.calls.length, 1);
  }
});

test('pagination reconstructs the same account endpoint and never follows arbitrary next URLs', async () => {
  const s = setup({graph: url => url.pathname.endsWith('/phone_numbers')
    ? url.searchParams.has('after') ? {data: [{id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+917303338959'}]}
      : {data: [], paging: {next: `https://evil.example/?access_token=${env.WHATSAPP_ACCESS_TOKEN}`, cursors: {after: 'cursorA'}}}
    : {data: []}});
  assert.equal((await s.run()).code, 200); assert.equal(s.calls.length, 6);
  assert.equal(new URL(s.calls[1].url).searchParams.get('after'), 'cursorA');
  assert.ok(s.calls.every(call => new URL(call.url).hostname === 'graph.facebook.com'));
});

test('pagination limits, repeats and malformed cursors fail closed', async () => {
  for (const cursor of [undefined, 'https://evil.example', env.WHATSAPP_ACCESS_TOKEN, 'repeated']) {
    const s = setup({graph: () => ({data: [], paging: {next: 'ignored', cursors: {after: cursor}}})});
    assert.equal((await s.run()).body.error, 'INVALID_TEMPLATE_PAGINATION'); assert.ok(s.calls.length <= 2);
  }
  const s = setup({graph: (_url, count) => ({data: [], paging: {next: 'ignored', cursors: {after: `cursor${count}`}}})});
  assert.equal((await s.run()).body.error, 'TEMPLATE_PAGINATION_LIMIT'); assert.equal(s.calls.length, 3);
});

test('upstream failures, excessive bodies and metadata secrets never leak', async () => {
  for (const graph of [() => {throw Error(env.WHATSAPP_ACCESS_TOKEN);}, () => Response.json({error: env.WHATSAPP_ACCESS_TOKEN}, {status: 401}),
    () => new Response('x'.repeat(128 * 1024 + 1)), () => Response.json({data: null}),
    url => url.pathname.endsWith('/phone_numbers') ? {data: [{id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+917303338959'}]}
      : {data: [{...template(url.searchParams.get('name')), components: [{type: 'BODY', text: env.WHATSAPP_ACCESS_TOKEN}]}]}]) {
    const s = setup({graph}); const res = await s.run(); assert.ok(res.code >= 400);
    assert.ok(!JSON.stringify(res.body).includes(env.WHATSAPP_ACCESS_TOKEN));
  }
});

test('unapproved status/category are returned as evidence, never accepted for sending', async () => {
  const s = setup({graph: url => url.pathname.endsWith('/phone_numbers') ? {data: [{id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+917303338959'}]}
    : {data: [{...template(url.searchParams.get('name')), status: 'REJECTED', category: 'MARKETING'}]}});
  const res = await s.run(); assert.equal(res.code, 200); assert.equal(res.body.templates[0].status, 'REJECTED');
  assert.equal(res.body.templates[0].category, 'MARKETING'); assert.equal(s.calls.length, 5);
});

test('real workspace authorizer requires a valid session and exact owner membership before Graph', async () => {
  for (const role of ['owner', 'member', null]) {
    const calls = [];
    const handler = createWhatsAppInvoiceTestHandler({env: {...env, SUPABASE_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'public-key'},
      loadSupabase() {throw Error('unexpected database client');},
      fetchImpl: async (rawURL, options) => {
        const url = new URL(rawURL); calls.push({url, options});
        if (url.pathname === '/auth/v1/user') return Response.json({id: userId});
        if (url.pathname === '/rest/v1/workspace_members') {
          assert.equal(url.searchParams.get('workspace_id'), `eq.${workspaceId}`);
          assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
          return Response.json(role ? [{workspace_id: workspaceId, user_id: userId, role}] : []);
        }
        return Response.json(url.pathname.endsWith('/phone_numbers')
          ? {data: [{id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: '+917303338959'}]} : {data: []});
      }});
    const response = () => ({code: null, body: null, setHeader() {}, status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}});
    const signedOut = response(); await handler({method: 'GET', query, headers: {}}, signedOut);
    assert.equal(signedOut.code, 401); assert.equal(calls.length, 0);
    const signedIn = response(); await handler({method: 'GET', query, headers: {authorization: 'Bearer session-jwt-for-owner'}}, signedIn);
    assert.equal(signedIn.code, role === 'owner' ? 200 : 403);
    assert.equal(calls.filter(call => call.url.hostname === 'graph.facebook.com').length, role === 'owner' ? 5 : 0);
    for (const call of calls.filter(call => call.url.hostname === 'db.example')) {
      assert.equal(call.options.headers.Authorization, 'Bearer session-jwt-for-owner'); assert.equal(call.options.method, undefined);
    }
  }
});
