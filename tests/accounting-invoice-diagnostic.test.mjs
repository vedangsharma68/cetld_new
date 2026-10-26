import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleInvoiceDiagnostic, INVOICE_DIAGNOSTIC_TIMEOUT_MS } from '../automation/accounting-invoice-diagnostic.mjs';
import { TokenCipher, connectionAad } from '../automation/accounting/crypto.mjs';
import { SupabaseAccountingStore, InMemoryAccountingStore } from '../automation/accounting/store.mjs';

const workspaceId = '10000000-0000-0000-0000-000000000001';
const userId = '10000000-0000-0000-0000-000000000002';
const invoiceId = '10000000-0000-0000-0000-000000000003';
const otherId = '10000000-0000-0000-0000-000000000004';
const key = Buffer.alloc(32, 19);
const remote = () => ({ code: 0, invoice: { invoice_id: '123456789', organization_id: '987654321',
  currency_code: 'INR', total: 125, balance: 100, payment_made: 25, status: 'partially_paid',
  customer_name: 'PRIVATE CUSTOMER', email: 'private@example.test', access_token: 'PRIVATE PROVIDER TOKEN' } });

function fixture(options = {}) {
  const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'fixture-public',
    SUPABASE_SERVICE_ROLE_KEY: 'PRIVATE SERVICE KEY', ACCOUNTING_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    ZOHO_BOOKS_CLIENT_ID: 'fixture-client', ZOHO_BOOKS_CLIENT_SECRET: 'PRIVATE CLIENT SECRET' };
  const token = { accessToken: 'PRIVATE ACCESS TOKEN', refreshToken: 'PRIVATE REFRESH TOKEN',
    expiresAt: options.expired ? Date.now() - 1000 : Date.now() + 3600000,
    apiDomain: 'https://www.zohoapis.in', accountsDomain: 'https://accounts.zoho.in', region: 'in', ...options.token };
  const encrypted = new TokenCipher(key).encrypt(token, connectionAad('zoho_books', workspaceId));
  const connection = { owner_id: userId, workspace_id: workspaceId, provider: 'zoho_books',
    provider_account_id: '987654321', status: 'connected', region: 'in', api_domain: token.apiDomain,
    accounts_domain: token.accountsDomain, revision: 1, token_expires_at: new Date(token.expiresAt).toISOString(),
    token_ciphertext: encrypted.ciphertext, token_iv: encrypted.iv, token_tag: encrypted.tag, ...options.connection };
  const invoice = { id: invoiceId, workspace_id: workspaceId, external_provider: 'zoho_books', external_invoice_id: '123456789',
    updated_at: '2026-10-20T00:00:00Z', deleted_at: options.deleted ? '2026-10-21T00:00:00Z' : null,
    accounting_provider: 'zoho_books', bookkeeping_provider: 'zoho_books', bookkeeping_record_id: '123456789',
    ...options.invoice };
  const protectedState = { invoice, customers: [{ name: 'PRIVATE CUSTOMER' }], payments: [], snapshots: [],
    conversations: [], reviews: [], reminders: [], queue: [], sends: [], oauth: [] };
  const before = structuredClone(protectedState), initialConnection = structuredClone(connection);
  const calls = [], forbidden = []; let owner = userId, connectionReads = 0, authReads = 0, workspaceReads = 0;
  const json = (value, status = 200) => Response.json(value, { status });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET';
    const call = { url, method, init }; calls.push(call);
    await options.onCall?.({ call, invoice, connection, setOwner: value => { owner = value; } });
    assert.ok(init.signal, 'all requests share the bounded signal');
    if (options.hangAt?.(url)) return new Promise(() => {}); // Even an abort-ignoring transport is bounded outwardly.
    if (url.origin === env.SUPABASE_URL && url.pathname === '/auth/v1/user' && method === 'GET') {
      authReads++;
      return json({ id: userId }, options.authStatus || (init.headers.Authorization === 'Bearer fixture-user' ? 200 : 401));
    }
    if (url.origin === env.SUPABASE_URL && url.pathname === '/rest/v1/workspaces' && method === 'GET') {
      workspaceReads++;
      assert.equal(url.searchParams.get('owner_id'), `eq.${userId}`);
      return json(owner === userId && url.searchParams.get('id') === `eq.${workspaceId}` ? [{ id: workspaceId, owner_id: owner }] : []);
    }
    if (url.origin === env.SUPABASE_URL && url.pathname === '/rest/v1/invoices' && method === 'GET') {
      assert.equal(url.searchParams.get('workspace_id'), `eq.${workspaceId}`);
      assert.equal(url.searchParams.get('id'), `eq.${invoiceId}`);
      assert.equal(url.searchParams.get('limit'), '1');
      assert.equal(url.searchParams.has('deleted_at'), false, 'soft-deleted rows are read without restoration');
      assert.equal(url.searchParams.get('select'), 'id,workspace_id,external_provider,external_invoice_id,updated_at,deleted_at,accounting_provider:metadata->>accounting_provider,bookkeeping_provider:metadata->>bookkeeping_provider,bookkeeping_record_id:metadata->>bookkeeping_record_id');
      return json(options.missingInvoice ? [] : [structuredClone(invoice)]);
    }
    if (url.origin === env.SUPABASE_URL && url.pathname === '/rest/v1/cetld_accounting_connections' && method === 'GET') {
      connectionReads++;
      assert.equal(url.searchParams.get('owner_id'), `eq.${userId}`);
      assert.equal(url.searchParams.get('workspace_id'), `eq.${workspaceId}`);
      assert.equal(url.searchParams.get('provider'), `eq.${invoice.external_provider}`);
      await options.onConnectionRead?.({ connection, count: connectionReads });
      return json(options.disconnected ? [] : [structuredClone(connection)]);
    }
    // The only permissible writes are existing refresh lease/token operations.
    if (options.expired && url.origin === env.SUPABASE_URL && method === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
      const body = JSON.parse(init.body);
      assert.equal(body.p_owner_id, userId); assert.equal(body.p_workspace_id, workspaceId);
      assert.equal(body.p_provider, 'zoho_books');
      if (url.pathname.endsWith('/cetld_claim_accounting_connection_refresh')) {
        connection.refresh_lease_token = body.p_lease_token;
        return json([{ claimed: true, revision: connection.revision }]);
      }
      if (url.pathname.endsWith('/cetld_update_accounting_connection_tokens')) {
        if (body.p_expected_revision !== connection.revision) return json([]);
        assert.equal(body.p_lease_token, connection.refresh_lease_token);
        Object.assign(connection, { token_ciphertext: body.p_token_ciphertext, token_iv: body.p_token_iv,
          token_tag: body.p_token_tag, token_expires_at: body.p_token_expires_at, revision: connection.revision + 1,
          refresh_lease_token: null });
        return json([structuredClone(connection)]);
      }
      if (url.pathname.endsWith('/cetld_release_accounting_connection_refresh')) {
        connection.refresh_lease_token = null; return json(null);
      }
    }
    if (options.expired && url.origin === 'https://accounts.zoho.in' && url.pathname === '/oauth/v2/token' && method === 'POST') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), token.refreshToken);
      return json(options.refreshBody || { access_token: 'PRIVATE ROTATED TOKEN', expires_in: 3600,
        api_domain: 'https://www.zohoapis.in' }, options.refreshStatus || 200);
    }
    if (url.origin === 'https://www.zohoapis.in' && url.pathname === '/books/v3/invoices/123456789' && method === 'GET') {
      assert.deepEqual([...url.searchParams], [['organization_id', '987654321']]);
      assert.equal(init.redirect, 'error');
      if (options.providerFailure) throw Error('PRIVATE NETWORK ERROR');
      await options.onProvider?.({ invoice, connection, setOwner: value => { owner = value; } });
      if (options.providerResponse) return options.providerResponse(init.signal);
      return options.invalidJson ? new Response('PRIVATE INVALID JSON') : json(options.body || remote(), options.providerStatus || 200);
    }
    forbidden.push(`${method} ${url.origin}${url.pathname}`);
    throw Error('Forbidden effect or enumeration attempted');
  };
  const run = async (overrides = {}) => {
    const response = { headers: {}, statusCode: null, payload: null,
      setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; } };
    await handleInvoiceDiagnostic({ method: 'POST', url: '/api/accounting-invoice-diagnostic',
      headers: { authorization: 'Bearer fixture-user' }, body: { workspaceId, invoiceId }, ...overrides }, response,
    { env, fetchImpl, timeoutMs: options.timeoutMs });
    assert.deepEqual(forbidden, [], 'no other provider/service/action can be reached');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    const serialized = JSON.stringify(response.payload);
    for (const secret of ['PRIVATE', 'customer_name', 'email', 'access_token', 'ciphertext', 'refresh_token'])
      assert.equal(serialized.includes(secret), false, `response must redact ${secret}`);
    return response;
  };
  const unchanged = () => {
    assert.deepEqual(protectedState, before, 'no invoice/customer/payment/snapshot/conversation/review/reminder/queue/send/OAuth effects');
    if (!options.expired && !options.onProvider && !options.onCall && !options.onConnectionRead)
      assert.deepEqual(connection, initialConnection, 'connection is not rebound or modified');
  };
  return { run, unchanged, calls, invoice, connection, counts: () => ({ connectionReads, authReads, workspaceReads }),
    providerCalls: () => calls.filter(c => c.url.origin.includes('zohoapis')) };
}

