import test from 'node:test';
import assert from 'node:assert/strict';
import {SupabaseAccountingStore} from '../automation/accounting/store.mjs';

const options = {url: 'https://db.example.test', serviceRoleKey: 'test-service-key'};
const identity = {userId: 'owner-1', workspaceId: 'workspace-1', provider: 'quickbooks'};

function invoice(externalId, number) {
  return {externalId, number, invoiceDate: '2026-09-01', dueDate: '2026-10-01', currency: 'USD',
    amountMinor: 12000, paidMinor: 0, balanceMinor: 12000, status: 'sent', raw: {customer_id: 'customer-1'}};
}

function payment(externalId, invoiceId) {
  return {externalId, invoiceIds: [invoiceId], paymentDate: '2026-09-10', amountMinor: 2500,
    currency: 'USD', raw: {invoices: [{invoice_id: invoiceId, amount_applied: 25}]}};
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

test('accounting sync skips tombstoned invoices and linked payments while continuing active records', async () => {
  const calls = [];
  const records = {
    'deleted-external': {id: 'deleted-local', external_invoice_id: 'deleted-external', invoice_number: 'INV-DELETED', deleted_at: '2026-10-01T00:00:00Z'},
    'active-external': {id: 'active-local', external_invoice_id: 'active-external', invoice_number: 'INV-ACTIVE', deleted_at: null, metadata: {invoice_direction: 'receivable'}, updated_at: '2026-10-04T00:00:00Z'},
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({table, method: init.method || 'GET', url, body});
    if (table === 'workspaces') return json([{id: identity.workspaceId}]);
    if (table === 'payments' && (init.method || 'GET') === 'GET') return json([]);
    if (table === 'cetld_accounting_sync_records') return json(body);
    if (table === 'customers') return json([{id: 'customer-local'}]);
    if (table === 'invoices' && (init.method || 'GET') === 'GET') {
      const externalId = url.searchParams.get('external_invoice_id')?.slice(3);
      return json(externalId && records[externalId] ? [records[externalId]] : []);
    }
    if (table === 'invoices' && init.method === 'PATCH') return json([{id: url.searchParams.get('id').slice(3)}]);
    if (table === 'payments' && init.method === 'POST') return json([{id: 'payment-local'}]);
    throw new Error(`Unexpected accounting request ${init.method || 'GET'} ${url.pathname}`);
  };
  const store = new SupabaseAccountingStore({...options, fetchImpl});

  const result = await store.upsertSyncSnapshots({
    ...identity,
    customers: [],
    invoices: [invoice('deleted-external', 'INV-DELETED'), invoice('active-external', 'INV-ACTIVE')],
    payments: [payment('payment-deleted', 'deleted-external'), payment('payment-active', 'active-external')],
  });

  assert.deepEqual(result, {count: 4, customers: 0, invoices: 1, payments: 1});
  const invoiceReads = calls.filter(call => call.table === 'invoices' && call.method === 'GET');
  assert.ok(invoiceReads.every(call => call.url.searchParams.get('select').split(',').includes('deleted_at')));
  const invoicePatches = calls.filter(call => call.table === 'invoices' && call.method === 'PATCH');
  assert.deepEqual(invoicePatches.map(call => call.url.searchParams.get('id')), ['eq.active-local']);
  const paymentWrites = calls.filter(call => call.table === 'payments' && call.method === 'POST');
  assert.equal(paymentWrites.length, 1);
  assert.equal(paymentWrites[0].body[0].external_payment_id, 'payment-active');
});

test('accounting sync falls back only when deleted_at is genuinely missing', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    calls.push({table, method: init.method || 'GET', url});
    if (table === 'workspaces') return json([{id: identity.workspaceId}]);
    if (table === 'payments' && (init.method || 'GET') === 'GET') return json([]);
    if (table === 'cetld_accounting_sync_records') return json(JSON.parse(init.body));
    if (table === 'customers') return json([{id: 'customer-local'}]);
    if (table === 'invoices' && (init.method || 'GET') === 'GET') {
      if (url.searchParams.get('select').includes('deleted_at')) return json({code: '42703', message: 'column invoices.deleted_at does not exist'}, 400);
      return json([{id: 'legacy-active', external_invoice_id: 'legacy-external', invoice_number: 'INV-LEGACY', metadata: {invoice_direction: 'receivable'}, updated_at: '2026-10-04T00:00:00Z'}]);
    }
    if (table === 'invoices' && init.method === 'PATCH' && url.searchParams.has('deleted_at')) return json({code: '42703', message: 'column invoices.deleted_at does not exist'}, 400);
    if (table === 'invoices' && init.method === 'PATCH') return json([{id: url.searchParams.get('id').slice(3)}]);
    throw new Error(`Unexpected accounting request ${init.method || 'GET'} ${url.pathname}`);
  };
  const store = new SupabaseAccountingStore({...options, fetchImpl});

  const result = await store.upsertSyncSnapshots({...identity, invoices: [invoice('legacy-external', 'INV-LEGACY')]});

  assert.equal(result.invoices, 1);
  const reads = calls.filter(call => call.table === 'invoices' && call.method === 'GET');
  assert.equal(reads.length, 2);
  assert.ok(reads[0].url.searchParams.get('select').includes('deleted_at'));
  assert.equal(reads[1].url.searchParams.get('select').includes('deleted_at'), false);
  const patches = calls.filter(call => call.table === 'invoices' && call.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal(patches[0].url.searchParams.get('deleted_at'), 'is.null');
  assert.equal(patches[1].url.searchParams.has('deleted_at'), false);
});

