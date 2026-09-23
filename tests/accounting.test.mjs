import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenCipher, connectionAad, InMemoryAccountingStore, createAccountingIntegration, createZohoBooksProvider, createQuickBooksProvider, AccountingProviderError } from '../automation/accounting/index.mjs';

const key = Buffer.alloc(32, 7);
const identity = { userId: 'user-1', workspaceId: 'workspace-1' };

function fakeProvider(overrides = {}) {
  return {
    authorizationUrl: ({ state }) => `https://provider.test/authorize?state=${state}`,
    exchangeCode: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3600000, providerAccountId: 'account-1' }),
    refreshToken: async () => ({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: Date.now() + 3600000 }),
    fetchInvoices: async () => [],
    fetchPayments: async () => [],
    fetchInvoiceBalance: async () => ({ externalId: 'invoice-1', balanceMinor: 10, totalMinor: 100, currency: 'USD' }),
    ...overrides,
  };
}

test('TokenCipher authenticates provider/workspace AAD and never stores plaintext', () => {
  const cipher = new TokenCipher(key);
  const envelope = cipher.encrypt({ accessToken: 'secret', refreshToken: 'refresh' }, connectionAad('quickbooks', 'workspace-1'));
  assert.equal(envelope.ciphertext.includes('secret'), false);
  assert.deepEqual(cipher.decrypt(envelope, connectionAad('quickbooks', 'workspace-1')), { accessToken: 'secret', refreshToken: 'refresh' });
  assert.throws(() => cipher.decrypt(envelope, connectionAad('quickbooks', 'other-workspace')), /could not be decrypted/);
});

test('OAuth state is browser-bound, workspace-bound, and single-use', async () => {
  const store = new InMemoryAccountingStore();
  const integration = createAccountingIntegration({ store, cipher: new TokenCipher(key), providers: { zoho_books: fakeProvider(), quickbooks: fakeProvider() } });
  const start = await integration.startOAuth({ ...identity, provider: 'quickbooks', redirectUri: 'https://app.test/cb', browserSession: 'browser-session' });
  const result = await integration.callback({ provider: 'quickbooks', state: start.state, code: 'code', redirectUri: 'https://app.test/cb', browserSession: 'browser-session', realmId: 'realm-1' });
  assert.equal(result.workspaceId, identity.workspaceId);
  await assert.rejects(() => integration.callback({ provider: 'quickbooks', state: start.state, code: 'code', redirectUri: 'https://app.test/cb', browserSession: 'browser-session' }), /invalid or expired/);
});

test('refresh rotation is atomic under concurrent callers', async () => {
  let refreshCalls = 0;
  const store = new InMemoryAccountingStore();
  const provider = fakeProvider({
    refreshToken: async () => { refreshCalls++; await new Promise((r) => setTimeout(r, 10)); return { accessToken: `rotated-${refreshCalls}`, refreshToken: `rotated-refresh-${refreshCalls}`, expiresAt: Date.now() + 3600000 }; },
  });
  const integration = createAccountingIntegration({ store, cipher: new TokenCipher(key), providers: { zoho_books: provider, quickbooks: provider } });
  const start = await integration.startOAuth({ ...identity, provider: 'quickbooks', redirectUri: 'https://app.test/cb', browserSession: 'browser-session' });
  await integration.callback({ provider: 'quickbooks', state: start.state, code: 'code', redirectUri: 'https://app.test/cb', browserSession: 'browser-session', realmId: 'realm-1' });
  const row = store.connections.get('quickbooks:user-1:workspace-1');
  const original = new TokenCipher(key).decrypt(row, connectionAad('quickbooks', identity.workspaceId));
  original.expiresAt = Date.now() - 1;
  Object.assign(row, new TokenCipher(key).encrypt(original, connectionAad('quickbooks', identity.workspaceId)), { tokenExpiresAt: Date.now() - 1 });
  const values = await Promise.all([integration.getAccessToken({ ...identity, provider: 'quickbooks' }), integration.getAccessToken({ ...identity, provider: 'quickbooks' })]);
  assert.equal(refreshCalls, 1);
  assert.equal(values[0].token.refreshToken, values[1].token.refreshToken);
});

