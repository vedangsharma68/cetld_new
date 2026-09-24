import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountingTools} from '../ai/accounting-tools.mjs';

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function setup() {
  const calls = [];
  const integration = {
    async readZohoData(input) {
      calls.push(['read', input]);
      return {provider: 'zoho_books', resource: input.resource, records: [{externalId: 'z-inv-1', number: 'INV-005', amountMinor: 8460000, balanceMinor: 8460000, paidMinor: 0, currency: 'INR', raw: {access_token: 'private'}}], nextPage: null};
    },
    async syncInvoice(input) { calls.push(['create', input]); return {provider: 'zoho_books', externalId: 'z-inv-2', duplicate: false}; },
    async updateInvoice(input) { calls.push(['update', input]); return {provider: 'zoho_books', externalId: input.invoiceId}; },
    async sync(input) { calls.push(['sync', input]); return {provider: 'zoho_books', persisted: true}; },
  };
  return {calls, tools: createAccountingTools({integration, userId: USER, workspaceId: WORKSPACE})};
}

test('Zoho reads are workspace-scoped and strip provider raw objects', async () => {
  const {calls, tools} = setup();
  const result = await tools.getInvoices();
  assert.equal(result[0].externalId, 'z-inv-1');
  assert.equal('raw' in result[0], false);
  assert.equal(calls[0][1].userId, USER);
  assert.equal(calls[0][1].workspaceId, WORKSPACE);
  assert.equal(calls[0][1].resource, 'invoices');
  const contacts = await tools.readZohoData({resource: 'contacts'});
  assert.equal(contacts.resource, 'contacts');
  assert.equal(calls[1][1].resource, 'contacts');
});

test('create and update require explicit confirmation and validate allowed fields', async () => {
  const {calls, tools} = setup();
  const invoice = {invoiceNumber:'INV-1048',clientName:'Shiv Engineering',invoiceDate:'2026-10-01',dueDate:'2026-10-15',currency:'INR',total:84600};
  await assert.rejects(tools.createInvoice({invoice, invoiceId:'33333333-3333-4333-8333-333333333333', idempotencyKey:'invoice_create_1048'}), error => error.code === 'CONFIRMATION_REQUIRED');
  await assert.rejects(tools.updateInvoice({invoiceId:'z-inv-1', changes:{dueDate:'2026-10-30'}}), error => error.code === 'CONFIRMATION_REQUIRED');
  const created = await tools.createInvoice({invoice, invoiceId:'33333333-3333-4333-8333-333333333333', idempotencyKey:'invoice_create_1048', confirmed:true});
  assert.equal(created.externalId, 'z-inv-2');
  const updated = await tools.updateInvoice({invoiceId:'z-inv-1', changes:{dueDate:'2026-10-30'}, confirmed:true});
  assert.equal(updated.externalId, 'z-inv-1');
  assert.equal(calls.filter(([kind]) => ['create','update'].includes(kind)).length, 2);
  await assert.rejects(tools.updateInvoice({invoiceId:'z-inv-1', changes:{total:1}, confirmed:true}), error => error.code === 'INVALID_INVOICE_CHANGES');
});

test('safe Zoho Assistant read strips credentials and workspace identifiers', async () => {
  const {tools} = setup();
  const result = await tools.readZohoData({resource:'invoices'});
  const output = JSON.stringify(result);
  assert.match(output, /"amountMinor":8460000/);
  assert.doesNotMatch(output, /access_token|WORKSPACE|11111111-1111/);
});