test('accounting sync does not use the legacy invoice lookup after unrelated database errors', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    calls.push({table, method: init.method || 'GET', url});
    if (table === 'workspaces') return json([{id: identity.workspaceId}]);
    if (table === 'payments' && (init.method || 'GET') === 'GET') return json([]);
    if (table === 'cetld_accounting_sync_records') return json(JSON.parse(init.body));
    if (table === 'customers') return json([{id: 'customer-local'}]);
    if (table === 'invoices' && (init.method || 'GET') === 'GET') return json({code: '42501', message: 'permission denied'}, 403);
    throw new Error(`Unexpected accounting request ${init.method || 'GET'} ${url.pathname}`);
  };
  const store = new SupabaseAccountingStore({...options, fetchImpl});

  await assert.rejects(store.upsertSyncSnapshots({...identity, invoices: [invoice('blocked-external', 'INV-BLOCKED')]}), error => error.code === 'ACCOUNTING_STORE_ERROR');
  assert.equal(calls.filter(call => call.table === 'invoices' && call.method === 'GET').length, 1);
  assert.equal(calls.some(call => call.table === 'invoices' && call.method === 'PATCH'), false);
});

test('accounting sync skips a payment write only after a reread confirms its invoice was deleted', async () => {
  const calls = [];
  const records = {
    'payment-race-invoice': {id: 'payment-race-local', workspace_id: identity.workspaceId, external_provider: identity.provider, external_invoice_id: 'payment-race-invoice', invoice_number: 'INV-PAY-RACE', deleted_at: null, metadata: {invoice_direction: 'receivable'}, updated_at: '2026-10-04T00:00:00Z'},
    'payment-active-invoice': {id: 'payment-active-local', workspace_id: identity.workspaceId, external_provider: identity.provider, external_invoice_id: 'payment-active-invoice', invoice_number: 'INV-PAY-ACTIVE', deleted_at: null, metadata: {invoice_direction: 'receivable'}, updated_at: '2026-10-04T00:00:00Z'},
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({table, method, url, body});
    if (table === 'workspaces') return json([{id: identity.workspaceId}]);
    if (table === 'payments' && (init.method || 'GET') === 'GET') return json([]);
    if (table === 'cetld_accounting_sync_records') return json(body);
    if (table === 'customers') return json([{id: 'customer-local'}]);
    if (table === 'invoices' && method === 'GET') {
      const externalId = url.searchParams.get('external_invoice_id')?.slice(3);
      return json(externalId && records[externalId] ? [records[externalId]] : []);
    }
    if (table === 'invoices' && method === 'PATCH') return json([{id: url.searchParams.get('id').slice(3)}]);
    if (table === 'payments' && method === 'POST') {
      if (body[0].external_payment_id === 'payment-race') {
        records['payment-race-invoice'].deleted_at = '2026-10-02T00:00:00Z';
        return json({code: 'P0001', message: 'cannot add payment to deleted invoice'}, 400);
      }
      return json([{id: 'payment-active-row'}]);
    }
    throw new Error(`Unexpected accounting request ${method} ${url.pathname}`);
  };
  const store = new SupabaseAccountingStore({...options, fetchImpl});

  const result = await store.upsertSyncSnapshots({...identity,
    invoices: [invoice('payment-race-invoice', 'INV-PAY-RACE'), invoice('payment-active-invoice', 'INV-PAY-ACTIVE')],
    payments: [payment('payment-race', 'payment-race-invoice'), payment('payment-active', 'payment-active-invoice')],
  });

  assert.deepEqual(result, {count: 4, customers: 0, invoices: 2, payments: 1});
  const rejectedWrite = calls.findIndex(call => call.table === 'payments' && call.method === 'POST' && call.body[0].external_payment_id === 'payment-race');
  assert.notEqual(rejectedWrite, -1);
  assert.ok(calls.slice(rejectedWrite + 1).some(call => call.table === 'invoices' && call.method === 'GET'
    && call.url.searchParams.get('external_invoice_id') === 'eq.payment-race-invoice'));
  assert.deepEqual(calls.filter(call => call.table === 'payments' && call.method === 'POST' && call.body[0].external_payment_id === 'payment-active').length, 1);
});

