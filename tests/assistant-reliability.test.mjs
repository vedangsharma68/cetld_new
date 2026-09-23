import test from 'node:test';
import assert from 'node:assert/strict';
import {answerWorkspaceQuestion} from '../ai/assistant.mjs';

const invoiceId = '22222222-2222-4222-8222-222222222222';
const customerId = '11111111-1111-4111-8111-111111111111';
const invoice = {id: invoiceId, customer_id: customerId, invoice_number: 'INV-1048', issue_date: '2026-09-01', due_date: '2026-10-01', currency: 'INR', total_amount: '84600.00', amount_paid: '0.00', status: 'sent', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z'};
const store = {query: async table => table === 'invoices' ? [invoice] : [{id: customerId, name: 'Arbor & Finch'}]};
const toolPlan = {toolCalls: [{function: {name: 'getOutstandingSummary', arguments: '{}'}}], model: 'test-model', usedFallback: false};

test('short conversational questions return immediately without planning tools', async () => {
  let calls = 0;
  const result = await answerWorkspaceQuestion({provider: {generate: async () => { calls++; throw new Error('unexpected model call'); }}, store, message: 'hi'});
  assert.match(result.answer, /^Hi/);
  assert.equal(calls, 0);
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
