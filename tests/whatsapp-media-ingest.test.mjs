import test from 'node:test';
import {invoiceWire} from './invoice-wire-fixture.mjs';
import assert from 'node:assert/strict';
import {createInboundRuntime, parseMetaMessages} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppAssistantChannel} from '../ai/whatsapp-channel.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {extractInvoice} from '../ai/extraction.mjs';
import {parseOfflineInvoiceText} from '../ai/image-text.mjs';

const scope = {workspaceId: 'workspace-a', customerId: 'customer-a', phone: '+919871367051'};
const action = {type: 'create_invoice', payload: {invoice: {invoiceNumber: 'INV-7', clientName: 'Buyer Co',
  clientEmail: null, clientPhone: null, invoiceDate: '2026-09-30', dueDate: '2026-10-30', subtotal: 100,
  tax: 0, total: 100, outstanding: 100, currency: 'INR', notes: null, alreadyPaid: false,
  direction: 'receivable', lineItems: []}}};

test('image payload captures metadata and Graph bytes are stored before enqueue', async () => {
  const payload = {object: 'whatsapp_business_account', entry: [{id: 'waba', changes: [{field: 'messages', value: {
    metadata: {phone_number_id: 'phone-id'}, messages: [{id: 'wamid.image', from: '919871367051',
      timestamp: '1790769600', type: 'image', image: {id: 'media-1', mime_type: 'image/jpeg', caption: 'September invoice'}}]}}]}]};
  const [parsed] = parseMetaMessages(payload, 'phone-id', 'waba');
  assert.equal(parsed.media_id, 'media-1');
  assert.equal(parsed.media_mime_type, 'image/jpeg');
  assert.equal(parsed.media_caption, 'September invoice');
  const calls = [], stored = [], enqueued = [];
  const inbox = {async hasMedia() { return false; }, async storeMedia(message, bytes, mimeType) { stored.push({message, bytes, mimeType}); },
    async enqueue(messages) { enqueued.push(...messages); return messages; }};
  const runtime = createInboundRuntime({supabase: {}, inbox, env: {WHATSAPP_GRAPH_API_VERSION: 'v24.0', WHATSAPP_ACCESS_TOKEN: 'token'},
    async fetchImpl(url, options) { calls.push({url, options}); return url.includes('graph.facebook.com')
      ? {ok: true, async json() { return {url: 'https://lookaside.example/media', mime_type: 'image/jpeg'}; }}
      : {ok: true, headers: {get() { return '3'; }}, async arrayBuffer() { return Uint8Array.from([0xff,0xd8,0xff]).buffer; }}; }});
  await runtime.enqueue([parsed]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer token');
  assert.deepEqual([...stored[0].bytes], [0xff,0xd8,0xff]);
  assert.equal(enqueued[0].media_ref, 'wamid.image');
});

test('failed media fetch is still enqueued with a durable error', async () => {
  const message = {provider_message_id: 'wamid.fail', message_type: 'image', media_id: 'media-bad'};
  let queued;
  const runtime = createInboundRuntime({supabase: {}, env: {WHATSAPP_GRAPH_API_VERSION: 'v24.0', WHATSAPP_ACCESS_TOKEN: 'token'},
    fetchImpl: async () => ({ok: false}), inbox: {async hasMedia() { return false; }, async enqueue(rows) { queued = rows; return rows; }},
    logger: {error() {}}});
  await runtime.enqueue([message]);
  assert.equal(queued[0].media_ref, 'wamid.fail');
  assert.match(queued[0].media_error, /lookup failed/);
});

function authorizedChannel(options = {}) {
  return createWhatsAppAssistantChannel({authorizeChannel: async input => ({...input, allowed: true}),
    createCustomerScopedStore: async () => ({query() { return []; }}), answer: async () => ({answer: 'Normal reply.', pendingAction: null}), ...options});
}

test('fresh yes saves only its scoped proposal and returns a saved summary', async () => {
  let saveInput, consumed;
  const channel = authorizedChannel({loadPendingAction: async input => ({id: 9, ...input, action, created_at: '2026-09-30T11:30:00Z'}),
    consumePendingAction: async input => { consumed = input; }, createInvoiceStore: async () => ({}),
    saveInvoice: async input => { saveInput = input; return {saved: true, invoice: {invoiceNumber: 'INV-7', clientName: 'Buyer Co', currency: 'INR', total: 100, dueDate: '2026-10-30'}}; },
    clock: () => new Date('2026-09-30T12:00:00Z')});
  const result = await channel.ask({...scope, message: 'yes'});
  assert.equal(saveInput.confirmed, true);
  assert.match(saveInput.idempotencyKey, /^wa_invoice_[a-f0-9]{32}$/);
  assert.equal(consumed.id, 9);
  assert.match(result.answer, /Invoice saved.*INV-7/s);
});

test('bare ok without a proposal reaches the normal assistant', async () => {
  let answers = 0;
  const channel = authorizedChannel({loadPendingAction: async () => null,
    answer: async () => { answers++; return {answer: 'No problem!', pendingAction: null}; }});
  assert.equal((await channel.ask({...scope, message: 'ok'})).answer, 'No problem!');
  assert.equal(answers, 1);
});

test('expired proposal is refused and consumed', async () => {
  let saves = 0, consumed = 0;
  const channel = authorizedChannel({loadPendingAction: async () => ({id: 4, action, created_at: '2026-09-30T10:59:59Z'}),
    consumePendingAction: async () => { consumed++; }, createInvoiceStore: async () => ({}),
    saveInvoice: async () => { saves++; }, clock: () => new Date('2026-09-30T12:00:00Z')});
  const result = await channel.ask({...scope, message: 'confirm'});
  assert.match(result.answer, /expired/i);
  assert.equal(saves, 0);
  assert.equal(consumed, 1);
});

test('bound media extracts and stores a proposal reply', async () => {
  const saved = [];
  const providerOptions = [];
  const values = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientEmail','notes','direction']
    .map(name => [name, {value: ({invoiceNumber:'INV-7',customerName:'Buyer Co',invoiceDate:'2026-09-30',dueDate:'2026-10-30',subtotal:100,tax:0,total:100,outstandingAmount:100,currency:'INR',direction:'receivable'})[name] ?? null, confidence: .99}]));
  const supabase = {from(table) { return {select() { return this; }, eq() { return this; }, async maybeSingle() {
    if (table === 'workspace_ai_settings') return {data: {primary_model: 'gemini-3.5-flash-lite', fallback_model: null}};
    if (table === 'workspace_settings') return {data: {business_name: 'Seller'}};
    throw new Error(table);
  }}; }};
  const handler = createWhatsAppBoundMessageHandler({supabase, providerFactory: options => { providerOptions.push(options); return {}; },
    channelFactory: () => ({ask() { throw new Error('not used'); }}), pendingActionStoreFactory: () => ({storePendingAction: async row => saved.push(row)}),
    extract: async () => ({...values, lineItems: {value: [], confidence: .99}})});
  const answer = await handler({...scope, message: '', media: {bytes: Buffer.from([1]), mimeType: 'image/jpeg', fileName: 'invoice.jpg'}});
  assert.match(answer, /INV-7.*Save it\? Reply yes/s);
  assert.equal(saved[0].source, 'whatsapp');
  assert.equal(providerOptions[0].primaryModel, 'space-bunny-free', 'chat keeps the configured/default conversational model');
  assert.equal(providerOptions[1].primaryModel, 'gemini-3.5-flash-lite', 'media uses the vision extraction model');
});

