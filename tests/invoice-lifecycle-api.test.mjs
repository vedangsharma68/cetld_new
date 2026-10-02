import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/invoice-lifecycle.js';
import {config} from '../config.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const OWNER = '20000000-0000-4000-8000-000000000001';
const INVOICE = '30000000-0000-4000-8000-000000000001';
const PROPOSAL = '40000000-0000-4000-8000-000000000001';
const OWNER_JWT = 'Bearer owner-jwt-from-dashboard';
const savedFetch = globalThis.fetch;
const savedURL = process.env.SUPABASE_URL;
const savedKey = process.env.SUPABASE_PUBLISHABLE_KEY;

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedURL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = savedURL;
  if (savedKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
  else process.env.SUPABASE_PUBLISHABLE_KEY = savedKey;
});

function response() {
  return {statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }};
}

function installTransport({role = 'owner', membership = true, rpcStatus = 200, rpcBody = {ok: true, action: 'capabilities', available: true}} = {}) {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({url, init});
    if (url.pathname === '/auth/v1/user') return Response.json({id: OWNER});
    if (url.pathname === '/rest/v1/workspace_members') {
      return Response.json(membership ? [{workspace_id: WORKSPACE, user_id: OWNER, role}] : []);
    }
    if (url.pathname === '/rest/v1/rpc/invoice_lifecycle_action') return Response.json(rpcBody, {status: rpcStatus});
    throw new Error(`Unexpected fetch to ${url.pathname}`);
  };
  return calls;
}

async function invoke(action, extra = {}) {
  const res = response();
  await handler({method: 'POST', headers: {authorization: OWNER_JWT}, body: {action, workspaceId: WORKSPACE, ...extra}}, res);
  return res;
}

test('invoice lifecycle handler uses public Supabase config fallback and preserves the owner JWT through its RPC', async () => {
  const calls = installTransport();
  const res = await invoke('capabilities');

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {ok: true, action: 'capabilities', available: true});
  assert.ok(calls.length >= 3);
  for (const {url, init} of calls) {
    assert.equal(url.origin, config.url);
    assert.equal(init.headers.apikey, config.key);
    assert.equal(init.headers.Authorization, OWNER_JWT);
  }
  assert.ok(calls.some(({url}) => url.pathname === '/rest/v1/rpc/invoice_lifecycle_action'));
});

test('invoice lifecycle handler denies members and foreign workspaces before RPC', async () => {
  for (const options of [{role: 'member'}, {membership: false}]) {
    const calls = installTransport(options);
    const res = await invoke('capabilities');

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {ok: false, code: 'OWNER_REQUIRED'});
    assert.equal(calls.some(({url}) => url.pathname === '/rest/v1/rpc/invoice_lifecycle_action'), false);
  }
});

test('missing lifecycle RPC safely disables the capability', async () => {
  const calls = installTransport({rpcStatus: 404, rpcBody: {code: 'PGRST202', message: 'internal function detail'}});
  const res = await invoke('capabilities');

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {ok: true, action: 'capabilities', available: false});
  assert.doesNotMatch(JSON.stringify(res.body), /internal function detail|PGRST202/);
  assert.ok(calls.some(({url}) => url.pathname === '/rest/v1/rpc/invoice_lifecycle_action'));
});

test('prepare, confirm, and undo database failures return only safe public errors', async () => {
  const cases = [
    ['prepareDelete', {invoiceId: INVOICE, idempotencyKey: 'prepare-request-0001', requestMessageId: 'prepare-message-0001'}],
    ['confirmDelete', {proposalId: PROPOSAL, userMessage: 'yes, delete it', confirmationMessageId: 'confirm-message-0001'}],
    ['undoDelete', {invoiceId: INVOICE, idempotencyKey: 'undo-request-000001', userMessage: 'undo delete', requestMessageId: 'undo-message-0001'}],
  ];

  for (const [action, fields] of cases) {
    const calls = installTransport({rpcStatus: 500, rpcBody: {code: 'XX000', message: 'private database detail'}});
    const res = await invoke(action, fields);

    assert.equal(res.statusCode, 503, action);
    assert.deepEqual(res.body, {ok: false, code: 'DATABASE_UNAVAILABLE'}, action);
    assert.doesNotMatch(JSON.stringify(res.body), /private database detail|XX000/);
    assert.ok(calls.some(({url}) => url.pathname === '/rest/v1/rpc/invoice_lifecycle_action'), action);
  }
});
