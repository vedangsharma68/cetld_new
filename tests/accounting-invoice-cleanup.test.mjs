import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import accountingHandler from '../api/accounting.js';
import { INVOICE_CLEANUP_ACTION, INVOICE_CLEANUP_TIMEOUT_MS } from '../automation/accounting-invoice-cleanup.mjs';
import { TokenCipher, connectionAad } from '../automation/accounting/crypto.mjs';
import { createAccountingProviders } from '../automation/accounting/providers.mjs';
import { AccountingProviderError } from '../automation/accounting/errors.mjs';
import { isInvoiceCleanupRequest, handleInvoiceCleanup } from '../automation/accounting-invoice-cleanup.mjs';

const workspaceId = '10000000-0000-0000-0000-000000000001';
const userId = '10000000-0000-0000-0000-000000000002';
const invoiceId = '27e4bc93-fa0c-42ff-8813-bc371a623fb0';
const otherId = '10000000-0000-0000-0000-000000000004';
const key = Buffer.alloc(32, 19);
const remote = () => ({ code: 0, invoice: { invoice_id: '4264719000000068001', organization_id: '987654321',
  currency_code: 'INR', total: 125, balance: 125, payment_made: 0, status: 'draft',
  customer_name: 'PRIVATE CUSTOMER', email: 'private@example.test', access_token: 'PRIVATE PROVIDER TOKEN' } });

const secondInvoiceId = '5076cb85-c892-44d6-aea9-9b7af8e95d38';
const secondExternalId = '4264719000000044008';

