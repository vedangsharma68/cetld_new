import test from 'node:test';
import assert from 'node:assert/strict';
import {createZohoBooksProvider} from '../automation/accounting/providers.mjs';
import {SupabaseAccountingStore} from '../automation/accounting/store.mjs';
import {createAccountingIntegration} from '../automation/accounting/integration.mjs';
import {TokenCipher, connectionAad} from '../automation/accounting/crypto.mjs';
import {normalizeZohoPhone, zohoCustomerPhone} from '../automation/accounting/zoho-phone.mjs';

const phone = '+919871367051';
const identity = {userId: 'owner-fixture', workspaceId: 'workspace-fixture', provider: 'zoho_books'};
const json = body => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});

test('Zoho phones normalize Indian national, trunk, country-code and international formats', () => {
  for (const input of ['9871367051', '98713 67051', '09871367051', '91-98713-67051',
    '+91 (98713) 67051', '0091 98713 67051', phone]) assert.equal(normalizeZohoPhone(input), phone, input);
  assert.equal(normalizeZohoPhone('011 2345 6789'), '+911123456789');
  assert.equal(normalizeZohoPhone('+1 (202) 555-0100'), '+12025550100');
  assert.equal(normalizeZohoPhone('001 202 555 0100'), '+12025550100');
  for (const input of [null, undefined, '', '  ', 9871367051, {}, 'No phone provided', '12345',
    '+91 123', '+91 09871367051', '+91 987136705123', '0000000000', '+0123456789',
    '9871367051 ext 2', '9871367051/9871367051', '+919871367051,+919871367051', '++919871367051',
    '+1234567890123456']) assert.equal(normalizeZohoPhone(input), null, String(input));
});

test('Zoho phone selection prefers contact mobile, then primary person, then phone and other people', () => {
  const secondary = {mobile: '+919000000001'};
  const primary = {is_primary_contact: true, mobile: '9871367051'};
  assert.equal(zohoCustomerPhone({mobile: phone, phone: secondary.mobile}), phone);
  assert.equal(zohoCustomerPhone({phone: secondary.mobile, contact_persons: [secondary, primary]}), phone);
  assert.equal(zohoCustomerPhone({contact_persons: [secondary, {...primary, mobile: '', phone}]}), phone);
  assert.equal(zohoCustomerPhone({mobile: 'invalid', phone: '09871367051'}), phone);
  assert.equal(zohoCustomerPhone({contact_persons: [{mobile: 'invalid', phone}]}), phone);
  assert.equal(zohoCustomerPhone({contact_persons: ['9871367051']}), null);
  assert.equal(zohoCustomerPhone({contact_persons: [null], contact_persons_details: [{mobile: phone}]}), phone);
  assert.equal(zohoCustomerPhone({contact_persons: {}, phone: 'short'}), null);
});

function providerFixture() {
  const calls = [];
  const state = {contacts: [{contact_id: 'zoho-customer', contact_name: 'Fixture customer', mobile: '98713 67051'}], invoices: []};
  const adapter = createZohoBooksProvider({fetchImpl: async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({url, method: init.method || 'GET'});
    assert.equal(init.method || 'GET', 'GET');
    if (url.pathname === '/books/v3/contacts') return json({contacts: state.contacts, page_context: {has_more_page: false}});
    if (url.pathname === '/books/v3/invoices') return json({invoices: state.invoices, page_context: {has_more_page: false}});
    if (url.pathname === '/books/v3/customerpayments') return json({customerpayments: []});
    if (url.pathname === '/books/v3/invoices/zoho-invoice') return json({invoice: state.invoices[0]});
    throw Error('Unexpected provider request');
  }});
  return {adapter, state, calls};
}
const providerInput = {token: {accessToken: 'fixture', apiDomain: 'https://www.zohoapis.in'}, accountId: 'fixture-org'};
const invoiceRaw = extra => ({invoice_id: 'zoho-invoice', invoice_number: 'FIXTURE-1', customer_id: 'zoho-customer',
  customer_name: 'Fixture customer', total: 10, balance: 10, currency_code: 'INR', date: '2026-10-18', ...extra});