test('accounting sync skips a failed invoice upsert only after a reread confirms the target is tombstoned', async () => {
  const calls = [];
  const records = {};
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({table, method, url, body});
    if (table === 'workspaces') return json([{id: identity.workspaceId}]);
    if (table === 'payments' && (init.method || 'GET') === 'GET') return json([]);
    if (table === 'cetld_accounting_sync_records') return json(body);
    if (table === 'customers') return json([{id: 'customer-local'}]);
    if (table === 'invoices' && method === 'GET') {
      const externalId = url.searchParams.get('external_invoice_id')?.slice(3);
      if (externalId) return json(records[externalId] ? [records[externalId]] : []);
      const invoiceNumber = url.searchParams.get('invoice_number')?.slice(3);
      return json(Object.values(records).filter(row => row.invoice_number === invoiceNumber));
    }
    if (table === 'invoices' && method === 'POST') {
      const row = body[0];
      if (row.external_invoice_id === 'invoice-race') {
        records['invoice-race'] = {id: 'invoice-race-local', workspace_id: identity.workspaceId, external_provider: identity.provider,
          external_invoice_id: 'invoice-race', invoice_number: 'INV-RACE', deleted_at: '2026-10-02T00:00:00Z'};
        return json({code: 'P0001', message: 'cannot update deleted invoice'}, 400);
      }
      records[row.external_invoice_id] = {id: 'invoice-active-local', workspace_id: identity.workspaceId, external_provider: identity.provider,
        external_invoice_id: row.external_invoice_id, invoice_number: row.invoice_number, deleted_at: null, metadata: {invoice_direction: 'receivable'}, updated_at: '2026-10-04T00:00:00Z'};
      return json([{id: 'invoice-active-local'}]);
    }
    if (table === 'payments' && method === 'POST') return json([{id: 'payment-active-row'}]);
    throw new Error(`Unexpected accounting request ${method} ${url.pathname}`);
  };
  const store = new SupabaseAccountingStore({...options, fetchImpl});

  const result = await store.upsertSyncSnapshots({...identity,
    invoices: [invoice('invoice-race', 'INV-RACE'), invoice('invoice-active', 'INV-ACTIVE')],
    payments: [payment('payment-race', 'invoice-race'), payment('payment-active', 'invoice-active')],
  });

  assert.deepEqual(result, {count: 4, customers: 0, invoices: 1, payments: 1});
  const rejectedWrite = calls.findIndex(call => call.table === 'invoices' && call.method === 'POST' && call.body[0].external_invoice_id === 'invoice-race');
  assert.notEqual(rejectedWrite, -1);
  assert.ok(calls.slice(rejectedWrite + 1).some(call => call.table === 'invoices' && call.method === 'GET'
    && call.url.searchParams.get('external_invoice_id') === 'eq.invoice-race'));
  assert.equal(calls.some(call => call.table === 'payments' && call.method === 'POST' && call.body[0].external_payment_id === 'payment-race'), false);
  assert.equal(calls.filter(call => call.table === 'invoices' && call.method === 'POST' && call.body[0].external_invoice_id === 'invoice-active').length, 1);
});

test('accounting sync propagates an invoice upsert error when the scoped reread does not confirm a tombstone', async () => {
  const calls = [];
  const originalBody = {code: 'XX000', message: 'unrelated database failure'};
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({table, method, url, body});
    if (table === 'workspaces') return json([{id: identity.workspaceId}]);
    if (table === 'payments' && (init.method || 'GET') === 'GET') return json([]);
    if (table === 'cetld_accounting_sync_records') return json(body);
    if (table === 'customers') return json([{id: 'customer-local'}]);
    if (table === 'invoices' && method === 'GET') return json([]);
    if (table === 'invoices' && method === 'POST') return json(originalBody, 500);
    throw new Error(`Unexpected accounting request ${method} ${url.pathname}`);
  };
  const store = new SupabaseAccountingStore({...options, fetchImpl});

  await assert.rejects(store.upsertSyncSnapshots({...identity,
    invoices: [invoice('invoice-failure', 'INV-FAILURE'), invoice('invoice-later', 'INV-LATER')],
  }), error => error.code === 'ACCOUNTING_STORE_ERROR');

  const failedWrite = calls.findIndex(call => call.table === 'invoices' && call.method === 'POST');
  assert.notEqual(failedWrite, -1);
  assert.ok(calls.slice(failedWrite + 1).some(call => call.table === 'invoices' && call.method === 'GET'
    && call.url.searchParams.get('external_invoice_id') === 'eq.invoice-failure'));
  assert.equal(calls.some(call => call.table === 'invoices' && call.method === 'POST' && call.body[0].external_invoice_id === 'invoice-later'), false);
});