test('exact current-account diagnostic reads active and soft-deleted rows without effects or reminder authority', async () => {
  for (const deleted of [false, true]) {
    const f = fixture({ deleted }), res = await f.run();
    assert.equal(res.statusCode, 200);
    const { checkedAt, ...facts } = res.payload;
    assert.ok(Number.isFinite(Date.parse(checkedAt)));
    assert.deepEqual(facts, { workspaceId, invoiceId, provenance: 'provenance_unverified', existence: 'present',
      provider: 'zoho_books', currentAccountId: '987654321', exactId: '123456789', status: 'partially_paid',
      currency: 'INR', totalMinor: 12500, balanceMinor: 10000, paidMinor: 2500 });
    assert.equal(f.providerCalls().length, 1);
    assert.equal(f.counts().authReads, 2, 'owner is reauthorized after remote work');
    assert.equal(Object.hasOwn(res.payload, 'authorized'), false);
    f.unchanged();
  }
});

test('caller cannot forge provider/account/external/user/action fields or use GET/query fallthrough', async () => {
  for (const extra of ['provider', 'organizationId', 'currentAccountId', 'externalId', 'userId', 'ownerId', 'action', 'keepExistingInvoices', '__proto__']) {
    const f = fixture(), body = JSON.parse(JSON.stringify({ workspaceId, invoiceId }).slice(0, -1) + `,"${extra}":"forged"}`);
    assert.equal((await f.run({ body })).statusCode, 400);
    assert.equal(f.calls.length, 0); f.unchanged();
  }
  for (const req of [{ method: 'GET' }, { method: 'DELETE' }, { url: '/api/accounting-invoice-diagnostic?organizationId=forged' },
    { body: { workspaceId, invoiceId: '../arbitrary' } }, { body: { workspaceId: otherId, invoiceId } },
    { body: { workspaceId, invoiceId, extra: null } }, { body: 'not-json' }, { body: [] }, { body: { workspaceId, invoiceId: 123 } },
    { url: 'http://[', body: { workspaceId: { secret: 'PRIVATE' }, invoiceId } }]) {
    const f = fixture(), res = await f.run(req);
    assert.ok(res.statusCode >= 400); assert.equal(f.providerCalls().length, 0); f.unchanged();
  }
});