test('Zoho contact and invoice adapters normalize mobiles/people without altering raw payloads or pagination', async () => {
  const f = providerFixture();
  f.state.contacts.push({contact_id: 'person-customer', contact_name: 'Person fixture',
    contact_persons: [{is_primary_contact: true, mobile: '09871367051'}]});
  f.state.invoices = [invoiceRaw({contact_persons: ['person-id'], contact_persons_details: [{mobile: '98713 67051'}]})];
  const contacts = await f.adapter.fetchContacts(providerInput);
  assert.deepEqual(contacts.map(contact => contact.phone), [phone, phone]);
  assert.equal(contacts[0].raw.mobile, '98713 67051');
  assert.equal(contacts.nextPage, null);
  const invoices = await f.adapter.fetchInvoices(providerInput);
  assert.equal(invoices[0].customerPhone, phone);
  assert.equal(invoices[0].raw.customer_id, 'zoho-customer');
  const detail = await f.adapter.fetchInvoice({...providerInput, invoiceId: 'zoho-invoice'});
  assert.equal(detail.customerPhone, phone);
  assert.ok(f.calls.every(call => call.url.searchParams.get('organization_id') === 'fixture-org'));
  for (const fields of [{mobile: '9871367051'}, {phone: '09871367051'}, {contact_persons: [{mobile: phone}]}]) {
    f.state.invoices = [invoiceRaw(fields)];
    assert.equal((await f.adapter.fetchInvoices(providerInput))[0].customerPhone, phone);
  }
});

function databaseFixture(initial = []) {
  const customers = structuredClone(initial), calls = [];
  const store = new SupabaseAccountingStore({url: 'https://db.example.test', serviceRoleKey: 'fixture', fetchImpl: async (input, init = {}) => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1), method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({url, table, method, body, headers: init.headers});
    if (table === 'workspaces') return json([{id: identity.workspaceId}]);
    if (table === 'cetld_accounting_sync_records') return json(body);
    if (table === 'customers') {
      if (method === 'GET') return json(customers.filter(row =>
        row.workspace_id === url.searchParams.get('workspace_id')?.slice(3) &&
        (url.searchParams.has('email') ? row.email === url.searchParams.get('email').slice(6) :
          row.external_provider === url.searchParams.get('external_provider')?.slice(3) &&
          row.external_customer_id === url.searchParams.get('external_customer_id')?.slice(3))));
      if (method === 'POST') {
        const values = body[0];
        const existing = customers.find(row => row.workspace_id === values.workspace_id && row.external_provider === values.external_provider && row.external_customer_id === values.external_customer_id);
        if (existing) {Object.assign(existing, values); return json([existing]);}
        const row = {id: `fixture-${customers.length}`, ...values}; customers.push(row); return json([row]);
      }
      if (method === 'PATCH') {
        const row = customers.find(row => row.id === url.searchParams.get('id')?.slice(3));
        assert.ok(row);
        Object.assign(row, body); return json([row]);
      }
    }
    // These tests deliberately omit invoice dates so only customer writes occur.
    throw Error(`Unexpected database request: ${method} ${table}`);
  }});
  return {store, customers, calls};
}
const savedCustomer = extra => ({id: 'local-customer', workspace_id: identity.workspaceId, name: 'Fixture customer',
  external_provider: 'zoho_books', external_customer_id: 'zoho-customer', phone: null, ...extra});

async function syncFixture(db, provider) {
  const cipher = new TokenCipher(Buffer.alloc(32, 7));
  const token = {...providerInput.token, refreshToken: 'fixture', expiresAt: Date.now() + 3600000};
  db.store.getConnection = async () => ({...identity, providerAccountId: providerInput.accountId,
    apiDomain: token.apiDomain, ...cipher.encrypt(token, connectionAad(identity.provider, identity.workspaceId))});
  db.store.markSyncResult = async () => {};
  return createAccountingIntegration({store: db.store, cipher, providers: {zoho_books: provider, quickbooks: {}}}).sync(identity);
}

test('next full sync backfills an existing linked customer and repeats without duplication', async () => {
  const db = databaseFixture([savedCustomer(), savedCustomer({id: 'foreign', workspace_id: 'other-workspace'})]);
  const f = providerFixture();
  for (let i = 0; i < 2; i++) {
    const result = await syncFixture(db, f.adapter);
    assert.equal(result.syncStatus, 'synced');
    assert.equal(result.persisted.customers, 1);
    assert.equal(db.customers[0].phone, phone);
    assert.equal(db.customers[0].id, 'local-customer');
    assert.equal(db.customers.length, 2);
    assert.equal(db.customers[1].phone, null);
  }
  const writes = db.calls.filter(call => call.table === 'customers' && call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].url.searchParams.get('on_conflict'), 'workspace_id,external_provider,external_customer_id');
  assert.match(writes[0].headers.Prefer, /merge-duplicates/);
});

