import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createWhatsAppAssistantChannel} from '../ai/whatsapp-channel.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';

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

function combinedSupabase() {
  let review = null;
  const invoices = [];
  const customer = {id: scope.customerId, workspace_id: scope.workspaceId, phone: scope.phone, name: 'Buyer'};
  const clone = value => value == null ? value : structuredClone(value);
  const rpc = async (name, args) => {
    if (name === 'whatsapp_begin_invoice_review') {
      review = {id: (review?.id || 40) + 1, version: 1, generation: (review?.generation || 0) + 1,
        action: {type: 'invoice_review_draft', stage: 'extracting'}, created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 900_000).toISOString()};
      return {data: [clone(review)], error: null};
    }
    if (name === 'whatsapp_load_invoice_review') return {data: review ? [clone(review)] : [], error: null};
    if (name === 'whatsapp_transition_invoice_review') {
      if (!review || review.id !== args.p_id || review.version !== args.p_version
        || review.action.stage !== args.p_from_stage || args.p_workspace_id !== scope.workspaceId
        || args.p_customer_id !== scope.customerId || args.p_phone !== scope.phone) return {data: [], error: null};
      review = {...review, version: review.version + 1, action: clone(args.p_action)};
      return {data: [clone(review)], error: null};
    }
    throw new Error(`unexpected RPC ${name}`);
  };
  function from(table) {
    let operation = 'select', payload;
    const q = {select() { return q; }, eq() { return q; }, is() { return q; }, order() { return q; }, range() { return q; },
      in() { return q; }, delete() { operation = 'delete'; return q; }, insert(value) { operation = 'insert'; payload = value; return q; },
      update(value) { operation = 'update'; payload = value; return q; }, upsert(value) { operation = 'upsert'; payload = value; return q; },
      limit() { return q; }, async maybeSingle() {
        if (table === 'workspace_ai_settings') return {data: {primary_model: 'provider-neutral-chat', fallback_model: null}, error: null};
        if (table === 'workspace_settings') return {data: {business_name: 'Seller', whatsapp_owner_attested_at: '2026-10-01T00:00:00Z'}, error: null};
        if (table === 'whatsapp_global_suppressions' || table === 'whatsapp_suppressions') return {data: null, error: null};
        if (table === 'whatsapp_consents') return {data: {source: 'verbal', revoked_at: null, categories: ['invoice_updates'], customer_id: scope.customerId}, error: null};
        if (table === 'customers') return {data: customer, error: null};
        return {data: null, error: null};
      }, async single() { Object.assign(invoices[0], payload); return {data: clone(invoices[0]), error: null}; },
      then(resolve) {
        if (table === 'invoices' && operation === 'upsert') {
          if (!invoices.length) invoices.push({id: '33333333-3333-4333-8333-333333333333', ...clone(payload), amount_paid: '0', status: 'draft'});
          return resolve({data: [clone(invoices[0])], error: null});
        }
        if (table === 'invoices') return resolve({data: clone(invoices), error: null});
        if (table === 'customers') return resolve({data: [clone(customer)], error: null});
        return resolve({data: [], error: null});
      }};
    return q;
  }
  return {rpc, from, invoices, get review() { return review; }};
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