function fixture(options = {}) {
  const localId = options.localId || invoiceId, externalId = options.externalId || '4264719000000068001';
  let deletedRemotely = false, providerReads = 0;
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
  const invoice = { id: localId, workspace_id: workspaceId, external_provider: 'zoho_books', external_invoice_id: externalId,
    updated_at: '2026-10-20T00:00:00Z', deleted_at: options.deleted ? '2026-10-21T00:00:00Z' : null,
    accounting_provider: 'zoho_books', bookkeeping_provider: 'zoho_books', bookkeeping_record_id: externalId,
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
      assert.equal(url.searchParams.get('id'), `eq.${localId}`);
      assert.equal(url.searchParams.get('limit'), '1');
      assert.equal(url.searchParams.has('deleted_at'), false, 'soft-deleted rows are read without restoration');
      assert.equal(url.searchParams.get('select'), 'id,workspace_id,external_provider,external_invoice_id,updated_at,deleted_at,accounting_provider:metadata->>accounting_provider,bookkeeping_provider:metadata->>bookkeeping_provider,bookkeeping_record_id:metadata->>bookkeeping_record_id');
      return json(options.missingInvoice ? [] : [structuredClone(invoice)]);
    }
    if (url.origin === env.SUPABASE_URL && url.pathname === '/rest/v1/cetld_accounting_connections' && method === 'GET') {
      connectionReads++;
      assert.equal(url.searchParams.get('owner_id'), `eq.${userId}`);
      assert.equal(url.searchParams.get('workspace_id'), `eq.${workspaceId}`);
      assert.equal(url.searchParams.get('provider'), 'eq.zoho_books');
      await options.onConnectionRead?.({ connection, count: connectionReads });
      return json(options.disconnected ? [] : [structuredClone(connection)]);
    }
    if (url.origin === 'https://www.zohoapis.in' && url.pathname === `/books/v3/invoices/${externalId}` && method === 'GET') {
      assert.deepEqual([...url.searchParams], [['organization_id', '987654321']]);
      assert.equal(init.redirect, 'error');
      providerReads++;
      if (deletedRemotely) {
        await options.onPostRead?.({ invoice, connection });
        if (options.postResponse) return options.postResponse(init.signal);
        return json(options.postBody || remote(), options.postStatus || 404);
      }
      if (options.providerFailure) throw Error('PRIVATE NETWORK ERROR');
      await options.onProvider?.({ invoice, connection, setOwner: value => { owner = value; } });
      if (options.providerResponse) return options.providerResponse(init.signal);
      const body = options.body || remote();
      if (!options.body) body.invoice.invoice_id = externalId;
      return options.invalidJson ? new Response('PRIVATE INVALID JSON') : json(body, options.providerStatus || 200);
    }
    if (url.origin === 'https://www.zohoapis.in' && url.pathname === `/books/v3/invoices/${externalId}` && method === 'DELETE') {
      assert.deepEqual([...url.searchParams], [['organization_id', '987654321']]);
      assert.equal(init.headers.Authorization, 'Zoho-oauthtoken PRIVATE ACCESS TOKEN');
      assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
      await options.onDelete?.({ invoice, connection, setOwner: value => { owner = value; } });
      if (options.deleteFailure) throw Error('PRIVATE NETWORK ERROR');
      if (options.deleteResponse) return options.deleteResponse(init.signal);
      const body = options.deleteBody || { code: 0, message: 'PRIVATE DELETE RESPONSE' };
      if (body.code === 0 && !options.deleteStatus) deletedRemotely = true;
      return json(body, options.deleteStatus || 200);
    }
    forbidden.push(`${method} ${url.origin}${url.pathname}`);
    throw Error('Forbidden effect or enumeration attempted');
  };
  const run = async (overrides = {}) => {
    const response = { headers: {}, statusCode: null, payload: null,
      setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; } };
    let dispatcherAccesses = 0;
    await accountingHandler({ method: 'POST', url: '/api/accounting',
      headers: { authorization: 'Bearer fixture-user' }, body: { action: INVOICE_CLEANUP_ACTION, workspaceId, invoiceId: localId }, ...overrides }, response,
    { env, fetchImpl, timeoutMs: options.timeoutMs, integration: new Proxy({}, { get() {
      dispatcherAccesses++; throw Error('Normal accounting dispatcher must not be reached');
    } }) });
    assert.equal(dispatcherAccesses, 0, 'cleanup cannot reach normal mutation/callback dispatch');
    assert.deepEqual(forbidden, [], 'no other provider/service/action can be reached');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    const serialized = JSON.stringify(response.payload);
    for (const secret of ['PRIVATE', 'customer_name', 'email', 'access_token', 'ciphertext', 'refresh_token'])
      assert.equal(serialized.includes(secret), false, `response must redact ${secret}`);
    return response;
  };
  const unchanged = () => {
    assert.deepEqual(protectedState, before, 'no invoice/customer/payment/snapshot/conversation/review/reminder/queue/send/OAuth effects');
    if (!options.onProvider && !options.onCall && !options.onConnectionRead && !options.onDelete && !options.onPostRead)
      assert.deepEqual(connection, initialConnection, 'connection is not rebound or modified');
  };
  return { run, unchanged, calls, invoice, connection, counts: () => ({ connectionReads, authReads, workspaceReads }),
    deletes: () => calls.filter(c => c.method === 'DELETE'), reads: () => providerReads,
    providerCalls: () => calls.filter(c => c.url.origin.includes('zohoapis')) };
}

test('only both allowlisted pairs can delete; active and soft-deleted local rows remain unchanged; repeat is absent', async () => {
  for (const options of [{}, { localId: secondInvoiceId, externalId: secondExternalId, deleted: true }]) {
    const f = fixture(options), res = await f.run();
    assert.equal(res.statusCode, 200);
    const { checkedAt, ...facts } = res.payload;
    assert.ok(Number.isFinite(Date.parse(checkedAt)));
    assert.deepEqual(facts, { workspaceId, invoiceId: options.localId || invoiceId, provenance: 'provenance_unverified',
      outcome: 'deleted', provider: 'zoho_books', currentAccountId: '987654321', exactId: options.externalId || '4264719000000068001',
      verification: 'absent_confirmed' });
    assert.equal(f.deletes().length, 1); assert.equal(f.reads(), 2);
    assert.equal(f.counts().authReads, 4); f.unchanged();
    assert.equal((await f.run()).payload.outcome, 'already_absent');
    assert.equal(f.deletes().length, 1); f.unchanged();
  }
});

