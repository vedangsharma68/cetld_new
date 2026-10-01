import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createWhatsAppAssistantChannel} from '../ai/whatsapp-channel.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';

const scope = {workspaceId: '11111111-1111-4111-8111-111111111111',
  customerId: '22222222-2222-4222-8222-222222222222', phone: '+14155550123'};
const invoice = {invoiceNumber: 'INV-50', clientName: 'Buyer', clientEmail: null, clientPhone: null,
  invoiceDate: '2026-10-01', dueDate: '2026-10-31', subtotal: 100, tax: 0, total: 100,
  outstanding: 100, currency: 'USD', notes: null, alreadyPaid: false, direction: 'receivable', lineItems: []};

function durableReview(action, now = Date.now()) {
  let row = {id: 7, version: 1, generation: 3, action, created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60_000).toISOString()};
  return {get row() { return row; }, async loadInvoiceReview(input) {
    return Object.values(scope).every(value => Object.values(input).includes(value)) && row && Date.parse(row.expires_at) > now ? structuredClone(row) : null;
  }, async transitionInvoiceReview(input) {
    if (!row || input.id !== row.id || input.version !== row.version || input.fromStage !== row.action.stage
      || input.workspaceId !== scope.workspaceId || input.customerId !== scope.customerId || input.phone !== scope.phone) return null;
    row = {...row, version: row.version + 1, action: structuredClone(input.action)};
    return structuredClone(row);
  }, replace(newAction) { row = {...row, id: row.id + 1, generation: row.generation + 1,
    version: 1, action: newAction}; }};
}

function invoiceSupabase() {
  const rows = [];
  const customer = {id: scope.customerId, workspace_id: scope.workspaceId, name: 'Buyer'};
  function query(table) {
    let mode = 'select', payload;
    const q = {select() { mode = mode === 'upsert' || mode === 'update' ? mode : 'select'; return q; },
      eq() { return q; }, limit() { return Promise.resolve({data: table === 'customers' ? [customer] : rows, error: null}); },
      upsert(value) { mode = 'upsert'; payload = value; return q; }, update(value) { mode = 'update'; payload = value; return q; },
      single() { Object.assign(rows[0], payload); return Promise.resolve({data: rows[0], error: null}); },
      then(resolve) {
        if (mode === 'upsert') {
          if (!rows.length) rows.push({id: '33333333-3333-4333-8333-333333333333', ...payload,
            amount_paid: '0', status: 'draft'});
          return resolve({data: rows.length === 1 && rows[0].metadata.assistant_idempotency_key === payload.metadata.assistant_idempotency_key ? [rows[0]] : [], error: null});
        }
        return resolve({data: table === 'customers' ? [customer] : rows, error: null});
      }};
    return q;
  }
  return {from: query, rows};
}

test('real WhatsApp channel and invoice save path claim concurrent YES once and make replay idempotent', async () => {
  const state = durableReview({type: 'invoice_review_draft', stage: 'proposal', invoice,
    missingFields: [], currencySource: 'user'});
  const db = invoiceSupabase();
  let saves = 0;
  const channel = createWhatsAppAssistantChannel({authorizeChannel: async input => ({...input, allowed: true}),
    createCustomerScopedStore: async () => ({query: async () => []}), answer: async () => { throw new Error('planner used'); },
    ...state, createInvoiceStore: () => createWhatsAppInvoiceStore({supabase: db, ...scope}),
    saveInvoice: async input => { saves++; const {saveAssistantInvoice} = await import('../ai/invoice-ops.mjs'); return saveAssistantInvoice(input); }});
  const [first, second] = await Promise.all([channel.ask({...scope, message: 'YES'}), channel.ask({...scope, message: 'yes'})]);
  assert.equal(saves, 1);
  assert.equal(db.rows.length, 1);
  assert.ok([first, second].some(result => /Invoice saved/.test(result.answer)));
  assert.match((await channel.ask({...scope, message: 'yes'})).answer, /already saved/i);
  assert.equal(saves, 1);
});

test('incomplete confirmation and revoked binding never plan or save', async () => {
  let planner = 0, saves = 0;
  const state = durableReview({type: 'invoice_review_draft', stage: 'incomplete', invoice: {...invoice, currency: null},
    missingFields: ['currency'], currencySource: null});
  const incomplete = createWhatsAppAssistantChannel({authorizeChannel: async input => ({...input, allowed: true}),
    createCustomerScopedStore: async () => ({query: async () => []}), answer: async () => { planner++; }, ...state,
    createInvoiceStore: () => ({}), saveInvoice: async () => { saves++; }});
  assert.match((await incomplete.ask({...scope, message: 'yes'})).answer, /incomplete/i);
  const revoked = createWhatsAppAssistantChannel({authorizeChannel: async input => ({...input, allowed: false}),
    createCustomerScopedStore: async () => ({query: async () => []}), answer: async () => { planner++; }, ...state});
  assert.equal((await revoked.ask({...scope, message: 'yes'})).denied, true);
  assert.equal(planner, 0); assert.equal(saves, 0);
});