test('production extraction advances an incomplete OCR draft to vision and proposes a confident invoice', async () => {
  let visionCalls = 0, stored = 0;
  const raw = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientEmail','notes','direction']
    .map(name => [name, {value: ({invoiceNumber:'INV-10',customerName:'Buyer Co',invoiceDate:'2026-10-01',subtotal:100,tax:18,total:118,currency:'INR',direction:'receivable'})[name] ?? null, confidence: .98}]));
  raw.lineItems = {value: [], confidence: .8};
  const provider = {generateStructured: async ({validate}) => { visionCalls++; return {data: validate(invoiceWire(raw)), model: 'vision', usedFallback: false}; }};
  const supabase = {from(table) { return {select() { return this; }, eq() { return this; }, async maybeSingle() {
    if (table === 'workspace_ai_settings') return {data: {primary_model: 'space-bunny-free', fallback_model: null}};
    if (table === 'workspace_settings') return {data: {business_name: 'Seller'}};
    throw new Error(table);
  }}; }};
  const handler = createWhatsAppBoundMessageHandler({supabase, providerFactory: () => provider,
    channelFactory: () => ({ask() { throw new Error('not used'); }}),
    pendingActionStoreFactory: () => ({storePendingAction: async () => { stored++; }}),
    extract: options => extractInvoice({...options, imageExtractor: async () =>
      parseOfflineInvoiceText('Subtotal 100.00\nTax 18.00\nTotal 118.00', {ocrConfidence: 95})})});
  const answer = await handler({...scope, message: '', media: {bytes: Buffer.from([137,80,78,71,13,10,26,10,0]), mimeType: 'image/png'}});
  assert.equal(visionCalls, 1);
  assert.equal(stored, 1);
  assert.match(answer, /INV-10.*Save it\? Reply yes/s);
});