test('non-allowlisted IDs, mismatched pairs/providers and contradictory linkage never reach any provider', async () => {
  for (const options of [{ localId: otherId }, { localId: otherId, deleted: true },
    { invoice: { external_invoice_id: secondExternalId } }, { invoice: { external_invoice_id: 4264719000000068001 } },
    { invoice: { external_provider: 'quickbooks' } }, { invoice: { external_provider: 'tally' } },
    { invoice: { external_provider: null } }, { invoice: { external_invoice_id: '../../contacts' } },
    { invoice: { accounting_provider: 'quickbooks' } }, { invoice: { bookkeeping_provider: 'tally' } },
    { invoice: { bookkeeping_record_id: 'different' } }]) {
    const f = fixture(options), res = await f.run();
    assert.equal(res.payload.outcome, 'unverifiable'); assert.equal(f.providerCalls().length, 0);
    assert.equal(f.calls.some(c => c.url.hostname.startsWith('accounts.zoho')), false); f.unchanged();
  }
});

test('non-drafts and drafts with reduced balance are skipped without DELETE', async () => {
  for (const patch of [{ status: 'sent' }, { status: 'paid', balance: 0, payment_made: 125 },
    { status: 'partially_paid', balance: 100, payment_made: 25 }, { status: 'void' },
    { balance: 100, payment_made: 25 }, { balance: 100, payment_made: null }]) {
    const body = remote(); Object.assign(body.invoice, patch);
    const f = fixture({ body }), res = await f.run();
    assert.equal(res.payload.outcome, 'skipped');
    assert.equal(res.payload.reason, patch.status ? 'not_draft' : 'paid_or_partially_paid');
    assert.equal(f.deletes().length, 0); assert.equal(f.reads(), 1); f.unchanged();
  }
  const body = remote(); delete body.invoice.payment_made;
  const f = fixture({ body }); assert.equal((await f.run()).payload.outcome, 'deleted'); f.unchanged();
});

test('404 pre-read is already absent; all other failed or unsafe reads fail closed without DELETE', async () => {
  for (const [options, outcome, reason] of [[{ providerStatus: 404 }, 'already_absent', undefined],
    [{ providerStatus: 401 }, 'unverifiable', 'provider_authentication_failed'],
    [{ providerStatus: 403 }, 'unverifiable', 'provider_access_denied'],
    [{ providerStatus: 429 }, 'unverifiable', 'provider_throttled'],
    [{ providerStatus: 500 }, 'unverifiable', 'provider_read_unverifiable'],
    [{ providerFailure: true }, 'unverifiable', 'provider_read_unverifiable'],
    [{ invalidJson: true }, 'unverifiable', 'provider_read_unverifiable']]) {
    const f = fixture(options), res = await f.run();
    assert.equal(res.payload.outcome, outcome); assert.equal(res.payload.reason, reason);
    assert.equal(f.deletes().length, 0); assert.equal(f.providerCalls().length, 1); f.unchanged();
  }
  for (const patch of [{ invoice_id: secondExternalId }, { organization_id: '111' }, { currency_code: 'XYZ' },
    { status: 'unknown' }, { total: -1 }, { balance: 126 }, { payment_made: 25 }, { total: 'Infinity' }, { total: '1.0001' }]) {
    const body = remote(); Object.assign(body.invoice, patch);
    const f = fixture({ body }); assert.equal((await f.run()).payload.outcome, 'unverifiable');
    assert.equal(f.deletes().length, 0); f.unchanged();
  }
});

test('DELETE must confirm code zero, is never retried, and post-read only proves absence on HTTP 404', async () => {
  for (const options of [{ deleteBody: { code: 1002 } }, { deleteBody: { code: '0' } }, { deleteBody: {} },
    { deleteStatus: 404 }, { deleteStatus: 403 }, { deleteStatus: 500 }, { deleteFailure: true },
    { deleteResponse: () => new Response('PRIVATE MALFORMED JSON') }]) {
    const f = fixture(options), res = await f.run();
    assert.equal(res.payload.outcome, 'unverifiable'); assert.equal(res.payload.reason, 'provider_delete_unverifiable');
    assert.equal(f.deletes().length, 1); assert.equal(f.reads(), 2);
    assert.equal(res.payload.verification, 'absence_unverifiable'); f.unchanged();
  }
  for (const options of [{}, { postStatus: 200 }, { postStatus: 403 }, { postStatus: 401 }, { postStatus: 429 },
    { postStatus: 500 }, { postResponse: () => new Response('PRIVATE INVALID JSON') },
    { postResponse: () => { throw Error('PRIVATE NETWORK'); } }]) {
    const f = fixture(options), res = await f.run();
    assert.equal(res.payload.outcome, 'deleted');
    assert.equal(res.payload.verification, Object.keys(options).length ? 'absence_unverifiable' : 'absent_confirmed');
    assert.equal(f.deletes().length, 1); assert.equal(f.reads(), 2); f.unchanged();
  }
  const uncertain = { deleteFailure: true };
  uncertain.onDelete = () => { uncertain.providerStatus = 404; };
  const f = fixture(uncertain), res = await f.run();
  assert.equal(res.payload.outcome, 'unverifiable');
  assert.equal(res.payload.reason, 'provider_delete_unverifiable');
  assert.equal(res.payload.verification, 'absent_confirmed');
  assert.equal(f.deletes().length, 1); assert.equal(f.reads(), 2); f.unchanged();
});