test('auth, workspace owner, saved workspace and canonical linkage fail closed before any provider access', async () => {
  for (const options of [{ authStatus: 401 }, { missingInvoice: true }, { invoice: { workspace_id: otherId } },
    { invoice: { id: otherId } }, { invoice: { external_provider: null, external_invoice_id: null } },
    { invoice: { external_invoice_id: '../../contacts' } }, { invoice: { external_invoice_id: 123456789 } },
    { invoice: { accounting_provider: 'quickbooks' } }, { invoice: { bookkeeping_provider: 'tally' } },
    { invoice: { bookkeeping_record_id: 'different' } }, { connection: { owner_id: otherId } },
    { connection: { workspace_id: otherId } }, { connection: { provider: 'quickbooks' } },
    { connection: { provider_account_id: 'malformed/account' } }, { connection: { region: 'evil.test' } },
    { connection: { api_domain: 'https://attacker.test' } },
    { token: { providerAccountId: '111111' } }, { token: { apiDomain: 'https://www.zohoapis.eu' }, connection: { api_domain: 'https://www.zohoapis.in' } },
    { onCall: ({ call, setOwner }) => { if (call.url.pathname === '/rest/v1/workspaces') setOwner(otherId); } }]) {
    const f = fixture(options), res = await f.run();
    assert.notEqual(res.payload.existence, 'present'); assert.equal(f.providerCalls().length, 0); f.unchanged();
  }
});

