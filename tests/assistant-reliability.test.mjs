import test from 'node:test';
import assert from 'node:assert/strict';
import {answerWorkspaceQuestion} from '../ai/assistant.mjs';

const invoiceId = '22222222-2222-4222-8222-222222222222';
const customerId = '11111111-1111-4111-8111-111111111111';
const invoice = {id: invoiceId, customer_id: customerId, invoice_number: 'INV-1048', issue_date: '2026-09-01', due_date: '2026-10-01', currency: 'INR', total_amount: '84600.00', amount_paid: '0.00', status: 'sent', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z'};
const store = {query: async (table, {filters={}}={}) => {
  const rows = table === 'invoices' ? [invoice] : [{id: customerId, name: 'Arbor & Finch', company_name:'Arbor & Finch'}];
  return rows.filter(row=>Object.entries(filters).every(([key,expr])=>{const [op,...parts]=expr.split('.');return op==='eq'?String(row[key])===parts.join('.'):op==='ilike'?String(row[key]||'').toLowerCase()===parts.join('.').toLowerCase():false}));
}};
const toolPlan = {toolCalls: [{function: {name: 'getOutstandingSummary', arguments: '{}'}}], model: 'test-model', usedFallback: false};

function plannedProvider(name, args = {}) {
  const requests = [];
  return {
    requests,
    async generate(request) {
      requests.push(request);
      if (request.tools) return {toolCalls:[{function:{name,arguments:JSON.stringify(args)}}],model:'test-model',usedFallback:false};
      return {content:'I checked the workspace records.',finishReason:'STOP',model:'test-model',usedFallback:false};
    },
  };
}

test('short conversational questions return immediately without planning tools', async () => {
  let calls = 0;
  const result = await answerWorkspaceQuestion({provider: {generate: async () => { calls++; throw new Error('unexpected model call'); }}, store, message: 'hi'});
  assert.match(result.answer, /^Hi/);
  assert.equal(calls, 0);
});

test('invoice questions bypass workspace-wide planning and give the model only the exact match', async () => {
  let call;
  const result = await answerWorkspaceQuestion({provider:{generate:async request=>{call=request;return {content:'INV-1048 for Arbor & Finch is INR 84600.00 and unpaid.',model:'test-model',usedFallback:false,finishReason:'STOP'}}},store,message:'tell me about the Arbor & Finch invoice'});
  assert.match(result.answer,/INV-1048/);
  assert.equal(call.messages.some(item=>item.content.includes('getOutstandingSummary')),false);
  assert.match(call.messages.at(-1).content,/INV-1048/);
  assert.doesNotMatch(call.messages.at(-1).content,/other invoice/);
});

test('multiple invoices for a matching customer trigger clarification without an AI call', async () => {
  const other = {...invoice,id:'33333333-3333-4333-8333-333333333333',invoice_number:'INV-1049'};
  const matchingStore = {query:async(table,{filters={}}={})=>{
    const rows=table==='invoices'?[invoice,other]:[{id:customerId,name:'Arbor & Finch',company_name:'Arbor & Finch'}];
    return rows.filter(row=>Object.entries(filters).every(([key,expr])=>{const [op,...parts]=expr.split('.');const value=parts.join('.');return op==='eq'?String(row[key])===value:op==='ilike'?String(row[key]||'').toLowerCase()===value.toLowerCase():false}));
  }};
  let calls=0;
  const result=await answerWorkspaceQuestion({provider:{generate:async()=>{calls++;throw Error('should not call model')}},store:matchingStore,message:'tell me about the Arbor & Finch invoice'});
  assert.match(result.answer,/Which invoice did you mean/);
  assert.match(result.answer,/INV-1048/);
  assert.equal(calls,0);
});

test('long Assistant answers continue boundedly when the provider reports truncation', async () => {
  const chunks = [];
  const longText = 'A complete, verified explanation. '.repeat(350);
  let call = 0;
  const provider = {generate: async request => {
    if (call++ === 0) return toolPlan;
    chunks.push(request);
    return call === 2
      ? {content: longText.slice(0, 5000), finishReason: 'MAX_TOKENS', model: 'test-model', usedFallback: false}
      : {content: longText.slice(5000), finishReason: 'STOP', model: 'test-model', usedFallback: false};
  }};
  const result = await answerWorkspaceQuestion({provider, store, message: 'Explain what is outstanding and what I should do next.'});
  assert.equal(call, 3);
  assert.equal(chunks[0].maxTokens, 4096);
  assert.ok(chunks[1].messages.some(item => item.role === 'assistant'));
  assert.equal(result.answer.replace(/\s/g, ''), longText.replace(/\s/g, ''));
});

test('internal JSON and fenced tool payloads are replaced with factual user-facing prose', async () => {
  const provider = {generate: async () => provider.calls++ === 0 ? toolPlan : {
    content: '```json\n{"basis":"invoices.amount_paid","currencies":{"INR":{"invoiceCount":1}},"debtors":[{"customerName":"Arbor & Finch","outstandingAmount":"84600.00"}]}\n```',
    finishReason: 'STOP', model: 'test-model', usedFallback: false,
  }, calls: 0};
  const result = await answerWorkspaceQuestion({provider, store, message: 'Who owes us the most?'});
  assert.match(result.answer, /Arbor & Finch owes INR 84600\.00/);
  assert.doesNotMatch(result.answer, /basis|currencies|debtors|invoiceCount/);
  assert.equal(Object.hasOwn(result, 'sources'), false);
});

test('generic overdue and paid invoice questions reach the planner instead of looking up "is" or "was"', async () => {
  for (const [message, toolName, args] of [
    ['Which invoice is overdue?', 'getOverdueInvoices', {}],
    ['What invoice was paid?', 'getInvoices', {status:'paid'}],
  ]) {
    const provider = plannedProvider(toolName, args);
    const lookups=[];
    const trackingStore={query:async(table,options)=>{lookups.push({table,filters:options?.filters||{}});return store.query(table,options)}};
    await answerWorkspaceQuestion({provider,store:trackingStore,message});
    assert.ok(provider.requests[0].tools, `${message} should be planned`);
    assert.equal(provider.requests[0].tools.find(tool=>tool.function.name===toolName)?.function.name,toolName);
    assert.ok(!lookups.some(call=>call.table==='invoices'&&['is','was'].includes(call.filters.invoice_number?.replace(/^ilike\./,''))));
  }
});

test('empty overdue, payments, and activity results use distinct accurate answers', async () => {
  const emptyStore = {query:async()=>[]};
  const cases = [
    ['getOverdueInvoices','Which invoices are overdue?','There aren\'t any overdue invoices in this workspace right now.'],
    ['getPayments','What payments were recorded?','There are no recorded payments for that period.'],
    ['getActivity','What happened recently?','There is no recorded invoice or payment activity yet.'],
  ];
  for (const [name,message,expected] of cases) {
    const result=await answerWorkspaceQuestion({provider:plannedProvider(name),store:emptyStore,message});
    assert.equal(result.answer,expected);
  }
});

test('explicit Zoho questions fail clearly without consulting the local ledger when Zoho is unavailable', async () => {
  let providerCalls=0,storeCalls=0;
  const result=await answerWorkspaceQuestion({
    provider:{generate:async()=>{providerCalls++;return toolPlan;}},
    store:{query:async()=>{storeCalls++;return []; }},
    message:'Which invoice is overdue in Zoho Books?',
  });
  assert.match(result.answer,/Zoho Books.*(?:unavailable|not connected|disconnected)/i);
  assert.equal(providerCalls,0);
  assert.equal(storeCalls,0);
});

test('evidence returns safe invoice references, freshness, and completeness without internal identifiers', async () => {
  const fixedClock=()=>new Date('2026-09-25T09:30:00.000Z');
  const overdue={...invoice,due_date:'2026-09-01',metadata:{private_note:'hidden'}};
  const scoped={query:async(table,{filters={}}={})=>{
    const rows=table==='invoices'?[overdue]:[{id:customerId,name:'Arbor & Finch',company_name:'Arbor & Finch'}];
    return rows.filter(row=>Object.entries(filters).every(([key,expr])=>{const [op,...parts]=expr.split('.');return op==='eq'?String(row[key])===parts.join('.'):false}));
  }};
  const result=await answerWorkspaceQuestion({provider:plannedProvider('getOverdueInvoices'),store:scoped,message:'Which invoice is overdue?',clock:fixedClock});
  assert.deepEqual(result.evidence,{
    source:'Cetld workspace',
    asOf:'2026-09-25T09:30:00.000Z',
    complete:true,
    truncated:false,
    records:[{type:'invoice',label:'INV-1048',reference:'invoice:INV-1048'}],
  });
  assert.doesNotMatch(JSON.stringify(result.evidence),/workspace_id|customer_id|metadata|tool|11111111|22222222/i);
});

test('a supported invoice total cannot validate a false fully-paid claim and internal IDs stay out of model context', async () => {
  const requests=[];
  const namedInvoice={...invoice,status:'sent',amount_paid:'0.00',total_amount:'84600.00',metadata:{private_note:'no internal ids'}};
  const namedStore={query:async(table)=>{
    if(table==='invoices')return [namedInvoice];
    if(table==='customers')return [{id:customerId,name:'Arbor & Finch',company_name:'Arbor & Finch'}];
    if(table==='payments'||table==='invoice_files')return [];
    return [];
  }};
  const result=await answerWorkspaceQuestion({provider:{generate:async request=>{
    requests.push(request);
    return {content:'INV-1048 for Arbor & Finch is fully paid. Total: INR 84600.00; paid: INR 0.00.',finishReason:'STOP',model:'fixture-model',usedFallback:false};
  }},store:namedStore,message:'Tell me about INV-1048'});
  assert.doesNotMatch(result.answer,/fully paid/i);
  assert.match(result.answer,/unpaid|sent/i);
  assert.match(result.answer,/84600\.00/);
  assert.doesNotMatch(requests[0].messages.at(-1).content,/11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222/);
  assert.doesNotMatch(result.answer,/11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222/);
});

test('UUIDs echoed by the model are blocked while safe invoice evidence remains linkable', async () => {
  const requests=[];
  const namedStore={query:async(table)=>{
    if(table==='invoices')return [invoice];
    if(table==='customers')return [{id:customerId,name:'Arbor & Finch',company_name:'Arbor & Finch'}];
    return [];
  }};
  const result=await answerWorkspaceQuestion({provider:{generate:async request=>{
    requests.push(request);
    return {content:`Internal row ${invoiceId} for customer ${customerId}.`,finishReason:'STOP',model:'fixture-model',usedFallback:false};
  }},store:namedStore,message:'Tell me about INV-1048'});
  assert.doesNotMatch(result.answer,/11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222/);
  assert.match(result.answer,/unpaid/);
  assert.deepEqual(result.evidence.records,[{type:'invoice',label:'INV-1048',reference:'invoice:INV-1048'}]);
  assert.doesNotMatch(requests[0].messages.at(-1).content,/11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222/);
});