test('Zoho-only DELETE adapter requires identities, encodes exact ID, and rejects every unconfirmed body', async () => {
  const calls = [], providers = createAccountingProviders({ zoho_books: { fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init }); return Response.json({ code: 0 });
  } } });
  assert.equal(providers.quickbooks.deleteInvoiceDraft, undefined); assert.equal(providers.tally?.deleteInvoiceDraft, undefined);
  const input = { token: { apiDomain: 'https://www.zohoapis.in', accessToken: 'fixture-token' }, accountId: '987654321', invoiceId: 'a/b?#', signal: new AbortController().signal };
  for (const field of ['accountId', 'invoiceId']) await assert.rejects(providers.zoho_books.deleteInvoiceDraft({ ...input, [field]: '' }), AccountingProviderError);
  assert.equal(calls.length, 0);
  await providers.zoho_books.deleteInvoiceDraft(input);
  assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].url.href, 'https://www.zohoapis.in/books/v3/invoices/a%2Fb%3F%23?organization_id=987654321');
  assert.equal(calls[0].init.headers.Authorization, 'Zoho-oauthtoken fixture-token');
  for (const body of [{ code: 1 }, { code: '0' }, {}, null]) {
    const adapter = createAccountingProviders({ zoho_books: { fetchImpl: async () => Response.json(body) } }).zoho_books;
    await assert.rejects(adapter.deleteInvoiceDraft(input), AccountingProviderError);
  }
});

test('owner, workspace, saved row and regional connection checks precede all provider access', async () => {
  for (const [options, status] of [[{ authStatus: 401 }, 401], [{ missingInvoice: true }, 404],
    [{ invoice: { workspace_id: otherId } }, 404], [{ invoice: { id: otherId } }, 404],
    [{ onCall: ({ call, setOwner }) => { if (call.url.pathname === '/rest/v1/workspaces') setOwner(otherId); } }, 403]]) {
    const f = fixture(options); assert.equal((await f.run()).statusCode, status); assert.equal(f.providerCalls().length, 0); f.unchanged();
  }
  const missing = fixture(); assert.equal((await missing.run({ headers: {} })).statusCode, 401); missing.unchanged();
  for (const options of [{ disconnected: true }, { connection: { status: 'disconnected' } },
    { connection: { owner_id: otherId } }, { connection: { workspace_id: otherId } }, { connection: { provider: 'quickbooks' } },
    { connection: { provider_account_id: '../other' } }, { connection: { region: 'evil.test' } },
    { connection: { api_domain: 'https://attacker.test' } }, { connection: { accounts_domain: 'https://attacker.test' } },
    { token: { providerAccountId: '11111' } }, { token: { region: 'eu' }, connection: { region: 'in' } }]) {
    const f = fixture(options); assert.equal((await f.run()).payload.outcome, 'unverifiable'); assert.equal(f.providerCalls().length, 0); f.unchanged();
  }
});