test('QuickBooks disconnected/connected and Tally unsupported never simulate a provider read', async () => {
  for (const [options, reason] of [[{ disconnected: true }, 'not_connected'],
    [{ connection: { status: 'disconnected' } }, 'not_connected'],
    [{ invoice: { external_provider: 'quickbooks', accounting_provider: 'quickbooks', bookkeeping_provider: 'quickbooks' }, disconnected: true }, 'not_connected'],
    [{ invoice: { external_provider: 'quickbooks', accounting_provider: 'quickbooks', bookkeeping_provider: 'quickbooks' }, connection: { provider: 'quickbooks' } }, 'provider_unsupported'],
    [{ invoice: { external_provider: 'tally' } }, 'provider_unsupported']]) {
    const f = fixture(options), res = await f.run();
    assert.equal(res.payload.reason, reason); assert.equal(f.providerCalls().length, 0); f.unchanged();
  }
});

test('403, ambiguous 404/1002, auth, throttling, network and empty/malformed absence are never absent', async () => {
  for (const [options, reason] of [[{ providerStatus: 401 }, 'provider_authentication_failed'],
    [{ providerStatus: 403, body: { code: 1002, message: 'PRIVATE invoice does not exist' } }, 'provider_access_denied'],
    [{ providerStatus: 404, body: { code: 1002, message: 'PRIVATE invoice does not exist' } }, 'provider_absence_unverifiable'],
    [{ providerStatus: 429 }, 'provider_throttled'], [{ providerStatus: 500 }, 'provider_read_unverifiable'],
    [{ providerFailure: true }, 'provider_read_unverifiable'], [{ invalidJson: true }, 'provider_read_unverifiable'],
    [{ body: { code: 0, invoice: null } }, 'provider_read_unverifiable'],
    [{ body: { code: 1002, message: 'Invoice does not exist' } }, 'provider_read_unverifiable']]) {
    const f = fixture(options), res = await f.run();
    assert.equal(res.payload.existence, 'unverifiable'); assert.equal(res.payload.reason, reason);
    assert.equal(res.payload.exactId, '123456789'); assert.equal(res.payload.currentAccountId, '987654321');
    assert.equal(Object.hasOwn(res.payload, 'balanceMinor'), false);
    assert.equal(f.providerCalls().length, 1, 'no refresh-on-403 or network retry'); f.unchanged();
  }
});

test('malicious/wrong-ID/wrong-account/unsafe monetary or status responses expose no facts', async () => {
  for (const patch of [{ invoice_id: 'different' }, { invoice_id: 123456789 }, { organization_id: 'another-account' },
    { status: '<script>PRIVATE</script>' }, { status: { token: 'PRIVATE' } }, { currency_code: 'BAD' },
    { currency_code: 'inr' }, { total: null }, { total: true }, { total: [] }, { total: {} }, { total: '0x100' },
    { total: '1e2' }, { total: '1.001' }, { total: 0.000000001 }, { total: '9007199254740992' },
    { balance: -1 }, { balance: 126 }, { payment_made: -1 }, { payment_made: 26 }, { status: 'paid' },
    { total: 'Infinity' }, { total: '125 PRIVATE' }]) {
    const body = remote(); Object.assign(body.invoice, patch);
    const f = fixture({ body }), res = await f.run();
    assert.equal(res.payload.existence, 'unverifiable', JSON.stringify(patch));
    assert.equal(Object.hasOwn(res.payload, 'status'), false); f.unchanged();
  }
  const body = remote(); delete body.invoice.payment_made;
  const f = fixture({ body }), res = await f.run();
  assert.equal(res.payload.existence, 'present'); assert.equal(res.payload.paidMinor, null); f.unchanged();
});