test('incomplete media returns bounded review guidance and stores a continuation draft', async () => {
  let stored = 0, visionCalls = 0;
  const supabase = {from(table) { return {select() { return this; }, eq() { return this; }, async maybeSingle() {
    if (table === 'workspace_ai_settings') return {data: {primary_model: 'space-bunny-free', fallback_model: null}};
    if (table === 'workspace_settings') return {data: {business_name: 'Seller'}};
    throw new Error(table);
  }}; }};
  const incomplete = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientEmail','notes','direction']
    .map(name => [name, {value: null, confidence: 0}]));
  incomplete.direction = {value: 'uncertain', confidence: 0};
  incomplete.lineItems = {value: [], confidence: 0};
  const provider = {generateStructured: async ({validate}) => {
    visionCalls++;
    return {data: validate(invoiceWire(incomplete)), model: 'vision', usedFallback: false};
  }};
  const handler = createWhatsAppBoundMessageHandler({supabase, providerFactory: () => provider,
    channelFactory: () => ({ask: async () => ({answer: 'text reply'})}),
    pendingActionStoreFactory: () => ({storePendingAction: async () => { stored++; }}),
    extract: options => extractInvoice({...options, imageExtractor: async () =>
      parseOfflineInvoiceText('Subtotal 100.00\nTotal 100.00', {ocrConfidence: 92})})});
  const answer = await handler({...scope, message: '', media: {bytes: Buffer.from([137,80,78,71,13,10,26,10,0]),
    mimeType: 'image/png', fileName: 'unclear.png'}});
  assert.match(answer, /invoice number.*explicit currency code.*business issued.*explicitly confirm/i);
  assert.equal(visionCalls, 1);
  assert.equal(stored, 1);
});