test('exact envelope, methods and query selectors never fall through to normal dispatch', async () => {
  for (const action of ['sync', 'start', 'select-organization', 'disconnect', 'status', '', null, ['invoice-cleanup'], 'invoice-cleanup-forged']) {
    const f = fixture(); assert.equal((await f.run({ body: { action, workspaceId, invoiceId } })).statusCode, 400);
    assert.equal(f.calls.length, 0); f.unchanged();
  }
  for (const extra of ['provider', 'organizationId', 'externalId', 'currentAccountId', 'userId', 'ownerId', 'keepExistingInvoices', '__proto__']) {
    const body = JSON.parse(JSON.stringify({ action: INVOICE_CLEANUP_ACTION, workspaceId, invoiceId }).slice(0, -1) + `,"${extra}":"forged"}`);
    const f = fixture(); assert.equal((await f.run({ body })).statusCode, 400); assert.equal(f.calls.length, 0); f.unchanged();
  }
  for (const req of [{ method: 'GET' }, { method: 'DELETE' }, { method: 'PATCH' }, { url: '/api/accounting?organizationId=forged' },
    { query: { organizationId: 'forged' } }, { body: { action: INVOICE_CLEANUP_ACTION, workspaceId } },
    { body: { workspaceId, invoiceId: '../arbitrary' } }, { body: { action: INVOICE_CLEANUP_ACTION, workspaceId: otherId, invoiceId: 5 } },
    { body: '{"action":"invoice-cleanup","invoiceId":' }, { body: 'not-json' }, { body: [] },
    { body: { action: INVOICE_CLEANUP_ACTION, workspaceId: [], invoiceId } }, { url: 'http://[', body: { workspaceId, invoiceId } },
    { body: { action: 'sync', provider: 'zoho_books', workspaceId }, url: '/api/accounting?invoiceId=forged' },
    { body: { action: 'sync', provider: 'zoho_books', workspaceId }, query: { action: [INVOICE_CLEANUP_ACTION, 'sync'] } },
    { body: undefined, method: 'GET', url: '/api/accounting?action=invoice-cleanup&provider=zoho_books&code=forged&state=forged' },
    { body: undefined, method: 'GET', url: '/api/accounting?invoiceId=forged&provider=zoho_books&code=forged&state=forged' },
    { body: { action: 'disconnect', provider: 'zoho_books', workspaceId }, url: '/api/accounting?action=invoice-cleanup&action=sync' }]) {
    const f = fixture(), res = await f.run(req); assert.ok([400, 405].includes(res.statusCode));
    assert.equal(f.providerCalls().length, 0); f.unchanged();
  }
  for (const body of ['x'.repeat(32769), { action: INVOICE_CLEANUP_ACTION, workspaceId, invoiceId, extra: 'x'.repeat(32769) }]) {
    const f = fixture(); assert.equal((await f.run({ body })).statusCode, 413); assert.equal(f.calls.length, 0); f.unchanged();
  }
});

test('classifier reserves fixed action or local selector while leaving bodyless ordinary OAuth callbacks alone', () => {
  assert.equal(isInvoiceCleanupRequest({ method: 'GET', url: '/api/accounting?provider=zoho_books&code=fixture&state=fixture' }), false);
  assert.equal(isInvoiceCleanupRequest({ method: 'POST', body: { action: INVOICE_CLEANUP_ACTION } }), true);
  assert.equal(isInvoiceCleanupRequest({ method: 'POST', body: { invoiceId, action: 'disconnect' } }), true);
  assert.equal(isInvoiceCleanupRequest({ method: 'GET', query: { invoiceId } }), true);
});

test('connection and local linkage changes around every remote operation invalidate the result', async () => {
  for (const hook of ['onProvider', 'onDelete', 'onPostRead']) {
    for (const change of [{ provider_account_id: '111111' }, { status: 'disconnected' }, { owner_id: otherId },
      { workspace_id: otherId }, { region: 'eu' }, { token_ciphertext: 'reconsented' }, { revision: 3 }]) {
      const f = fixture({ [hook]: ({ connection }) => Object.assign(connection, change) });
      const res = await f.run(); assert.equal(res.payload.reason, 'connection_changed');
      assert.equal(res.payload.outcome, 'unverifiable'); assert.equal(Object.hasOwn(res.payload, 'exactId'), false);
      assert.equal(f.deletes().length, hook === 'onProvider' ? 0 : 1); f.unchanged();
    }
    for (const change of [{ external_invoice_id: secondExternalId }, { external_provider: 'quickbooks' },
      { deleted_at: '2026-10-25T00:00:00Z' }, { updated_at: 'new-version' }, { bookkeeping_record_id: 'different' }]) {
      const f = fixture({ [hook]: ({ invoice }) => Object.assign(invoice, change) });
      const res = await f.run(); assert.equal(res.payload.reason, 'local_record_changed');
      assert.equal(f.deletes().length, hook === 'onProvider' ? 0 : 1);
      Object.assign(f.invoice, { external_invoice_id: '4264719000000068001', external_provider: 'zoho_books',
        deleted_at: null, updated_at: '2026-10-20T00:00:00Z', bookkeeping_record_id: '4264719000000068001' });
      f.unchanged();
    }
  }
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9]) {
    const f = fixture({ onConnectionRead: ({ connection, count: n }) => { if (n === count) connection.revision += 2; } });
    assert.equal((await f.run()).payload.reason, 'connection_changed'); f.unchanged();
  }
  for (const hook of ['onProvider', 'onDelete']) {
    const f = fixture({ [hook]: ({ setOwner }) => setOwner(otherId) });
    assert.equal((await f.run()).statusCode, 403); assert.equal(f.deletes().length, hook === 'onProvider' ? 0 : 1); f.unchanged();
  }
  const f = fixture({ providerStatus: 404, onProvider: ({ connection }) => { connection.revision += 2; } });
  assert.equal((await f.run()).payload.reason, 'connection_changed'); assert.equal(f.deletes().length, 0); f.unchanged();
});