test('connection changes before/during/after exact read invalidate all facts including failure classification', async () => {
  for (const change of [{ provider_account_id: '111111' }, { status: 'disconnected' }, { owner_id: otherId },
    { workspace_id: otherId }, { region: 'eu' }, { token_ciphertext: 'reconsented' }, { revision: 3 }]) {
    const f = fixture({ onProvider: ({ connection }) => Object.assign(connection, change) });
    const res = await f.run(); assert.equal(res.payload.reason, 'connection_changed');
    assert.equal(res.payload.existence, 'unverifiable'); assert.equal(Object.hasOwn(res.payload, 'balanceMinor'), false);
    f.unchanged();
  }
  for (const count of [2, 3, 4, 5]) {
    const f = fixture({ onConnectionRead: ({ connection, count: n }) => { if (n === count) connection.revision++; } });
    assert.equal((await f.run()).payload.reason, 'connection_changed'); f.unchanged();
  }
  const f = fixture({ providerStatus: 404, onProvider: ({ connection }) => { connection.revision += 2; } });
  assert.equal((await f.run()).payload.reason, 'connection_changed'); f.unchanged();
});

test('saved linkage change or workspace ownership revocation after remote read invalidates result', async () => {
  for (const change of [{ external_invoice_id: '111111' }, { deleted_at: '2026-10-25T00:00:00Z' }, { updated_at: 'new-version' }]) {
    const f = fixture({ onProvider: ({ invoice }) => Object.assign(invoice, change) });
    const res = await f.run(); assert.equal(res.payload.reason, 'local_record_changed');
    assert.equal(Object.hasOwn(res.payload, 'balanceMinor'), false);
    // Only the injected concurrent actor changes the fixture row.
    Object.assign(f.invoice, { external_invoice_id: '123456789', deleted_at: null, updated_at: '2026-10-20T00:00:00Z' });
    f.unchanged();
  }
  const f = fixture({ onProvider: ({ setOwner }) => setOwner(otherId) });
  assert.equal((await f.run()).statusCode, 403); f.unchanged();
});

test('one deadline bounds auth, connection preparation, refresh and provider/body reads, with no late continuation', async () => {
  assert.equal(INVOICE_DIAGNOSTIC_TIMEOUT_MS, 5000);
  for (const target of ['/auth/v1/user', '/rest/v1/cetld_accounting_connections', '/oauth/v2/token', '/books/v3/invoices/123456789']) {
    const f = fixture({ expired: target === '/oauth/v2/token', timeoutMs: 25, hangAt: url => url.pathname === target });
    const started = Date.now(), res = await f.run();
    assert.equal(res.payload.reason, 'timeout'); assert.equal(res.payload.existence, 'unverifiable');
    assert.ok(Date.now() - started < 1000);
    const count = f.calls.length;
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(f.calls.length, count, 'no late provider or store operation'); f.unchanged();
  }
  // Response headers can arrive while the body stalls; the same deadline applies.
  const f = fixture({ timeoutMs: 25 });
  let release;
  const res = { setHeader() {}, status() { return this; }, json(body) { this.payload = body; } };
  await handleInvoiceDiagnostic({ method: 'POST', url: '/api/accounting-invoice-diagnostic', headers: { authorization: 'Bearer fixture-user' },
    body: { workspaceId, invoiceId } }, res, { timeoutMs: 25, env: { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'public' },
    fetchImpl: async () => ({ ok: true, json: () => new Promise(resolve => { release = resolve; }) }) });
  assert.equal(res.payload.reason, 'timeout'); release({ id: userId });
  await new Promise(resolve => setTimeout(resolve, 5)); f.unchanged();
});

