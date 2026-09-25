import {APIError} from './http.mjs';
import {createAssistantTools} from './tools.mjs';
import {randomUUID} from 'node:crypto';
import {AMOUNT_PRECISION_MESSAGE,CURRENCY_SUPPORT_MESSAGE,SUPPORTED_TWO_DECIMAL_CURRENCIES,isSupportedCurrency} from '../currency-contract.mjs';

const createProposalTool = {type:'function',function:{name:'proposeCreateInvoice',description:'Prepare, but do not execute, a proposed Zoho Books invoice. Only include details explicitly supplied by the user. Return ISO dates. Never invent an invoice number, due date, customer, amount, or currency. CETLD supports only its listed two-decimal currencies.',parameters:{type:'object',properties:{invoiceNumber:{type:'string',maxLength:100},clientName:{type:'string',maxLength:255},clientEmail:{type:'string',maxLength:320},clientPhone:{type:'string',maxLength:40},invoiceDate:{type:'string',format:'date'},dueDate:{type:'string',format:'date'},total:{type:'number',minimum:0.01},subtotal:{type:'number',minimum:0},tax:{type:'number',minimum:0},currency:{type:'string',enum:SUPPORTED_TWO_DECIMAL_CURRENCIES},notes:{type:'string',maxLength:2000}},required:['clientName','total','currency'],additionalProperties:false}}};
const updateProposalTool = {type:'function',function:{name:'proposeUpdateInvoice',description:'Prepare, but do not execute, a proposed update to one exact Zoho Books invoice. Only include the changed values explicitly requested by the user.',parameters:{type:'object',properties:{target:{type:'string',minLength:1,maxLength:100},changes:{type:'object',properties:{dueDate:{type:'string',format:'date'},invoiceDate:{type:'string',format:'date'},notes:{type:'string',maxLength:2000}},additionalProperties:false}},required:['target','changes'],additionalProperties:false}}};

const LABELS = {getZohoBooksData: 'Zoho Books records', getInvoices: 'Invoices', getCustomer: 'Customer', getPayments: 'Payments collected', getOutstandingSummary: 'Outstanding balances', getOverdueInvoices: 'Overdue invoices', getActivity: 'Recorded activity', getInvoiceDetails: 'Invoice details'};

function conversationalAnswer(message) {
  const text = message.trim().toLowerCase().replace(/[!?.,]+$/g, '');
  if (/^(hi|hello|hey|hiya|good (morning|afternoon|evening))$/.test(text)) return 'Hi — how can I help with your receivables today?';
  if (/^(who are you|what are you|what can you do)$/.test(text)) return "I'm the cetld Assistant. I can help you understand invoices, payments, customers, outstanding balances, and follow-up activity in this workspace.";
  return null;
}
function emptyAnswer(source) {
  const data = source?.data;
  switch (source?.tool) {
    case 'getOutstandingSummary':
      return !data?.debtorCount && !(data?.debtors?.length) ? "There aren't any outstanding balances in this workspace right now." : null;
    case 'getOverdueInvoices':
      return !data?.count && !(data?.invoices?.length) ? "There aren't any overdue invoices in this workspace right now." : null;
    case 'getPayments':
      return !data?.count && !(data?.payments?.length) ? 'There are no recorded payments for that period.' : null;
    case 'getActivity':
      return !(data?.events?.length) ? 'There is no recorded invoice or payment activity yet.' : null;
    case 'getInvoices':
      return Array.isArray(data) && !data.length ? "I couldn't find invoices matching those filters." : null;
    case 'getCustomer':
      return !data ? "I couldn't find that customer in this workspace." : null;
    case 'getInvoiceDetails':
      return !data?.invoices?.length ? "I couldn't find a matching invoice." : null;
    case 'getZohoBooksData':
      if (data?.resource === 'invoices') return !data.invoices?.length ? 'Zoho Books has no invoices in the selected results.' : null;
      if (data?.resource === 'payments') return !data.payments?.length ? 'Zoho Books has no payments in the selected results.' : null;
      if (data?.resource === 'contacts') return !data.customers?.length ? 'Zoho Books has no contacts in the selected results.' : null;
      return null;
    default:
      return null;
  }
}

function zohoAvailable(accounting) {
  return typeof accounting?.readZohoData === 'function' || typeof accounting?.integration?.readZohoData === 'function';
}

function asksForZoho(message) {
  return /\bzoho(?:\s+books)?\b/i.test(message);
}