test('CAS rejects wrong scope and stale photo/currency workers without resurrecting state', async () => {
  const state = durableReview({type: 'invoice_review_draft', stage: 'incomplete', invoice: {...invoice, currency: null},
    missingFields: ['currency'], currencySource: null});
  const old = structuredClone(state.row);
  assert.equal(await state.transitionInvoiceReview({...old, ...scope, customerId: 'wrong', fromStage: 'incomplete',
    action: {...old.action, stage: 'proposal'}}), null);
  state.replace({type: 'invoice_review_draft', stage: 'extracting'});
  assert.equal(await state.transitionInvoiceReview({...old, ...scope, fromStage: 'incomplete',
    action: {...old.action, stage: 'proposal'}}), null);
  assert.equal(state.row.action.stage, 'extracting');
});

test('currency-only photo continuation proposes before the planner and repeated currency is stable', async () => {
  let row = null, planner = 0, saves = 0;
  const pending = {async beginInvoiceReview() { row = {id: 12, version: 1, generation: 1,
    action: {type: 'invoice_review_draft', stage: 'extracting'}}; return structuredClone(row); },
  async loadInvoiceReview() { return row && structuredClone(row); }, async transitionInvoiceReview(input) {
    if (!row || row.id !== input.id || row.version !== input.version || row.action.stage !== input.fromStage) return null;
    row = {...row, version: row.version + 1, action: structuredClone(input.action)}; return structuredClone(row);
  }};
  const supabase = {rpc() {}, from(table) { const q = {select() { return q; }, eq() { return q; }, order() { return q; },
    limit() { return Promise.resolve({data: [], error: null}); }, insert() { return Promise.resolve({error: null}); },
    delete() { return q; }, in() { return Promise.resolve({error: null}); }, async maybeSingle() {
      if (table === 'workspace_ai_settings') return {data: {primary_model: 'space-bunny-free', fallback_model: null}};
      if (table === 'workspace_settings') return {data: {business_name: 'Seller', whatsapp_owner_attested_at: '2026-10-01T00:00:00Z'}};
      if (table.includes('suppressions')) return {data: null};
      if (table === 'whatsapp_consents') return {data: {source: 'verbal', revoked_at: null, categories: ['invoice_updates'], customer_id: scope.customerId}};
      if (table === 'customers') return {data: {id: scope.customerId, phone: scope.phone}};
      throw new Error(table);
    }}; return q; }};
  const fields = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientEmail','notes','direction']
    .map(name => [name, {value: ({invoiceNumber:'INV-50',customerName:'Buyer',invoiceDate:'2026-10-01',dueDate:'2026-10-31',subtotal:100,tax:0,total:100,outstandingAmount:100,direction:'receivable'})[name] ?? null,
      confidence: name === 'currency' ? 0 : .99}]));
  const handler = createWhatsAppBoundMessageHandler({supabase, providerFactory: () => ({}),
    pendingActionStoreFactory: () => pending, invoiceStoreFactory: () => ({save() { saves++; }}),
    channelFactory: () => ({async ask() { planner++; return {answer: 'planner'}; }}),
    extract: async () => ({...fields, lineItems: {value: [], confidence: .99}})});
  assert.match(await handler({...scope, message: '', media: {bytes: Buffer.from([1]), mimeType: 'image/png'}}), /currency.*USD/i);
  const proposal = await handler({...scope, message: 'USD'});
  assert.match(proposal, /INV-50.*USD 100/s);
  const version = row.version;
  assert.equal(await handler({...scope, message: 'USD'}), proposal);
  assert.equal(row.version, version);
  assert.equal(planner, 0); assert.equal(saves, 0);
});

test('atomic review migration is one paste-ready statement with service-only ACLs and executable CAS', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261001100000_atomic_whatsapp_invoice_reviews.sql', import.meta.url), 'utf8');
  assert.match(sql.trim(), /^do \$migration\$/i);
  assert.doesNotMatch(sql, /grant\s+execute[^;]+\b(?:anon|authenticated)\b/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on function[\s\S]+from public, anon, authenticated/i);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.whatsapp_pending_actions(id bigserial primary key, workspace_id uuid not null,
      customer_id uuid not null, phone text not null, action jsonb not null, source text not null,
      created_at timestamptz not null default now(), consumed_at timestamptz);
      create unique index whatsapp_pending_actions_active_scope_idx on public.whatsapp_pending_actions
      (workspace_id,customer_id,phone) where consumed_at is null;`);
    await db.exec(sql);
    await db.exec('set role service_role');
    const begun = (await db.query('select * from public.whatsapp_begin_invoice_review($1,$2,$3)',
      [scope.workspaceId, scope.customerId, scope.phone])).rows[0];
    assert.equal(begun.action.stage, 'extracting');
    const next = {...begun.action, stage: 'incomplete', invoice: {...invoice, currency: null}, missingFields: ['currency'], currencySource: null};
    const changed = (await db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',
      [begun.id, begun.version, scope.workspaceId, scope.customerId, scope.phone, 'extracting', next])).rows;
    assert.equal(changed[0].version, 2);
    assert.equal((await db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',
      [begun.id, begun.version, scope.workspaceId, scope.customerId, scope.phone, 'extracting', next])).rows.length, 0);
  } finally { await db.close(); }
});