test('default handler, real channel and real invoice store complete photo currency confirmation exactly once', async () => {
  const db = combinedSupabase();
  const fields = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientEmail','notes','direction']
    .map(name => [name, {value: ({invoiceNumber:'INV-50',customerName:'Buyer',invoiceDate:'2026-10-01',dueDate:'2026-10-31',subtotal:100,tax:0,total:100,outstandingAmount:100,direction:'receivable'})[name] ?? null,
      confidence: name === 'currency' ? 0 : .99}]));
  const handler = createWhatsAppBoundMessageHandler({supabase: db, providerFactory: () => ({}),
    extract: async () => ({...fields, lineItems: {value: [], confidence: .99}})});
  assert.match(await handler({...scope, message: '', media: {bytes: Buffer.from([1]), mimeType: 'image/png'}}), /currency.*USD/i);
  const proposal = await handler({...scope, message: 'USD'});
  assert.match(proposal, /INV-50.*USD 100/s);
  assert.deepEqual(Object.keys(db.review.action.invoice).sort(), Object.keys(invoice).sort());
  assert.equal(Object.hasOwn(db.review.action.invoice, 'missingDueDate'), false);
  assert.equal(await handler({...scope, message: 'USD'}), proposal);
  const [a, b] = await Promise.all([
    handler({...scope, message: 'yes'}), handler({...scope, message: 'confirm'}),
  ]);
  assert.equal(db.invoices.length, 1);
  assert.ok([a, b].some(answer => /Invoice saved/.test(answer)));
  assert.ok([a, b].some(answer => /already being saved|already saved/.test(answer)));
  assert.match(await handler({...scope, message: 'yes'}), /already saved/i);
  assert.equal(db.invoices.length, 1);
  assert.equal(Object.hasOwn(db.review.action.invoice, 'missingDueDate'), false);

  const completeDb = combinedSupabase();
  const complete = structuredClone(fields);
  complete.invoiceNumber.value = 'INV-51';
  complete.currency = {value: 'USD', confidence: .99};
  const completeHandler = createWhatsAppBoundMessageHandler({supabase: completeDb, providerFactory: () => ({}),
    extract: async () => ({...complete, lineItems: {value: [], confidence: .99}})});
  assert.match(await completeHandler({...scope, message: '', media: {bytes: Buffer.from([2]), mimeType: 'image/png'}}), /INV-51.*USD 100/s);
  assert.match(await completeHandler({...scope, message: 'go ahead'}), /Invoice saved/);
  assert.equal(completeDb.invoices.length, 1);
  assert.equal(Object.hasOwn(completeDb.review.action.invoice, 'missingDueDate'), false);
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
    await assert.rejects(db.query('select * from public.whatsapp_begin_invoice_review($1,$2,$3)',
      [null, scope.customerId, scope.phone]), /invalid review scope/i);
    await assert.rejects(db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',
      [begun.id, 2, scope.workspaceId, scope.customerId, scope.phone, null, {}]), /invalid invoice review transition/i);

    const state = async phone => (await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',
      [scope.workspaceId, scope.customerId, phone])).rows[0];
    const store = async (phone, expected, number) => (await db.query(
      'select * from public.whatsapp_store_pending_action($1,$2,$3,$4,$5,$6,$7,$8)',
      [scope.workspaceId, scope.customerId, phone,
        {type: 'create_invoice', payload: {invoice: {...invoice, invoiceNumber: number}}}, 'whatsapp',
        expected.generation, expected.id, expected.version])).rows;

    // An expected-empty planner cannot overwrite a photo that arrived while it worked.
    const emptyPhone = '+14155550124';
    const expectedEmpty = await state(emptyPhone);
    const photo = (await db.query('select * from public.whatsapp_begin_invoice_review($1,$2,$3)',
      [scope.workspaceId, scope.customerId, emptyPhone])).rows[0];
    assert.equal((await store(emptyPhone, expectedEmpty, 'STALE-EMPTY')).length, 0);
    assert.equal((await state(emptyPhone)).id, photo.id);

    // A planner tied to an existing row/version also loses after that row changes.
    const rowPhone = '+14155550125';
    const firstState = await state(rowPhone);
    assert.equal((await store(rowPhone, firstState, 'FIRST')).length, 1);
    const expectedRow = await state(rowPhone);
    await db.query('update public.whatsapp_pending_actions set version=version+1 where id=$1', [expectedRow.id]);
    assert.equal((await store(rowPhone, expectedRow, 'STALE-ROW')).length, 0);

    // Two generic proposals from the same generation have exactly one winner.
    const racePhone = '+14155550126';
    const raceState = await state(racePhone);
    const results = await Promise.all([store(racePhone, raceState, 'RACE-A'), store(racePhone, raceState, 'RACE-B')]);
    assert.deepEqual(results.map(rows => rows.length).sort(), [0, 1]);
    const raceWinner = results.find(rows => rows.length)?.[0];
    assert.equal((await db.query('select * from public.whatsapp_claim_pending_action($1,$2,$3,$4)',
      [raceWinner.id, scope.workspaceId, scope.customerId, racePhone])).rows.length, 1);
    assert.equal((await db.query('select * from public.whatsapp_claim_pending_action($1,$2,$3,$4)',
      [raceWinner.id, scope.workspaceId, scope.customerId, racePhone])).rows.length, 0);

    // A photo/generic race cannot revive the generic proposal after the photo tombstone.
    const photoRacePhone = '+14155550127';
    const photoRaceState = await state(photoRacePhone);
    const [, staleGeneric] = await Promise.all([
      db.query('select * from public.whatsapp_begin_invoice_review($1,$2,$3)',
        [scope.workspaceId, scope.customerId, photoRacePhone]),
      store(photoRacePhone, photoRaceState, 'PHOTO-RACE'),
    ]);
    const photoRaceActive = await state(photoRacePhone);
    if (staleGeneric.length === 1) {
      // If generic acquired the lock first, begin must replace it.
      assert.equal(photoRaceActive.action.stage, 'extracting');
      assert.notEqual(photoRaceActive.id, staleGeneric[0].id);
    } else assert.equal(photoRaceActive.action.stage, 'extracting');

    // Terminal reviews are replaceable, while saving survives ordinary expiry,
    // blocks replacement photos, and may complete after expiry.
    for (const [offset, terminal] of [[28, 'canceled'], [29, 'saved']]) {
      const phone = `+141555501${offset}`;
      await db.query(`insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source,generation,expires_at)
        values($1,$2,$3,$4,'whatsapp',1,now()+interval '1 minute')`,
      [scope.workspaceId, scope.customerId, phone, {type:'invoice_review_draft', stage:terminal}]);
      assert.equal((await store(phone, await state(phone), `AFTER-${terminal}`)).length, 1);
    }
    const savingPhone = '+14155550130';
    const savingAction = {type:'invoice_review_draft', stage:'saving', invoice, missingFields:[], currencySource:'photo'};
    const savedAction = {...savingAction, stage:'saved'};
    const saving = (await db.query(`insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source,generation,expires_at)
      values($1,$2,$3,$4,'whatsapp',1,now()-interval '1 minute') returning *`,
    [scope.workspaceId, scope.customerId, savingPhone, savingAction])).rows[0];
    assert.equal((await db.query('select * from public.whatsapp_load_invoice_review($1,$2,$3)',
      [scope.workspaceId, scope.customerId, savingPhone])).rows[0].action.stage, 'saving');
    assert.equal((await db.query('select * from public.whatsapp_begin_invoice_review($1,$2,$3)',
      [scope.workspaceId, scope.customerId, savingPhone])).rows[0].id, saving.id);
    assert.equal((await db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',
      [saving.id, saving.version, scope.workspaceId, scope.customerId, savingPhone, 'saving', savedAction])).rows[0].action.stage, 'saved');

    // SQL NULL/three-valued logic and malformed invoice JSON fail closed.
    const validationPhone = '+14155550131';
    const validating = (await db.query('select * from public.whatsapp_begin_invoice_review($1,$2,$3)',
      [scope.workspaceId, scope.customerId, validationPhone])).rows[0];
    for (const bad of [
      {type:'invoice_review_draft', stage:null},
      {type:'invoice_review_draft', stage:'proposal', invoice:null, missingFields:[], currencySource:'photo'},
      {type:'invoice_review_draft', stage:'proposal', invoice:'scalar', missingFields:[], currencySource:'photo'},
    ]) await assert.rejects(db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',
      [validating.id, validating.version, scope.workspaceId, scope.customerId, validationPhone, 'extracting', bad]),
    /invalid invoice review transition|incomplete invoice review proposal/i);

    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',
      [scope.workspaceId, scope.customerId, racePhone]), /permission denied/i);
  } finally { await db.close(); }
});

test('pending store generic persistence works when passed as an unbound channel function', async () => {
  const calls = [];
  const supabase = {from() { throw new Error('table write bypassed atomic RPC'); }, async rpc(name, args) {
    calls.push({name, args});
    if (name === 'whatsapp_load_pending_action_state') return {data: [{id:null, version:null, generation:0, action:null}]};
    if (name === 'whatsapp_store_pending_action') return {data: [{id:1, version:1, generation:1, action:args.p_action}]};
    throw new Error(name);
  }};
  const {loadPendingActionState, storePendingAction} = createWhatsAppPendingActionStore({supabase});
  const channel = createWhatsAppAssistantChannel({authorizeChannel: async input => ({...input, allowed:true}),
    createCustomerScopedStore: async () => ({query: async () => []}), loadPendingActionState, storePendingAction,
    answer: async () => ({answer:'Invoice ready', pendingAction:{type:'create_invoice', payload:{invoice}}})});
  assert.equal((await channel.ask({...scope, message:'create invoice'})).requiresInChatConfirmation, true);
  assert.deepEqual(calls.map(call => call.name), ['whatsapp_load_pending_action_state', 'whatsapp_store_pending_action']);
});