test('ordinary existing token refresh is allowed but only refresh metadata changes, with no organization discovery', async () => {
  const f = fixture({ expired: true }), res = await f.run();
  assert.equal(res.payload.existence, 'present'); assert.equal(f.connection.revision, 2);
  assert.equal(f.providerCalls().length, 1);
  assert.deepEqual(f.calls.filter(c => c.method !== 'GET').map(c => c.url.pathname),
    ['/rest/v1/rpc/cetld_claim_accounting_connection_refresh', '/oauth/v2/token', '/rest/v1/rpc/cetld_update_accounting_connection_tokens']);
  assert.equal(f.connection.provider_account_id, '987654321'); f.unchanged();
  const bad = fixture({ expired: true, refreshBody: { access_token: 'PRIVATE ROTATED TOKEN', expires_in: 3600, api_domain: 'https://www.zohoapis.eu' } });
  assert.equal((await bad.run()).payload.reason, 'connection_changed'); assert.equal(bad.providerCalls().length, 0); bad.unchanged();
});

test('late provider/refresh results after timeout cannot initiate any follow-on requests', async () => {
  for (const refresh of [false, true]) {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const f = fixture({ expired: refresh, timeoutMs: 25,
      onCall: refresh ? async ({ call }) => { if (call.url.pathname === '/oauth/v2/token') await hold; } : undefined,
      onProvider: refresh ? undefined : async () => hold });
    assert.equal((await f.run()).payload.reason, 'timeout');
    const count = f.calls.length; release();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.calls.length, count); f.unchanged();
  }
});

test('large response and streaming bodies are bounded, error bodies are not parsed, and nothing is logged', async () => {
  const body = remote(); body.invoice.notes = 'PRIVATE'.repeat(50000);
  const f = fixture({ body }), res = await f.run();
  assert.equal(res.payload.existence, 'unverifiable'); f.unchanged();
  const logged = [], oldError = console.error, oldWarn = console.warn, oldLog = console.log;
  try {
    console.error = console.warn = console.log = (...args) => logged.push(args);
    const failure = fixture({ providerStatus: 403, body: { code: 'PRIVATE TOKEN', message: 'PRIVATE CUSTOMER' } });
    assert.equal((await failure.run()).payload.reason, 'provider_access_denied'); failure.unchanged();
  } finally { console.error = oldError; console.warn = oldWarn; console.log = oldLog; }
  assert.deepEqual(logged, []);
  let errorBodyRead = false;
  const denied = fixture({ providerResponse: () => {
    const response = new Response('PRIVATE ERROR BODY', { status: 403 });
    response.clone = () => { errorBodyRead = true; throw Error('Error body must not be read'); };
    return response;
  } });
  assert.equal((await denied.run()).payload.reason, 'provider_access_denied');
  assert.equal(errorBodyRead, false); denied.unchanged();
  const stalled = fixture({ timeoutMs: 25, providerResponse: signal => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"code":0,"invoice":'));
      signal.addEventListener('abort', () => controller.error(Error('Fixture aborted')), { once: true });
    }
  })) });
  assert.equal((await stalled.run()).payload.reason, 'timeout'); stalled.unchanged();
});

test('organization replacement during token refresh fails CAS without provider read or connection rebinding', async () => {
  const f = fixture({ expired: true, onCall: ({ call, connection }) => {
    if (call.url.pathname === '/oauth/v2/token') { connection.revision++; connection.provider_account_id = '111111'; }
  } });
  assert.equal((await f.run()).payload.reason, 'connection_changed');
  assert.equal(f.providerCalls().length, 0); assert.equal(f.connection.provider_account_id, '111111'); f.unchanged();
});

test('verified money respects currency scale and does not infer payments from credits or write-offs', async () => {
  for (const [currency, total, balance, paid, expected] of [['JPY', 125, 100, 25, [125, 100, 25]],
    ['KWD', '1.125', '1.100', '0.025', [1125, 1100, 25]], ['INR', '125.00', '100.00', '20.00', [12500, 10000, 2000]]]) {
    const body = remote(); Object.assign(body.invoice, { currency_code: currency, total, balance, payment_made: paid });
    const f = fixture({ body }), res = await f.run();
    assert.equal(res.payload.existence, 'present');
    assert.deepEqual([res.payload.totalMinor, res.payload.balanceMinor, res.payload.paidMinor], expected); f.unchanged();
  }
});