test('one eight-second deadline spans auth, preparation, DELETE, post-read and body reads; late work stops', async () => {
  assert.equal(INVOICE_CLEANUP_TIMEOUT_MS, 8000);
  for (const target of ['/auth/v1/user', '/rest/v1/cetld_accounting_connections', '/books/v3/invoices/4264719000000068001']) {
    const f = fixture({ timeoutMs: 25, hangAt: url => url.pathname === target });
    const started = Date.now(), res = await f.run();
    assert.equal(res.payload.reason, 'timeout'); assert.equal(res.payload.outcome, 'unverifiable');
    assert.ok(Date.now() - started < 1000);
    const count = f.calls.length; await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(f.calls.length, count); f.unchanged();
  }
  for (const hook of ['onProvider', 'onDelete', 'onPostRead']) {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const f = fixture({ timeoutMs: 25, [hook]: () => hold });
    assert.equal((await f.run()).payload.reason, 'timeout');
    const count = f.calls.length; release(); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.calls.length, count, 'late completion cannot initiate any other request'); f.unchanged();
  }
  // Auth body parsing may ignore abort too; outward deadline and wrapper still hold.
  let release, calls = 0;
  const response = { setHeader() {}, status() { return this; }, json(payload) { this.payload = payload; } };
  await handleInvoiceCleanup({ method: 'POST', url: '/api/accounting', headers: { authorization: 'Bearer fixture-user' },
    body: { action: INVOICE_CLEANUP_ACTION, workspaceId, invoiceId } }, response, { timeoutMs: 25,
    env: { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'public' },
    fetchImpl: async () => { calls++; return { ok: true, json: () => new Promise(resolve => { release = resolve; }) }; } });
  assert.equal(response.payload.reason, 'timeout'); release({ id: userId });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 1);
});

test('read and DELETE success bodies are capped, errors unread, deadlines cover streams, and nothing is logged', async () => {
  const large = remote(); large.invoice.notes = 'PRIVATE'.repeat(50000);
  for (const options of [{ body: large }, { deleteBody: { code: 0, notes: 'PRIVATE'.repeat(50000) } }]) {
    const f = fixture(options); assert.equal((await f.run()).payload.outcome, 'unverifiable'); f.unchanged();
  }
  for (const kind of ['providerResponse', 'deleteResponse', 'postResponse']) {
    let errorBodyRead = false;
    const options = { [kind]: () => {
      const response = new Response('PRIVATE ERROR BODY', { status: 403 });
      response.clone = () => { errorBodyRead = true; throw Error('Never read error bodies'); };
      return response;
    } };
    const f = fixture(options); await f.run(); assert.equal(errorBodyRead, false); f.unchanged();
    const stalled = fixture({ timeoutMs: 25, [kind]: signal => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":0,'));
        signal.addEventListener('abort', () => controller.error(Error('Fixture aborted')), { once: true });
      }
    })) });
    assert.equal((await stalled.run()).payload.reason, 'timeout'); stalled.unchanged();
  }
  const logged = [], oldError = console.error, oldWarn = console.warn, oldLog = console.log;
  try {
    console.error = console.warn = console.log = (...args) => logged.push(args);
    const f = fixture({ deleteBody: { code: 'PRIVATE TOKEN', message: 'PRIVATE CUSTOMER' } });
    assert.equal((await f.run()).payload.reason, 'provider_delete_unverifiable'); f.unchanged();
  } finally { console.error = oldError; console.warn = oldWarn; console.log = oldLog; }
  assert.deepEqual(logged, []);
});