test('sync creates customers with a phone and updates an email-matched existing customer', async () => {
  for (const existing of [[], [savedCustomer({external_provider: null, external_customer_id: null, email: 'owner@example.test'})]]) {
    const db = databaseFixture(existing), f = providerFixture();
    f.state.contacts[0].email = 'owner@example.test';
    await syncFixture(db, f.adapter);
    assert.equal(db.customers.length, 1);
    assert.equal(db.customers[0].phone, phone);
    assert.equal(db.customers[0].external_customer_id, 'zoho-customer');
    if (existing.length) assert.ok(db.calls.some(call => call.method === 'PATCH' && call.url.searchParams.get('workspace_id') === `eq.${identity.workspaceId}`));
  }
});

test('sync preserves a saved phone when Zoho has no usable number', async () => {
  for (const mobile of [undefined, '', 'invalid', '123']) {
    const db = databaseFixture([savedCustomer({phone})]), f = providerFixture();
    f.state.contacts[0].mobile = mobile;
    await syncFixture(db, f.adapter);
    assert.equal(db.customers[0].phone, phone);
    const write = db.calls.find(call => call.table === 'customers' && call.method === 'POST');
    assert.equal(Object.hasOwn(write.body[0], 'phone'), false);
  }
  const db = databaseFixture([savedCustomer({phone, email: 'owner@example.test'})]), f = providerFixture();
  f.state.contacts[0] = {...f.state.contacts[0], mobile: '', email: 'owner@example.test'};
  await syncFixture(db, f.adapter);
  assert.equal(db.customers[0].phone, phone);
  const patch = db.calls.find(call => call.table === 'customers' && call.method === 'PATCH');
  assert.equal(Object.hasOwn(patch.body, 'phone'), false);
});

test('invoice phone fallback is linked by customer ID and contact phone takes precedence', async () => {
  for (const mobile of [undefined, '+919000000001']) {
    const db = databaseFixture([savedCustomer()]), f = providerFixture();
    f.state.contacts[0].mobile = mobile;
    f.state.invoices = [invoiceRaw({date: null, contact_persons_details: [{mobile: '9871367051'}]}),
      invoiceRaw({date: null, customer_id: 'other-customer', mobile: '+919000000002'})];
    await syncFixture(db, f.adapter);
    assert.equal(db.customers[0].phone, mobile || phone);
  }
});

test('invoice-only fallback fills only an empty customer phone in the scoped provider identity', async () => {
  for (const existingPhone of [null, '', '+919000000001']) {
    const db = databaseFixture([savedCustomer({phone: existingPhone})]), f = providerFixture();
    f.state.contacts = [];
    f.state.invoices = [invoiceRaw({date: null, contact_persons: [{phone: '09871367051'}]})];
    await syncFixture(db, f.adapter);
    assert.equal(db.customers[0].phone, existingPhone || phone);
    const patch = db.calls.find(call => call.table === 'customers' && call.method === 'PATCH');
    if (existingPhone) assert.equal(patch, undefined);
    else {
      assert.deepEqual(patch.body, {phone});
      assert.equal(patch.url.searchParams.get('workspace_id'), `eq.${identity.workspaceId}`);
      assert.equal(patch.url.searchParams.get('external_provider'), 'eq.zoho_books');
      assert.equal(patch.url.searchParams.get('external_customer_id'), 'eq.zoho-customer');
      assert.equal(patch.url.searchParams.get('or'), '(phone.is.null,phone.eq.)');
    }
  }
});

test('invoice fallback cannot match a customer in another workspace, provider, or external ID', async () => {
  for (const mismatch of [{workspace_id: 'other-workspace'}, {external_provider: 'quickbooks'}, {external_customer_id: 'other-customer'}]) {
    const db = databaseFixture([savedCustomer(mismatch)]), f = providerFixture();
    f.state.contacts = [];
    f.state.invoices = [invoiceRaw({date: null, mobile: '9871367051'})];
    await syncFixture(db, f.adapter);
    assert.equal(db.customers[0].phone, null);
    assert.equal(db.calls.some(call => call.table === 'customers' && call.method !== 'GET'), false);
  }
});