test('organization selection advances revision with CAS, detecting away-and-back races without schema changes', async () => {
  const identity = { userId, workspaceId, provider: 'zoho_books' }, row = { owner_id: userId, workspace_id: workspaceId,
    provider: 'zoho_books', provider_account_id: '987654321', revision: 1 };
  const calls = [];
  const store = new SupabaseAccountingStore({ url: 'https://db.example.test', serviceRoleKey: 'fixture', fetchImpl: async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    if (init.method === 'PATCH') {
      assert.equal(url.searchParams.get('revision'), `eq.${row.revision}`);
      Object.assign(row, JSON.parse(init.body));
    }
    return Response.json([row]);
  } });
  await store.setOrganization(identity, { id: '111111' });
  await store.setOrganization(identity, { id: '987654321' });
  assert.equal(row.revision, 3); assert.equal(calls.length, 4);
  const memory = new InMemoryAccountingStore(); await memory.insertConnection({ ...identity, providerAccountId: '987654321' });
  await memory.setOrganization(identity, { id: '111111' }); await memory.setOrganization(identity, { id: '987654321' });
  assert.equal((await memory.getConnection(identity)).revision, 3);
  const conflict = new SupabaseAccountingStore({ url: 'https://db.example.test', serviceRoleKey: 'fixture', fetchImpl: async (_url, init) =>
    Response.json(init.method === 'PATCH' ? [] : [row]) });
  await assert.rejects(conflict.setOrganization(identity, { id: '111111' }), { code: 'ACCOUNTING_CONNECTION_CONFLICT' });
});

test('diagnostic has no assistant/runtime/action dispatcher or reminder evidence dependency', async () => {
  const source = await readFile(new URL('../automation/accounting-invoice-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:runtime|assistant|reminder|accounting-routes|conversation|queue)/);
  const api = await readFile(new URL('../api/accounting-invoice-diagnostic.js', import.meta.url), 'utf8');
  assert.match(api, /handleInvoiceDiagnostic/); assert.doesNotMatch(api, /handleAccountingRequest/);
});

test('actual current-account diagnostic output cannot grant existing SQL reminder authority', async () => {
  const { createOfflineSqlNetwork } = await import('./fixtures/offline-sql-network.mjs');
  const fresh = '20261024094013_fresh_external_reminder_reads.sql';
  const overdue = '20261024124500_unlinked_overdue_reminder_eligibility.sql';
  const f = await createOfflineSqlNetwork({ excludeMigrations: [fresh, overdue] });
  try {
    const { db } = f;
    for (const file of ['20261018060000_customer_reminder_tone.sql', '20261005070000_approved_whatsapp_reminders.sql', fresh, overdue])
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    await db.query('insert into auth.users(id) values($1)', [userId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${userId}'`);
    const ws = (await db.query("select (public.create_workspace('Diagnostic authority fixture',$1)).id", [otherId])).rows[0].id;
    await db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    const customer = (await db.query("insert into customers(workspace_id,name) values($1,'Offline client') returning id", [ws])).rows[0].id;
    const row = (await db.query(`insert into invoices(id,workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,external_provider,external_invoice_id,metadata)
      values($1,$2,$3,'DIAGNOSTIC','2026-10-01','2026-10-20','INR',125,'sent','zoho_books','123456789','{"invoice_direction":"receivable","accounting_provider":"zoho_books","bookkeeping_record_id":"123456789"}') returning *`,
    [invoiceId, ws, customer])).rows[0];
    const diag = fixture(); const output = (await diag.run()).payload; diag.unchanged();
    // Even align the workspace selector with this SQL fixture: the diagnostic
    // still lacks private evidence/approval and must not authorize anything.
    output.workspaceId = ws;
    const check = await db.query('select public.cetld_core_check_local_reminder_payment_with_external_read($1,$2,$3,$4::jsonb) result',
      [userId, ws, invoiceId, JSON.stringify(output)]);
    assert.deepEqual(check.rows[0].result, { ok: false, reason: 'external_accounting_required' });
    assert.deepEqual((await db.query('select * from invoices where id=$1', [invoiceId])).rows[0], row);
    assert.equal((await db.query('select count(*)::int n from payments where invoice_id=$1', [invoiceId])).rows[0].n, 0);
  } finally { await f.close(); }
});