test('provider adapters use documented endpoints and normalize records', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('accounts.zoho.com')) return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, api_domain: 'https://evil.example' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ invoices: [{ invoice_id: '1', total: 10, balance: 4, currency_code: 'USD' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const zoho = createZohoBooksProvider({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://app.test/cb', fetchImpl });
  const token = await zoho.exchangeCode({ code: 'one' });
  assert.equal(token.apiDomain, 'https://www.zohoapis.com');
  assert.equal(new URL(calls[0].url).search, '');
  const invoices = await zoho.fetchInvoices({ token: { ...token, accessToken: 'a' }, accountId: 'org-1' });
  assert.equal(invoices[0].balanceMinor, 400);
  assert.match(calls[1].url, /organization_id=org-1/);
});

test('provider errors are redacted', async () => {
  const qbo = createQuickBooksProvider({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://app.test/cb', fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant', refresh_token: 'do-not-leak' }), { status: 401 }) });
  await assert.rejects(() => qbo.refreshToken({ refreshToken: 'refresh-secret' }), (error) => {
    assert.ok(error instanceof AccountingProviderError);
    assert.equal(error.message.includes('refresh-secret'), false);
    assert.equal(error.message.includes('do-not-leak'), false);
    return true;
  });
});


test('mismatched browser and expired state cannot exchange credentials',async()=>{
  let exchanged=0;let now=Date.now();const store=new InMemoryAccountingStore({now:()=>now});
  const provider=fakeProvider({exchangeCode:async()=>{exchanged++;throw Error('must not exchange');}});
  const integration=createAccountingIntegration({store,cipher:new TokenCipher(key),providers:{zoho_books:provider,quickbooks:provider},now:()=>now});
  const start=await integration.startOAuth({...identity,provider:'quickbooks',redirectUri:'https://app.test/cb',browserSession:'good'});
  await assert.rejects(integration.callback({provider:'quickbooks',code:'code',state:start.state,browserSession:'wrong'}));
  const expired=await integration.startOAuth({...identity,provider:'quickbooks',redirectUri:'https://app.test/cb',browserSession:'good'});now+=600001;
  await assert.rejects(integration.callback({provider:'quickbooks',code:'code',state:expired.state,browserSession:'good'}));assert.equal(exchanged,0);
});
test('missing balance is rejected rather than treated as paid',async()=>{
  const provider=createZohoBooksProvider({fetchImpl:async()=>new Response(JSON.stringify({invoice:{invoice_id:'1',total:10,balance:null,currency_code:'INR'}}))});
  await assert.rejects(provider.fetchInvoiceBalance({token:{accessToken:'test',region:'in'},accountId:'org',invoiceId:'1'}),/invalid invoice balance/);
});
test('Zoho organization survives consent and re-consent safely replaces tokens',async()=>{
  const store=new InMemoryAccountingStore();const integration=createAccountingIntegration({store,cipher:new TokenCipher(key),providers:{zoho_books:fakeProvider({exchangeCode:async()=>({accessToken:'a',refreshToken:'r',expiresAt:Date.now()+3600000})}),quickbooks:fakeProvider()}});
  for(let i=0;i<2;i++){const start=await integration.startOAuth({...identity,provider:'zoho_books',organizationId:'org-1',redirectUri:'https://app.test/cb',browserSession:'browser'});await integration.callback({provider:'zoho_books',state:start.state,code:'code',browserSession:'browser'});}
  const row=await store.getConnection({...identity,provider:'zoho_books'});assert.equal(row.providerAccountId,'org-1');assert.equal(row.revision,2);
});
test('saved invoice sync uses the connected provider and preserves provider deduplication',async()=>{
  const store=new InMemoryAccountingStore();let passed;
  const provider=fakeProvider({createInvoice:async input=>{passed=input;return{externalId:'external-1048',duplicate:true}}});
  const integration=createAccountingIntegration({store,cipher:new TokenCipher(key),providers:{zoho_books:provider,quickbooks:provider}});
  const start=await integration.startOAuth({...identity,provider:'quickbooks',redirectUri:'https://app.test/cb',browserSession:'browser'});
  await integration.callback({provider:'quickbooks',state:start.state,code:'code',browserSession:'browser',realmId:'realm-1'});
  const result=await integration.syncInvoice({...identity,invoiceId:'local-1048',invoice:{invoiceNumber:'INV-1048',clientName:'Arbor & Finch',invoiceDate:'2026-09-01',dueDate:'2026-10-01',total:118,currency:'INR'}});
  assert.deepEqual(result,{provider:'quickbooks',externalId:'external-1048',duplicate:true});
  assert.equal(passed.accountId,'account-1');assert.equal(passed.invoice.localInvoiceId,'local-1048');
});