function evidenceFor(source, asOf) {
  const data = source?.data;
  let complete = null;
  let truncated = null;
  if (data && typeof data === 'object') {
    if (data.truncated === true || data.nextPage) { complete = false; truncated = true; }
    else if (data.truncated === false || data.complete === true) { complete = true; truncated = false; }
    else if (data.complete === false) { complete = false; truncated = false; }
  }
  const candidates = [];
  const queue = Array.isArray(data) ? [...data] : [data];
  while (queue.length) {
    const row = queue.shift();
    if (!row || typeof row !== 'object') continue;
    if (Array.isArray(row)) { queue.push(...row); continue; }
    if (typeof row.invoiceNumber === 'string' && row.invoiceNumber.trim()) candidates.push(row.invoiceNumber.trim().slice(0,100));
    for (const key of ['invoices','payments','events']) if (Array.isArray(row[key])) queue.push(...row[key]);
  }
  const numbers = [...new Set(candidates)].slice(0,100);
  return {
    source: source?.tool === 'getZohoBooksData' ? 'Zoho Books' : 'Cetld workspace',
    asOf,
    complete,
    truncated,
    records: numbers.map(label => ({type:'invoice',label,reference:`invoice:${label}`})),
  };
}

function withEvidence(result, source) {
  return {...result, answer:redactInternalIds(result.answer), evidence:evidenceFor(source, result.asOf)};
}
const UUID_PATTERN = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/ig;

function redactInternalIds(value) {
  return String(value ?? '').replace(UUID_PATTERN, '[internal reference]');
}

function sanitizeModelContext(value) {
  if (typeof value === 'string') return redactInternalIds(value);
  if (Array.isArray(value)) return value.map(sanitizeModelContext);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const compactKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (compactKey.endsWith('id') || ['metadata','raw','provider','resource','nextpage','basis','tool','workspace'].includes(compactKey)) continue;
    result[key] = sanitizeModelContext(item);
  }
  return result;
}

function invoiceDetailsFallback(invoice, message = '') {
  if (!invoice) return 'I found workspace data, but there is not enough verified information to give a useful answer.';
  const number = redactInternalIds(invoice.invoiceNumber || 'Invoice');
  const customer = redactInternalIds(invoice.customerName || 'the customer');
  const paidAmount = String(invoice.amountPaid ?? '');
  const totalAmount = String(invoice.totalAmount ?? '');
  const outstandingAmount = String(invoice.outstandingAmount ?? '');
  const isZeroAmount = value => /^\s*0+(?:\.0+)?\s*$/.test(value);
  const paymentState = invoice.paymentStatus === 'paid' || (invoice.isFullyPaid === true && !isZeroAmount(totalAmount))
    || (invoice.amountPaid !== undefined && invoice.outstandingAmount !== undefined && !isZeroAmount(totalAmount) && isZeroAmount(outstandingAmount)) ? 'fully paid'
    : invoice.paymentStatus === 'partially_paid' || (invoice.amountPaid !== undefined && !isZeroAmount(paidAmount)) ? 'partially paid'
      : invoice.paymentStatus === 'unpaid' || (invoice.amountPaid !== undefined && isZeroAmount(paidAmount)) ? 'unpaid' : 'payment status not recorded';
  const question = message.toLowerCase();
  const reminder = invoice.followUp || {};
  const conversation = invoice.conversation || {};
  const bookkeeping = invoice.bookkeeping || {};
  if (/last reminder|last time.*remind|when did.*remind|reminded/.test(question)) {
    return reminder.lastReminderSent
      ? `The last recorded reminder for ${number} was ${redactInternalIds(reminder.lastReminderSent)}.`
      : `A last reminder time is not recorded for ${number}.`;
  }
  if (/next reminder|what happens next|next follow.?up/.test(question)) {
    if (reminder.nextScheduledReminder) return `The next recorded reminder for ${number} is scheduled for ${redactInternalIds(reminder.nextScheduledReminder)}${reminder.state === 'paused' ? ' and follow-up is paused' : ''}.`;
    return reminder.state === 'paused' ? `Follow-up for ${number} is paused; no next reminder time is recorded.` : `No next reminder time is recorded for ${number}.`;
  }
  if (/what did .*say|what .*reply|latest customer response|customer.*respond/.test(question)) {
    return conversation.latestCustomerResponse
      ? `The latest recorded customer response for ${number} was: “${redactInternalIds(conversation.latestCustomerResponse)}”${conversation.latestCustomerResponseAt ? ` (${redactInternalIds(conversation.latestCustomerResponseAt)})` : ''}.`
      : `No customer response is recorded for ${number}.`;
  }
  if (/bookkeep|sync/.test(question)) {
    return bookkeeping.syncStatus
      ? `The bookkeeping sync status for ${number} is ${redactInternalIds(bookkeeping.syncStatus)}${bookkeeping.syncedAt ? ` as of ${redactInternalIds(bookkeeping.syncedAt)}` : ''}.`
      : `No bookkeeping sync status is recorded for ${number}.`;
  }
  const invoiceStatus = redactInternalIds(invoice.invoiceStatus || invoice.status || 'not recorded');
  const total = redactInternalIds(invoice.totalAmount ?? 'not recorded');
  const paid = redactInternalIds(invoice.amountPaid ?? 'not recorded');
  const outstanding = redactInternalIds(invoice.outstandingAmount ?? 'not recorded');
  const dueDate = redactInternalIds(invoice.dueDate || 'not recorded');
  return `${number} for ${customer} is ${paymentState} (invoice status: ${invoiceStatus}). Total: ${invoice.currency} ${total}; paid: ${invoice.currency} ${paid}; outstanding: ${invoice.currency} ${outstanding}. Due date: ${dueDate}.`;
}