test('real bound handler continues a currency-only photo draft before planner and requires a later yes', async () => {
  let row = null, nextId = 1, asks = 0, saves = 0;
  const pending = {
    async storePendingAction(input) { row = {id: nextId++, ...input, created_at: new Date().toISOString()}; },
    async loadPendingAction(input) {
      return row && row.workspaceId === input.workspaceId && row.customerId === input.customerId && row.phone === input.phone ? row : null;
    },
    async consumePendingAction(input) { if (row?.id === input.id) row = null; },
  };
  const supabase = {rpc() {}, from(table) {
    const query = {select() { return query; }, eq() { return query; },
      async maybeSingle() {
        if (table === 'workspace_ai_settings') return {data: {primary_model: 'space-bunny-free', fallback_model: null}};
        if (table === 'workspace_settings') return {data: {business_name: 'Seller', whatsapp_owner_attested_at: '2026-09-30T00:00:00Z'}};
        if (table === 'whatsapp_global_suppressions' || table === 'whatsapp_suppressions') return {data: null};
        if (table === 'whatsapp_consents') return {data: {source: 'verbal', revoked_at: null, categories: ['invoice_updates'], customer_id: scope.customerId}};
        if (table === 'customers') return {data: {id: scope.customerId}};
        throw new Error(table);
      }};
    return query;
  }};
  const values = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientEmail','notes','direction']
    .map(name => [name, {value: ({invoiceNumber:'INV-15',customerName:'Buyer Co',invoiceDate:'2026-09-30',dueDate:'2026-10-30',subtotal:100,tax:0,total:100,outstandingAmount:100,direction:'receivable'})[name] ?? null, confidence: name === 'currency' ? 0 : .99}]));
  const handler = createWhatsAppBoundMessageHandler({supabase, providerFactory: () => ({}),
    pendingActionStoreFactory: () => pending,
    extract: async () => ({...values, lineItems: {value: [{description:'Service',quantity:1,unitPrice:100,amount:100,confidence:.99}], confidence:.99}}),
    channelFactory: ({loadPendingAction, consumePendingAction}) => ({async ask(input) {
      asks++;
      const proposal = await loadPendingAction(input);
      assert.equal(proposal.action.type, 'create_invoice');
      if (/^yes$/i.test(input.message)) { saves++; await consumePendingAction({...input, id: proposal.id}); return {answer: 'saved once'}; }
      return {answer: 'planner'};
    }}), logger: {info() {}, error() {}}});

  const first = await handler({...scope, message: '', messageId: 'wamid.photo', media: {bytes: Buffer.from([1]), mimeType: 'image/jpeg'}});
  assert.match(first, /explicit currency code/i);
  assert.equal(row.action.type, 'invoice_review_draft');
  assert.equal(row.action.fields.invoiceNumber.value, 'INV-15');
  assert.equal(row.action.origin.messageId, 'wamid.photo');

  const proposal = await handler({...scope, message: 'usd', messageId: 'wamid.usd'});
  assert.match(proposal, /INV-15.*USD \(provided by you\) 100.*Reply yes/s);
  assert.equal(row.action.type, 'create_invoice');
  assert.equal(asks, 0, 'currency clarification must not reach the planner or save');
  assert.equal(saves, 0);

  assert.equal(await handler({...scope, message: 'yes', messageId: 'wamid.yes'}), 'saved once');
  assert.equal(saves, 1);
  assert.equal(row, null);
});

test('incomplete draft rejects bare yes and owner claims without a planner or save', async () => {
  let asks = 0, row;
  const pending = {async storePendingAction(input) { row = {id: 1, ...input, created_at: new Date().toISOString()}; },
    async loadPendingAction() { return row; }, async consumePendingAction() { row = null; }};
  const supabase = {rpc() {}, from(table) { const query = {select() { return query; }, eq() { return query; }, async maybeSingle() {
    if (table === 'workspace_ai_settings') return {data: {primary_model: 'space-bunny-free'}};
    if (table === 'workspace_settings') return {data: {business_name: 'Seller', whatsapp_owner_attested_at: '2026-09-30T00:00:00Z'}};
    if (table === 'whatsapp_global_suppressions' || table === 'whatsapp_suppressions') return {data: null};
    if (table === 'whatsapp_consents') return {data: {source:'verbal', revoked_at:null, categories:['invoice_updates'], customer_id:scope.customerId}};
    if (table === 'customers') return {data:{id:scope.customerId}};
    throw new Error(table);
  }}; return query; }};
  const incomplete = Object.fromEntries(['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientPhone','clientEmail','notes','direction']
    .map(name => [name, {value: null, confidence: 0}]));
  incomplete.direction = {value:'uncertain',confidence:0};
  const handler = createWhatsAppBoundMessageHandler({supabase, providerFactory:()=>({}), pendingActionStoreFactory:()=>pending,
    extract:async()=>({...incomplete,lineItems:{value:[],confidence:0}}),
    channelFactory:()=>({async ask(){asks++;return{answer:'balances'};}}), logger:{info(){},error(){}}});
  await handler({...scope,message:'',media:{bytes:Buffer.from([1]),mimeType:'image/jpeg'}});
  assert.match(await handler({...scope,message:'yes'}), /cannot save an incomplete review/i);
  assert.match(await handler({...scope,message:"I'm the business owner"}), /does not grant owner access/i);
  assert.equal(asks, 0);
  assert.equal(row.action.type, 'invoice_review_draft');
});

test('Vercel traces OCR assets into both WhatsApp functions', async () => {
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const route of ['api/whatsapp.js', 'api/whatsapp-process.js']) {
    assert.match(config.functions[route].includeFiles, /traineddata/);
    assert.match(config.functions[route].includeFiles, /wasm/);
    assert.equal(config.functions[route].maxDuration, 60);
  }
});
