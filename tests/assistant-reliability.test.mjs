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