test('cleanup performs no local writes or other actions and has no assistant/runtime/dispatcher imports', async () => {
  const f = fixture(); await f.run(); f.unchanged();
  assert.deepEqual(f.calls.filter(c => c.url.origin === 'https://db.example.test' && c.method !== 'GET'), []);
  const source = await readFile(new URL('../automation/accounting-invoice-cleanup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:runtime|assistant|reminder|accounting-routes|conversation|queue)/);
  const api = await readFile(new URL('../api/accounting.js', import.meta.url), 'utf8');
  assert.ok(api.indexOf('return handleInvoiceCleanup') < api.indexOf("await import('../automation/accounting-routes.mjs')"));
  await assert.rejects(access(new URL('../api/accounting-invoice-cleanup.js', import.meta.url)), { code: 'ENOENT' });
  assert.equal(isInvoiceCleanupRequest({ method: 'POST', body: '{"action":"invoice-cleanup","invoiceId":' }), true);
});

test('expired credentials fail closed before refresh lease/token writes or any provider request', async () => {
  const f = fixture({ expired: true }), res = await f.run();
  assert.equal(res.payload.outcome, 'unverifiable'); assert.equal(res.payload.reason, 'token_refresh_required');
  assert.equal(f.connection.revision, 1); assert.equal(f.providerCalls().length, 0);
  assert.deepEqual(f.calls.filter(c => c.method !== 'GET'), []); f.unchanged();
});

test('actual cleanup output cannot grant existing SQL reminder authority', async () => {
  const { createOfflineSqlNetwork } = await import('./fixtures/offline-sql-network.mjs');
  const fresh = '20261024094013_fresh_external_reminder_reads.sql';
  const overdue = '20261024124500_unlinked_overdue_reminder_eligibility.sql';
  const containment = '20261026090000_contain_unproven_external_reminders.sql';
  const f = await createOfflineSqlNetwork({ excludeMigrations: [fresh, overdue, containment] });
  try {
    const { db } = f;
    for (const file of ['20261018060000_customer_reminder_tone.sql', '20261005070000_approved_whatsapp_reminders.sql', fresh, overdue, containment])
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    await db.query('insert into auth.users(id) values($1)', [userId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${userId}'`);
    const ws = (await db.query("select (public.create_workspace('Cleanup authority fixture',$1)).id", [otherId])).rows[0].id;
    await db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    const customer = (await db.query("insert into customers(workspace_id,name) values($1,'Offline client') returning id", [ws])).rows[0].id;
    const row = (await db.query(`insert into invoices(id,workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,external_provider,external_invoice_id,metadata)
      values($1,$2,$3,'CLEANUP','2026-10-01','2026-10-20','INR',125,'sent','zoho_books','4264719000000068001','{"invoice_direction":"receivable","accounting_provider":"zoho_books","bookkeeping_record_id":"4264719000000068001"}') returning *`,
    [invoiceId, ws, customer])).rows[0];
    const cleanup = fixture(); const output = (await cleanup.run()).payload; cleanup.unchanged();
    assert.equal(output.outcome, 'deleted');
    // Even align the workspace selector with this SQL fixture: cleanup
    // still lacks private evidence/approval and must not authorize anything.
    output.workspaceId = ws;
    const check = await db.query('select public.cetld_core_check_local_reminder_payment_with_external_read($1,$2,$3,$4::jsonb) result',
      [userId, ws, invoiceId, JSON.stringify(output)]);
    assert.deepEqual(check.rows[0].result, { ok: false, reason: 'external_accounting_required' });
    assert.deepEqual((await db.query('select * from invoices where id=$1', [invoiceId])).rows[0], row);
    assert.equal((await db.query('select count(*)::int n from payments where invoice_id=$1', [invoiceId])).rows[0].n, 0);
  } finally { await f.close(); }
});
