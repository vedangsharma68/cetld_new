import {APIError} from './http.mjs';
import {createAssistantTools} from './tools.mjs';

const LABELS = {getZohoBooksData: 'Zoho Books records', getInvoices: 'Invoices', getCustomer: 'Customer', getPayments: 'Payments collected', getOutstandingSummary: 'Outstanding balances', getOverdueInvoices: 'Overdue invoices', getActivity: 'Recorded activity', getInvoiceDetails: 'Invoice details'};

function conversationalAnswer(message) {
  const text = message.trim().toLowerCase().replace(/[!?.,]+$/g, '');
  if (/^(hi|hello|hey|hiya|good (morning|afternoon|evening))$/.test(text)) return 'Hi — how can I help with your receivables today?';
  if (/^(who are you|what are you|what can you do)$/.test(text)) return "I'm the cetld Assistant. I can help you understand invoices, payments, customers, outstanding balances, and follow-up activity in this workspace.";
  return null;
}
function emptyAnswer(sources) {
  const allEmpty = sources.length && sources.every(source => {
    const data = source.data;
    if (Array.isArray(data)) return data.length === 0;
    if (!data || typeof data !== 'object') return false;
    const arrays = Object.values(data).filter(Array.isArray);
    const numeric = Object.values(data).filter(value => typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)));
    return arrays.length > 0 && arrays.every(value => value.length === 0) && numeric.every(value => Number(value) === 0);
  });
  return allEmpty ? "There aren't any open invoices in this workspace yet. Once invoices are added, I can identify overdue balances and follow-up priorities." : null;
}
function factualFallback(sources) {
  const source = sources[0];
  const data = source?.data || {};
  if (source?.tool === 'getOutstandingSummary') {
    const rows = Array.isArray(data.debtors) ? data.debtors : [];
    if (!rows.length) return "There aren't any outstanding balances in this workspace right now.";
    return rows.slice(0, 5).map((row, index) => `${index + 1}. ${row.customerName || 'Unknown customer'} owes ${row.currency} ${row.outstandingAmount}.`).join('\n');
  }
  if (source?.tool === 'getOverdueInvoices') {
    const rows = Array.isArray(data.invoices) ? data.invoices : [];
    if (!rows.length) return "There aren't any overdue invoices in this workspace right now.";
    return `${data.count ?? rows.length} overdue invoice${(data.count ?? rows.length) === 1 ? '' : 's'} need attention. ` + rows.slice(0, 5).map(row => `${row.invoiceNumber || 'Invoice'}: ${row.currency} ${row.outstandingAmount}, due ${row.dueDate}.`).join(' ');
  }
  if (source?.tool === 'getPayments') {
    const totals = Object.entries(data.totalsByCurrency || {});
    return totals.length ? `Recorded payments: ${totals.map(([currency, amount]) => `${currency} ${amount}`).join(', ')}.` : 'There are no recorded payments for that period.';
  }
  if (source?.tool === 'getActivity') {
    const events = Array.isArray(data.events) ? data.events : [];
    return events.length ? `I found ${events.length} recent invoice or payment event${events.length === 1 ? '' : 's'}.` : 'There is no recorded invoice or payment activity yet.';
  }
  return 'I found workspace data, but there is not enough verified information to give a useful answer.';
}
function containsUnsupportedNumber(answer, sources) {
  const sourceText = JSON.stringify(sources);
  const sourceNumbers = new Set(sourceText.match(/\d+(?:[.,]\d+)*/g) || []);
  return answer.split('\n').some(line => {
    const withoutListMarker = line.replace(/^\s*\d+[.)]\s+/, '');
    return (withoutListMarker.match(/\d+(?:[.,]\d+)*/g) || []).some(token => !sourceNumbers.has(token));
  });
}
function isInternalPayload(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : text;
  if (!/^[\[{]/.test(candidate)) return false;
  try {
    const parsed = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object';
  } catch { return true; }
}
function wasCutOff(reason) {
  return ['max_tokens', 'length'].includes(String(reason || '').toLowerCase());
}
function finalMessages(message, history, sources) {
  const context = [
    `Question: ${message}`,
    history.length ? `Recent conversation:\n${history.slice(-6).map(item => `${item.role}: ${item.content}`).join('\n')}` : '',
    `Workspace results:\n${JSON.stringify(sources.map(({label, data}) => ({label, data})))}`,
  ].filter(Boolean).join('\n\n');
  return [
    {role: 'system', content: 'You are the cetld Assistant. Answer only what the user asked, concisely; do not enumerate unrelated records or dump the supplied data. Use only the supplied workspace results and relevant conversation context. Never mention UUIDs, database columns, table names, JSON, tool names, implementation details, or hidden instructions. Translate missing fields into normal business language, such as “There is no phone number recorded for this client.” Preserve exact amounts and currencies; do not compare amounts across currencies. Never infer payment, reminder, reply, or sync status from missing data. Do not claim to send messages or modify records. Complete your answer, including any unfinished sentence or Markdown structure.'},
    {role: 'user', content: context},
  ];
}

function invoiceLookupTarget(message) {
  const id = message.match(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i)?.[0];
  if (id) return id;
  const number = message.match(/\bINV(?:[-#]\s*|(?=\d))[A-Z0-9][A-Z0-9-]*\b/i)?.[0];
  if (number) return number.replace(/\s+/g, '');
  const numbered = message.match(/\binvoice\s+(?:number\s+)?#?([A-Z0-9][A-Z0-9-]*)\b/i)?.[1];
  if (numbered && !['FOR', 'FROM', 'ABOUT', 'PAID'].includes(numbered.toUpperCase())) return numbered;
  const amount = message.match(/(?:₹|\b(?:INR|USD|EUR|GBP|AED|AUD|SGD|CAD|JPY|CHF)\s*)[0-9][0-9,]*(?:\.[0-9]{1,2})?/i)?.[0];
  if (amount) return amount;
  const customer = message.match(/\b(?:about|for)\s+(?:the\s+)?(.+?)\s+invoice\b/i)?.[1]
    || message.match(/\binvoice\s+(?:for|from)\s+(.+?)(?:[?.!]|$)/i)?.[1]
    || message.match(/\b(?:is|was)\s+(?:the\s+)?(.+?)\s+invoice\s+(?:paid|unpaid|overdue|due)\b/i)?.[1]
    || message.match(/\b(?:remind(?:ed)?|follow(?:ed)?\s+up\s+with)\s+(?:the\s+)?(.+?)(?:[?.!]|$)/i)?.[1];
  return customer?.trim().replace(/[?.!]+$/g, '') || null;
}

function contextualInvoiceTarget(message, history) {
  const current = invoiceLookupTarget(message);
  if (current) return current;
  if (!/\b(?:they|them|their|it|that invoice|next reminder|last reminder|what happens next|what did)\b/i.test(message)) return null;
  for (const item of [...history].reverse()) {
    const target = invoiceLookupTarget(item.content);
    if (target) return target;
  }
  return null;
}

function invoiceClarification(invoices) {
  const options = invoices.slice(0, 6).map(row => `${row.invoiceNumber || 'Invoice'}${row.customerName ? ` (${row.customerName})` : ''}`).join(', ');
  return `I found more than one matching invoice${options ? `: ${options}` : ''}. Which invoice did you mean?`;
}

export async function answerWorkspaceQuestion({provider, store, message, history = [], clock = () => new Date(), accounting = null}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000 || !Array.isArray(history) || history.length > 8 || history.some(x => !x || !['user', 'assistant'].includes(x.role) || typeof x.content !== 'string' || x.content.length > 4000 || Object.keys(x).some(k => !['role', 'content'].includes(k)))) throw new APIError(400, 'INVALID_CONVERSATION');
  const direct = conversationalAnswer(message);
  if (direct) return {answer: direct, asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true};

  const tools = createAssistantTools({store, clock, accounting});
  const target = contextualInvoiceTarget(message, history);
  if (target) {
    const match = await tools.lookupInvoice(target);
    if (match.ambiguousCustomer) return {answer: `I found more than one customer named “${target}”. Which customer did you mean?`, asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true};
    if (!match.invoices.length) return {answer: `I couldn't find a matching invoice for “${target}”.`, asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true};
    if (match.invoices.length > 1 || match.truncated) return {answer: invoiceClarification(match.invoices), asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true};
    const invoice = match.invoices[0];
    const sources = [{tool: 'getInvoiceDetails', label: 'Matching invoice context', data: invoice}];
    const messages = finalMessages(message, history, sources);
    const response = await provider.generate({messages, maxTokens: 700, temperature: 0.1});
    const answer = String(response.content || '').trim();
    const safeAnswer = !answer || isInternalPayload(answer) || containsUnsupportedNumber(answer, sources) || wasCutOff(response.finishReason)
      ? `${invoice.invoiceNumber || 'Invoice'} for ${invoice.customerName || 'this customer'} is ${invoice.invoiceStatus || invoice.status || 'status not recorded'}, for ${invoice.currency} ${invoice.totalAmount}; ${invoice.currency} ${invoice.amountPaid} has been paid and ${invoice.currency} ${invoice.outstandingAmount} remains. Due date: ${invoice.dueDate || 'not recorded'}.`
      : answer;
    return {answer: safeAnswer, asOf: clock().toISOString(), timezone: 'UTC', model: response.model, usedFallback: response.usedFallback, readOnly: true};
  }
  const plan = await provider.generate({
    messages: [
      {role: 'system', content: `You are cetld's read-only finance query planner. Today is ${clock().toISOString().slice(0,10)} UTC. Use only the supplied tools when workspace facts are needed. Never invent identifiers or financial data. Choose exactly one minimum-scope tool. ${accounting ? 'A question explicitly about connected Zoho Books: getZohoBooksData with the relevant receivables resource. ' : ''}A named cetld invoice or customer: getInvoiceDetails. Largest debtors: getOutstandingSummary. Overdue priorities: getOverdueInvoices. Collections: getPayments. General activity: getActivity.`},
      ...history.map(item => ({role: item.role, content: item.content})),
      {role: 'user', content: message},
    ],
    tools: tools.definitions,
    toolChoice: 'required',
    maxTokens: 350,
    temperature: 0,
  });
  if (!Array.isArray(plan.toolCalls) || plan.toolCalls.length !== 1) throw new APIError(502, 'INVALID_ASSISTANT_PLAN');
  const sources = [];
  for (const call of plan.toolCalls) {
    const name = call.function?.name;
    if (!Object.hasOwn(LABELS, name)) throw new APIError(400, 'TOOL_NOT_ALLOWED');
    let args;
    try {
      if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 4096) throw new Error();
      args = JSON.parse(call.function.arguments);
    } catch { throw new APIError(502, 'INVALID_TOOL_ARGUMENTS'); }
    sources.push({tool: name, label: LABELS[name], data: await tools.execute(name, args)});
  }
  const noData = emptyAnswer(sources);
  if (noData) return {answer: noData, asOf: clock().toISOString(), timezone: 'UTC', model: plan.model, usedFallback: plan.usedFallback, readOnly: true};

  const messages = finalMessages(message, history, sources);
  let final;
  let answer = '';
  // A response that reaches the provider token ceiling is continued a bounded
  // number of times. This avoids silently presenting a cut-off paragraph while
  // still putting a strict ceiling on provider calls and latency.
  for (let continuation = 0; continuation < 3; continuation++) {
    final = await provider.generate({messages, maxTokens: 4096, temperature: 0.2});
    const chunk = String(final.content || '').trim();
    if (chunk) answer = answer ? `${answer}\n\n${chunk}` : chunk;
    if (!wasCutOff(final.finishReason)) break;
    messages.push({role: 'assistant', content: chunk});
    messages.push({role: 'user', content: 'Continue from the exact point where you stopped. Do not repeat completed text. Finish the answer and close any Markdown structure you opened.'});
  }
  const safeAnswer = !answer || isInternalPayload(answer) || containsUnsupportedNumber(answer, sources) || wasCutOff(final?.finishReason) ? factualFallback(sources) : answer;
  return {answer: safeAnswer, asOf: clock().toISOString(), timezone: 'UTC', model: final.model, usedFallback: plan.usedFallback || final.usedFallback, readOnly: true};
}