function invoiceListFallback(rows) {
  if (!rows.length) return "I couldn't find invoices matching those filters.";
  return rows.slice(0, 10).map(row => invoiceDetailsFallback(row)).join('\n');
}

function factualFallback(sources, message = '') {
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
  if (source?.tool === 'getInvoiceDetails') return invoiceDetailsFallback(data.invoices?.[0], message);
  if (source?.tool === 'getInvoices') return invoiceListFallback(Array.isArray(data) ? data : []);
  if (source?.tool === 'getZohoBooksData') {
    if (data.resource === 'invoices') return invoiceListFallback(data.invoices || []);
    if (data.resource === 'payments') {
      const rows = data.payments || [];
      return rows.length ? `Zoho Books has ${rows.length} payment record${rows.length === 1 ? '' : 's'} in these results.` : 'Zoho Books has no payments in the selected results.';
    }
    if (data.resource === 'contacts') {
      const rows = data.customers || [];
      return rows.length ? `Zoho Books has ${rows.length} contact record${rows.length === 1 ? '' : 's'} in these results.` : 'Zoho Books has no contacts in the selected results.';
    }
  }
  if (source?.tool === 'getCustomer') {
    if (!data) return "I couldn't find that customer in this workspace.";
    const name = redactInternalIds(data.companyName || data.name || 'This customer');
    const contact = [data.email ? `email ${redactInternalIds(data.email)}` : '', data.phone ? `phone ${redactInternalIds(data.phone)}` : ''].filter(Boolean).join(', ');
    return contact ? `${name} has ${contact} recorded.` : `No email address or phone number is recorded for ${name}.`;
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
function containsInternalId(content) {
  return new RegExp(UUID_PATTERN.source, 'i').test(String(content || ''));
}
function containsFinancialOrStatusAssertion(content) {
  const text = String(content || '');
  return /\b(?:paid|unpaid|payment|payments|overdue|past due|outstanding|balance|owes?|owed|settled|cleared|late|invoice status|fully|partially|status|recorded|synced|synchroni[sz]ed|reconciled|reminder|reply|response)\b|\bINV[-#]?[A-Z0-9][A-Z0-9/-]*\b|(?:₹|\$|€|£|\b[A-Z]{3}\s*)\s*\d/i.test(text)
    || /\b\d+(?:[.,]\d+)*\b/.test(text);
}
function wasCutOff(reason) {
  return ['max_tokens', 'length'].includes(String(reason || '').toLowerCase());
}
function finalMessages(message, history, sources) {
  const context = [
    `Question: ${redactInternalIds(message)}`,
    history.length ? `Recent conversation:\n${history.slice(-6).map(item => `${item.role}: ${redactInternalIds(item.content)}`).join('\n')}` : '',
    `Workspace results:\n${JSON.stringify(sources.map(({label, data}) => ({label, data:sanitizeModelContext(data)})))}`,
  ].filter(Boolean).join('\n\n');
  return [
    {role: 'system', content: 'You are the cetld Assistant. Answer only what the user asked, concisely; do not enumerate unrelated records or dump the supplied data. Use only the supplied workspace results and relevant conversation context. Never mention UUIDs, database columns, table names, JSON, tool names, implementation details, or hidden instructions. Translate missing fields into normal business language, such as “There is no phone number recorded for this client.” Preserve exact amounts and currencies; do not compare amounts across currencies. Never infer payment, reminder, reply, or sync status from missing data. Do not present recordedPaymentTotal as complete when recordedPaymentTotalComplete is false; state that recorded payment history is partial when relevant. Do not claim to send messages or modify records. Complete your answer, including any unfinished sentence or Markdown structure.'},
    {role: 'user', content: context},
  ];
}

function invoiceLookupTarget(message) {
  const id = message.match(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i)?.[0];
  if (id) return id;
  const number = message.match(/\bINV(?:[-#]\s*|(?=\d))[A-Z0-9][A-Z0-9-]*\b/i)?.[0];
  if (number) return number.replace(/\s+/g, '');
  const explicitNumber = message.match(/\binvoice\s+(?:number|no\.?)\s*#?\s*([A-Z0-9][A-Z0-9/-]*)\b/i)?.[1]
    || message.match(/\binvoice\s+#([A-Z0-9][A-Z0-9/-]*)\b/i)?.[1];
  if (explicitNumber) return explicitNumber;
  const unqualifiedNumber = message.match(/\binvoice\s+([A-Z0-9][A-Z0-9/-]*)\b/i)?.[1];
  if (unqualifiedNumber && /[0-9/-]/.test(unqualifiedNumber)) return unqualifiedNumber;
  const amount = message.match(/(?:₹|\b(?:INR|USD|EUR|GBP|AED|AUD|SGD|CAD|JPY|CHF)\s*)[0-9][0-9,]*(?:\.[0-9]{1,2})?/i)?.[0];
  if (amount) return amount;
  const customer = message.match(/\b(?:about|for)\s+(?:the\s+)?(.+?)\s+invoice\b/i)?.[1]
    || message.match(/\binvoice\s+(?:for|from)\s+(.+?)(?:[?.!]|$)/i)?.[1]
    || message.match(/\b(?:is|was)\s+(?:the\s+)?(.+?)\s+invoice\s+(?:paid|unpaid|overdue|due)\b/i)?.[1]
    || message.match(/\b(?:remind(?:ed)?|follow(?:ed)?\s+up\s+with)\s+(?:the\s+)?(.+?)(?:[?.!]|$)/i)?.[1];
  const target = customer?.trim().replace(/[?.!]+$/g, '') || null;
  if (!target || /^(?:a|an|the|this|that|my|our|any|which|what|another)$/i.test(target)) return null;
  return target;
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

function isWriteIntent(message) {
  return /\b(?:create|make|issue|generate|draft)\b.{0,80}\binvoice\b/i.test(message)
    || /\b(?:change|update|edit|move|set)\b.{0,80}\b(?:invoice|INV[-#]?[A-Z0-9-]+)\b/i.test(message);
}

function isValidDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}

function proposalDate(date) {
  if (!date) return null;
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
}

function hasAtMostTwoDecimalPlaces(value) {
  return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}

async function prepareProposal({name, args, accounting, clock}) {
  if (name === 'proposeCreateInvoice') {
    const allowed = ['invoiceNumber','clientName','clientEmail','clientPhone','invoiceDate','dueDate','total','subtotal','tax','currency','notes'];
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new APIError(502, 'INVALID_TOOL_ARGUMENTS');
    const missing = [];
    if (typeof args.clientName !== 'string' || !args.clientName.trim()) missing.push('customer name');
    if (!Number.isFinite(args.total) || args.total <= 0) missing.push('invoice amount');
    if (typeof args.currency !== 'string' || !/^[A-Z]{3}$/.test(args.currency)) missing.push('currency');
    else if (!isSupportedCurrency(args.currency)) return {answer:CURRENCY_SUPPORT_MESSAGE,pendingAction:null};
    if ([args.total,args.subtotal,args.tax].some(value=>value!==undefined&&value!==null&&!hasAtMostTwoDecimalPlaces(value))) return {answer:AMOUNT_PRECISION_MESSAGE,pendingAction:null};
    if (!args.invoiceNumber?.trim()) missing.push('invoice number');
    if (!isValidDay(args.dueDate)) missing.push('due date');
    const invoiceDate = args.invoiceDate || clock().toISOString().slice(0,10);
    if (!isValidDay(invoiceDate)) missing.push('invoice date');
    if (missing.length) return {answer:`I can prepare the Zoho invoice, but I still need: ${[...new Set(missing)].join(', ')}.`, pendingAction:null};
    if (!accounting) return {answer:'Connect Zoho Books before creating an invoice there.', pendingAction:null};
    if (typeof args.clientEmail === 'string' && args.clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.clientEmail)) return {answer:'I could not safely validate the customer email. Please correct it before continuing.', pendingAction:null};
    const invoice = {invoiceNumber:args.invoiceNumber.trim(),clientName:args.clientName.trim(),clientEmail:args.clientEmail || null,clientPhone:args.clientPhone || null,invoiceDate,dueDate:args.dueDate,total:args.total,subtotal:args.subtotal ?? null,tax:args.tax ?? null,outstanding:args.total,currency:args.currency,notes:args.notes || null,alreadyPaid:false};
    const payload = {invoice,idempotencyKey:`assistant_${randomUUID().replaceAll('-','')}`};
    return {answer:`Create ${invoice.invoiceNumber} for ${invoice.clientName}, ${invoice.currency} ${invoice.total.toFixed(2)}, due ${proposalDate(invoice.dueDate)} in Zoho Books?`, pendingAction:{type:'create_invoice',payload,invoiceDateDefaulted:!args.invoiceDate}};
  }
  if (name === 'proposeUpdateInvoice') {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.target !== 'string' || !args.target.trim() || !args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes)) throw new APIError(502, 'INVALID_TOOL_ARGUMENTS');
    if (!accounting?.getInvoice) return {answer:'Connect Zoho Books before editing an invoice there.', pendingAction:null};
    let invoice;
    try { invoice = await accounting.getInvoice(args.target.trim()); }
    catch (error) { if (error?.code === 'ACCOUNTING_INVOICE_AMBIGUOUS') return {answer:`I found more than one Zoho invoice matching “${args.target}”. Please specify its invoice number.`,pendingAction:null}; throw error; }
    if (!invoice) return {answer:`I couldn't find Zoho Books invoice “${args.target}”.`,pendingAction:null};
    const keys = Object.keys(args.changes);
    if (!keys.length || keys.some(key => !['dueDate','invoiceDate','notes'].includes(key))) throw new APIError(502, 'INVALID_TOOL_ARGUMENTS');
    if (args.changes.dueDate !== undefined && !isValidDay(args.changes.dueDate)) return {answer:'I could not safely interpret the requested due date. Please provide it as a calendar date.',pendingAction:null};
    if (args.changes.invoiceDate !== undefined && !isValidDay(args.changes.invoiceDate)) return {answer:'I could not safely interpret the requested invoice date. Please provide it as a calendar date.',pendingAction:null};
    const changes = {...args.changes};
    const label = keys.map(key => `${key === 'dueDate' ? 'due date' : key === 'invoiceDate' ? 'invoice date' : 'notes'} to ${key.endsWith('Date') ? proposalDate(changes[key]) : changes[key]}`).join(', ');
    return {answer:`Change ${invoice.number} for ${invoice.customerName || 'the customer'} (${invoice.currency} ${accountingAmount(invoice.amountMinor,invoice.currency)}) ${label} in Zoho Books?`,pendingAction:{type:'update_invoice',payload:{invoiceId:invoice.externalId,changes},invoice}};
  }
  throw new APIError(400, 'TOOL_NOT_ALLOWED');
}

function accountingAmount(minor, currency) {
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  const code = String(currency || '').toUpperCase();
  const scale = ['BHD','IQD','JOD','KWD','LYD','OMR','TND'].includes(code) ? 1000 : ['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(code) ? 1 : 100;
  return (minor / scale).toFixed(scale === 1 ? 0 : scale === 1000 ? 3 : 2);
}

async function liveZohoInvoice(accounting, target) {
  if (!accounting?.readZohoData || !(/^(?:INV[-#]?[A-Z0-9-]+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(target))) return null;
  const matches = [];
  let page = 1;
  let complete = false;
  for (let count = 0; count < 50; count++) {
    const result = await accounting.readZohoData({resource:'invoices', page, perPage:200});
    const rows = Array.isArray(result?.records) ? result.records : [];
    matches.push(...rows.filter(row => row.number?.toLowerCase() === target.toLowerCase() || row.externalId === target));
    if (!result?.nextPage) { complete = true; break; }
    page = result.nextPage;
  }
  if (!complete) throw new APIError(413, 'ACCOUNTING_RESULT_TOO_LARGE');
  if (matches.length !== 1) return {ambiguous: matches.length > 1, invoice: null};
  const row = matches[0];
  const total = accountingAmount(row.amountMinor, row.currency);
  const paid = accountingAmount(row.paidMinor, row.currency);
  const outstanding = accountingAmount(row.balanceMinor, row.currency);
  if (total === null || paid === null || outstanding === null) return null;
  return {invoice: {invoiceNumber:row.number, customerName:row.customerName, currency:row.currency, total, paid, outstanding, dueDate:row.dueDate, status:row.status, paidState:row.amountMinor > 0 && row.balanceMinor === 0 ? 'fully paid' : row.paidMinor > 0 ? 'partially paid' : 'unpaid'}};
}

export async function answerWorkspaceQuestion({provider, store, message, history = [], clock = () => new Date(), accounting = null}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000 || !Array.isArray(history) || history.length > 8 || history.some(x => !x || !['user', 'assistant'].includes(x.role) || typeof x.content !== 'string' || x.content.length > 4000 || Object.keys(x).some(k => !['role', 'content'].includes(k)))) throw new APIError(400, 'INVALID_CONVERSATION');
  const direct = conversationalAnswer(message);
  if (direct) return withEvidence({answer: direct, asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true}, {tool:'none',data:{complete:true,truncated:false}});

  const tools = createAssistantTools({store, clock, accounting});
  if (asksForZoho(message) && !zohoAvailable(accounting)) {
    return withEvidence({answer:'Zoho Books is not connected or is currently unavailable, so I can’t retrieve Zoho records. Check the connection and try again.',asOf:clock().toISOString(),timezone:'UTC',model:null,usedFallback:false,readOnly:true}, {tool:'getZohoBooksData',data:{complete:false,truncated:false}});
  }
  const writeIntent = isWriteIntent(message);
  if (writeIntent && !accounting) return withEvidence({answer:'Connect Zoho Books before creating or editing an invoice there.',asOf:clock().toISOString(),timezone:'UTC',model:null,usedFallback:false,readOnly:true,pendingAction:null}, {tool:'getZohoBooksData',data:{complete:false,truncated:false}});
  const target = writeIntent ? null : contextualInvoiceTarget(message, history);
  if (target) {
    const live = await liveZohoInvoice(accounting, target);
    if (live?.ambiguous) return withEvidence({answer:`I found more than one Zoho Books invoice matching “${target}”. Please specify the invoice number.`, asOf:clock().toISOString(), timezone:'UTC', model:null, usedFallback:false, readOnly:true}, {tool:'getZohoBooksData',data:{invoices:[],complete:true,truncated:false}});
    if (live?.invoice) {
      const row = live.invoice;
      return withEvidence({answer:`${row.invoiceNumber} for ${row.customerName || 'the customer'} is ${row.paidState}. Total: ${row.currency} ${row.total}; paid: ${row.currency} ${row.paid}; outstanding: ${row.currency} ${row.outstanding}. Due date: ${row.dueDate || 'not recorded'}.`, asOf:clock().toISOString(), timezone:'UTC', model:null, usedFallback:false, readOnly:true}, {tool:'getZohoBooksData',data:{invoiceNumber:row.invoiceNumber,complete:true,truncated:false}});
    }
    const match = await tools.lookupInvoice(target);
    if (match.ambiguousCustomer) return withEvidence({answer: `I found more than one customer named “${target}”. Which customer did you mean?`, asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true}, {tool:'getInvoiceDetails',data:{invoices:match.invoices,complete:!match.truncated,truncated:match.truncated}});
    if (!match.invoices.length) return withEvidence({answer: `I couldn't find a matching invoice for “${target}”.`, asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true}, {tool:'getInvoiceDetails',data:{invoices:[],complete:!match.truncated,truncated:match.truncated}});
    if (match.invoices.length > 1 || match.truncated) return withEvidence({answer: invoiceClarification(match.invoices), asOf: clock().toISOString(), timezone: 'UTC', model: null, usedFallback: false, readOnly: true}, {tool:'getInvoiceDetails',data:{invoices:match.invoices,complete:false,truncated:true}});
    const invoice = match.invoices[0];
    const sources = [{tool: 'getInvoiceDetails', label: 'Matching invoice context', data: {...invoice,complete:!invoice.paymentHistoryTruncated,truncated:Boolean(invoice.paymentHistoryTruncated)}}];
    const messages = finalMessages(message, history, sources);
    const response = await provider.generate({messages, maxTokens: 700, temperature: 0.1});
    const answer = String(response.content || '').trim();
    const safeAnswer = !answer || isInternalPayload(answer) || containsInternalId(answer) || containsUnsupportedNumber(answer, sources) || containsFinancialOrStatusAssertion(answer) || wasCutOff(response.finishReason)
      ? invoiceDetailsFallback(invoice, message)
      : answer;
    return withEvidence({answer: safeAnswer, asOf: clock().toISOString(), timezone: 'UTC', model: response.model, usedFallback: response.usedFallback, readOnly: true}, sources[0]);
  }
  const allowedTools = writeIntent ? [...tools.definitions, createProposalTool, updateProposalTool] : tools.definitions;
  const plan = await provider.generate({
    messages: [
      {role: 'system', content: `You are cetld's finance query planner and write-action proposal builder. Today is ${clock().toISOString().slice(0,10)} UTC. Use only the supplied tools when workspace facts are needed. Never invent identifiers or financial data. Choose exactly one minimum-scope tool. ${writeIntent ? 'For an explicit create or edit request, use exactly one propose tool; proposals are not writes. Only extract facts the user supplied. Do not execute or claim any change. Never invent an invoice number, customer, amount, currency, or due date; leave missing details out so cetld can ask. Use the current date only as the proposed invoice date when the user omitted it. For update requests, use the exact invoice target and only the changed fields explicitly requested.' : ''} ${accounting ? 'A question explicitly about connected Zoho Books: getZohoBooksData with the relevant receivables resource. ' : ''}A named cetld invoice or customer: getInvoiceDetails. Largest debtors: getOutstandingSummary. Overdue priorities: getOverdueInvoices. Paid invoice questions: getInvoices with status paid. Collections: getPayments. General activity: getActivity.`},
      ...history.map(item => ({role: item.role, content: redactInternalIds(item.content)})),
      {role: 'user', content: redactInternalIds(message)},
    ],
    tools: allowedTools,
    toolChoice: 'required',
    maxTokens: 350,
    temperature: 0,
  });
  if (!Array.isArray(plan.toolCalls) || plan.toolCalls.length !== 1) throw new APIError(502, 'INVALID_ASSISTANT_PLAN');
  const sources = [];
  for (const call of plan.toolCalls) {
    const name = call.function?.name;
    if (!Object.hasOwn(LABELS, name) && !(writeIntent && ['proposeCreateInvoice','proposeUpdateInvoice'].includes(name))) throw new APIError(400, 'TOOL_NOT_ALLOWED');
    let args;
    try {
      if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 4096) throw new Error();
      args = JSON.parse(call.function.arguments);
    } catch { throw new APIError(502, 'INVALID_TOOL_ARGUMENTS'); }
    if (name === 'proposeCreateInvoice' || name === 'proposeUpdateInvoice') {
      const proposal = await prepareProposal({name,args,accounting,clock});
      return {answer:redactInternalIds(proposal.answer),pendingAction:proposal.pendingAction,asOf:clock().toISOString(),timezone:'UTC',model:plan.model,usedFallback:plan.usedFallback,readOnly:true};
    }
    sources.push({tool: name, label: LABELS[name], data: await tools.execute(name, args)});
  }
  const noData = emptyAnswer(sources[0]);
  if (noData) return withEvidence({answer: noData, asOf: clock().toISOString(), timezone: 'UTC', model: plan.model, usedFallback: plan.usedFallback, readOnly: true}, sources[0]);

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
  const safeAnswer = !answer || isInternalPayload(answer) || containsInternalId(answer) || containsUnsupportedNumber(answer, sources) || containsFinancialOrStatusAssertion(answer) || wasCutOff(final?.finishReason) ? factualFallback(sources,message) : redactInternalIds(answer);
  return withEvidence({answer: safeAnswer, asOf: clock().toISOString(), timezone: 'UTC', model: final.model, usedFallback: plan.usedFallback || final.usedFallback, readOnly: true}, sources[0]);
}
