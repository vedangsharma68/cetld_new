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

test('combative and elliptical follow-ups never hit the planner failure message', async () => {
  for (const message of ['no you are not', 'stop lying', 'again']) {
    let calls = 0;
    const result = await answerWorkspaceQuestion({provider:{generate:async()=>{calls++;throw Error('not expected');}},store,message,history:[{role:'assistant',content:"I'm the Cetld assistant."}]});
    assert.equal(calls,0);
    assert.doesNotMatch(result.answer,/couldn.t safely check/i);
    assert.match(result.answer,/Cetld assistant|context|try again/i);
  }
});

test('identity and model questions get the designed answer without calling a provider', async () => {
  for (const message of ['Who are you?', 'who are u', 'Which model are you?', 'What can you do?', 'What is Cetld assistant?']) {
    let calls = 0;
    const result = await answerWorkspaceQuestion({provider:{generate:async()=>{ calls++; throw Error('not expected'); }},store,message});
    assert.equal(calls, 0);
    assert.match(result.answer, /^I'm the Cetld assistant/);
    assert.match(result.answer, /what's overdue, who owes the most, or what got paid this week/i);
    assert.doesNotMatch(result.answer, /GPT|Gemini|Claude|model|provider/i);
  }
});

test('general chit-chat gets the friendly scope answer without calling a provider', async () => {
  for (const message of ['Tell me a joke', 'What is the capital of France?', 'How is the weather?']) {
    let calls = 0;
    const result = await answerWorkspaceQuestion({provider:{generate:async()=>{ calls++; throw Error('not expected'); }},store,message});
    assert.equal(calls, 0);
    assert.match(result.answer, /Cetld workspace.*invoices, payments, customers, and balances/i);
  }
});

test('short acknowledgements, including ok then, are answered without planner or tool calls', async () => {
  for (const message of ['ok then', 'okay then', 'ok', 'okay', 'alright', 'all right', 'yep', 'yup', 'got it', 'understood', 'noted', 'thanks', 'thank you', 'sounds good', 'no problem']) {
    let calls = 0;
    const result = await answerWorkspaceQuestion({
      provider: {generate: async () => { calls++; throw new Error('an acknowledgement must not need the model'); }},
      store,
      message,
    });
    assert.equal(calls, 0, `${message} should be answered without the model`);
    assert.match(result.answer, /(?:okay|alright|welcome|here if you need)/i, `${message} should get a natural conversational reply`);
    assert.equal(result.evidence.source, 'Cetld workspace');
    assert.deepEqual(result.evidence.records, []);
  }
});

test('recognized non-financial prompts get a safe scope reply when the planner returns no tool call', async () => {
  const result = await answerWorkspaceQuestion({
    provider:{generate:async()=>({content:'A joke from the model.',toolCalls:[]})},
    store,
    message:'Tell me a joke',
  });
  assert.match(result.answer, /invoices, payments, customers, and balances/i);
  assert.doesNotMatch(result.answer, /A joke from the model|INVALID_ASSISTANT_PLAN/);
  assert.equal(result.model, null);
  assert.equal(result.evidence.complete, true);
});

test('simple outstanding question reads the ledger without a model plan', async () => {
  const result = await answerWorkspaceQuestion({provider:{generate:async()=>({content:'Here is a guess.'})},store,message:'What is outstanding?'});
  assert.match(result.answer, /INR 84600\.00/);
  assert.doesNotMatch(result.answer, /guess|couldn.t safely check/i);
  assert.equal(result.evidence.complete, true);
  assert.deepEqual(result.evidence.records, []);
});

test('model plans cannot derail a simple overdue question', async () => {
  for (const plan of [
    {toolCalls:[null]},
    {toolCalls:[{function:{name:'unknownTool',arguments:'{}'}}]},
    {toolCalls:[{function:{name:'getOverdueInvoices',arguments:'not-json'}}]},
  ]) {
    const result = await answerWorkspaceQuestion({provider:{generate:async()=>plan},store,message:'List overdue invoices'});
    assert.match(result.answer, /There aren't any overdue invoices/i);
    assert.doesNotMatch(result.answer, /TOOL_NOT_ALLOWED|INVALID_TOOL_ARGUMENTS|INVALID_ASSISTANT_PLAN/);
    assert.equal(result.evidence.complete, true);
    assert.deepEqual(result.evidence.records, []);
  }
});

test('simple ledger reads return checked facts without calling the provider', async () => {
  const emptyStore={query:async()=>[]};
  for (const [message, expected] of [
    ['Which invoices are overdue?', /There aren't any overdue invoices/],
    ['What payments were recorded?', /There are no recorded payments/],
    ['What happened recently?', /no recorded invoice or payment activity/],
  ]) {
    const result=await answerWorkspaceQuestion({provider:{generate:async()=>{throw Error('provider unavailable');}},store:emptyStore,message});
    assert.match(result.answer,expected);
    assert.equal(result.usedFallback,false);
    assert.doesNotMatch(result.answer,/couldn.t safely check/i);
  }
});

test('invalid invoice proposal planning never implies that an invoice was created or changed', async () => {
  const result = await answerWorkspaceQuestion({
    provider:{generate:async()=>({toolCalls:[]})},
    store,
    accounting:{readZohoData:async()=>({records:[]})},
    message:'Create an invoice for Arbor & Finch',
  });
  assert.match(result.answer, /couldn’t safely prepare that invoice request/i);
  assert.match(result.answer, /No change was made/i);
  assert.equal(result.pendingAction, null);
  assert.equal(result.evidence.complete, false);
});

test('final answer guidance favors brief direct answers and preserves financial caveats', async () => {
  const provider = plannedProvider('getOutstandingSummary');
  await answerWorkspaceQuestion({provider, store, message: 'Explain what is outstanding and what I should do next.' });
  const request = provider.requests.find(item => !item.tools);
  const guidance = request.messages.find(item => item.role === 'system').content;

  assert.match(guidance, /1[-–]3 short sentences/i);
  assert.match(guidance, /short paragraph|compact bullet/i);
  assert.match(guidance, /exact amounts and currencies/i);
  assert.match(guidance, /partial|incomplete/i);
  assert.match(guidance, /direction|receivable|payable/i);
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
  const result = await answerWorkspaceQuestion({provider, store, message: 'Explain what is outstanding and what I should do next.'});
  assert.match(result.answer, /^Unpaid balances total INR 84600\.00 right now\./);
  assert.match(result.answer, /Some invoices need a quick review before these numbers are final\.$/);
  assert.doesNotMatch(result.answer, /Arbor & Finch owes/);
  assert.doesNotMatch(result.answer, /basis|currencies|debtors|invoiceCount/);
  assert.equal(Object.hasOwn(result, 'sources'), false);
});

test('genuine planner failures keep the retry answer and emit a safe classified warning', async () => {
  const warnings=[];
  const original=console.warn;
  console.warn=(message,details)=>warnings.push({message,details});
  try {
    const result=await answerWorkspaceQuestion({provider:{generate:async()=>({toolCalls:[],model:'planner-fixture'})},store,message:'Show recent collection activity for the last fortnight'});
    assert.match(result.answer,/Please try again/i);
    assert.equal(warnings.length,1);
    assert.deepEqual(warnings[0].details,{provider:'Object',model:'planner-fixture',status:'missing_or_multiple_tool_calls',reason:'missing_or_multiple_tool_calls'});
    assert.doesNotMatch(JSON.stringify(warnings),/collection activity|fortnight/i);
  } finally { console.warn=original; }
});

test('generic overdue invoice questions read the ledger without planning or a false invoice target', async () => {
  for (const message of ['Which invoice is overdue?','Which invoices are overdue?']) {
    const provider = {generate:async()=>{throw Error('No model call expected');}};
    const lookups=[];
    const trackingStore={query:async(table,options)=>{lookups.push({table,filters:options?.filters||{}});return store.query(table,options)}};
    await answerWorkspaceQuestion({provider,store:trackingStore,message});
    assert.ok(lookups.some(call=>call.table==='invoices'));
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
