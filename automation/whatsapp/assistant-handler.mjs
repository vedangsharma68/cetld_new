import {normalizeOwnerPhone,PHONE_FORMAT_GUIDANCE} from './owner-phone.mjs';
import {AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  sanitizeModelSettings} from '../../ai/provider.mjs';
import {createWhatsAppAssistantChannel} from '../../ai/whatsapp-channel.mjs';
import {getSendEligibility} from './consent.mjs';
import {readConversationHistory, writeConversationTurn} from './conversation-memory.mjs';
import {extractInvoice, INVOICE_IMAGE_REPLIES} from '../../ai/extraction.mjs';
import {createWhatsAppPendingActionStore} from './pending-actions.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';
import {validateAssistantInvoice} from '../../ai/invoice-ops.mjs';
import {createHash} from 'node:crypto';
import {CURRENCY_SUPPORT_MESSAGE, isSupportedCurrency} from '../../currency-contract.mjs';
import {deriveInvoiceDueDate, inferInvoiceCurrency, todayInKolkata} from '../../ai/invoice-photo-inference.mjs';
import {classifyIntent} from './intent.mjs';

const requiredInvoiceFields = ['invoiceNumber','customerName','invoiceDate','total','currency','direction'];
const fieldLabels = {invoiceNumber: 'invoice number', customerName: 'customer name', invoiceDate: 'invoice date',
  dueDate: 'due date', total: 'total', currency: 'explicit currency code (for example INR or USD)',
  direction: 'confirmation that your business issued the invoice'};

export function invoiceReviewClarification(action) {
  if (Object.hasOwn(INVOICE_IMAGE_REPLIES, action.failureCode || '')) return INVOICE_IMAGE_REPLIES[action.failureCode];
  if (action.failureCode === 'EXTRACTION_UNAVAILABLE') {
    return action.failureReason === 'TIMEOUT'
      ? 'Reading the invoice timed out. Nothing was saved. Send it again later.'
      : 'Invoice reading is unavailable right now. Nothing was saved. Send it again later.';
  }
  if (action.failureCode === 'INVOICE_REVIEW_UNAVAILABLE') {
    return action.failureReason === 'TIMEOUT'
      ? 'Invoice review timed out. Nothing was saved. Send it again later.'
      : 'Invoice review is unavailable right now. Nothing was saved. Send it again later.';
  }
  const details = (action.missingFields || []).filter(name => name !== 'direction').map(name => fieldLabels[name]);
  const issues = action.validationIssues || [];
  const moneyIssues = issues.some(code => /SUBTOTAL|TAX|OUTSTANDING|BALANCE|LINE_ITEMS|AMOUNT|TOTAL/.test(code));
  const mismatch = issues.includes('INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX');
  const paymentConflict = issues.includes('PAYMENT_STATUS_CONFLICT');
  const paymentReview = paymentConflict || issues.includes('PAYMENT_RECORD_REQUIRES_REVIEW') || issues.includes('UNCERTAIN_PAYMENT_STATUS');
  return ['The review is incomplete.',
    paymentConflict ? action.paymentEvidence?.status === 'paid'
      ? 'The PAID marking doesn’t match the balance owed.'
      : 'The payment status doesn’t match the balance owed or other markings.' : null,
    paymentReview ? 'Check the original payment status and balance. Send a corrected invoice or clearer photo. No payment was recorded.' : null,
    mismatch ? 'Subtotal plus tax doesn’t match the total. Check the breakdown.' : null,
    mismatch && /\b(?:shipping|handling|freight|delivery|surcharge|discount)\b/i.test(action.invoice?.notes || '') ? 'Check the printed shipping, charges, and discounts too.' : null,
    moneyIssues ? 'Check amounts against the original. Send a corrected invoice or clearer photo with subtotal, tax, total, balance, and adjustments.' : null,
    details.length ? `Confirm the ${details.join(', ')}.` : null,
    action.missingFields?.includes('direction') ? 'Tell me whether your business issued the invoice.' : null,
    !moneyIssues && !details.length && !paymentReview && !action.missingFields?.includes('direction') ? 'Send a clearer photo so I can check the details.' : null,
    'Nothing was saved.'].filter(Boolean).join(' ');
}

function extractionValidationIssues(extracted) {
  const uncertain = new Set([...(extracted?.uncertainFields || []), ...(extracted?.missingFields || [])]);
  const issues = [];
  const paymentStatus = extracted?.paymentStatus;
  if (paymentStatus?.value === 'conflicting' || paymentStatus?.value === 'paid' && extracted?.outstandingAmount?.value > 0) issues.push('PAYMENT_STATUS_CONFLICT');
  else if (['paid', 'partial'].includes(paymentStatus?.value)) issues.push('PAYMENT_RECORD_REQUIRES_REVIEW');
  else if (paymentStatus?.value && (paymentStatus.confidence < 0.75 || uncertain.has('paymentStatus'))) issues.push('UNCERTAIN_PAYMENT_STATUS');
  for (const [field, label] of [['subtotal','SUBTOTAL'], ['tax','TAX'], ['total','TOTAL'], ['outstandingAmount','OUTSTANDING_AMOUNT']]) {
    const fact = extracted?.[field];
    // Missing currency also marks otherwise readable money uncertain. Currency
    // inference below remains responsible for that case; it cannot resolve low
    // confidence or contradictory printed amounts.
    if (fact?.value != null && (fact.confidence < 0.75 || extracted?.currency?.value && uncertain.has(field))) {
      issues.push(`UNCERTAIN_${label}`);
    }
  }
  const items = extracted?.lineItems?.value;
  if (Array.isArray(items) && items.length && (extracted.lineItems.confidence < 0.75
    || uncertain.has('lineItems') || items.some(item => item.confidence != null && item.confidence < 0.75))) {
    issues.push('UNCERTAIN_LINE_ITEMS');
  }
  return issues;
}

function invoiceProposal(extracted) {
  if (requiredInvoiceFields.some(name => extracted?.[name]?.value == null || extracted[name].confidence < 0.75)
    || extracted.direction.value !== 'receivable') return null;
  return {invoiceNumber: extracted.invoiceNumber.value, clientName: extracted.customerName.value,
    clientEmail: extracted.clientEmail?.value ?? null, clientPhone: extracted.clientPhone?.value ?? null,
    clientPhoneRaw: extracted.clientPhoneRaw?.value ?? null,
    invoiceDate: extracted.invoiceDate.value, dueDate: extracted.dueDate?.confidence >= .75 ? extracted.dueDate.value : null,
    subtotal: extracted.subtotal?.value ?? null, tax: extracted.tax?.value ?? null, total: extracted.total.value,
    outstanding: extracted.outstandingAmount?.value ?? extracted.total.value, currency: extracted.currency.value,
    notes: extracted.notes?.value ?? null, alreadyPaid: false, direction: 'receivable', lineItems: extracted.lineItems?.value || []};
}

function missingFields(extracted) {
  return requiredInvoiceFields.filter(name => extracted?.[name]?.value == null
    || extracted[name].confidence < 0.75 || (name === 'direction' && extracted[name].value !== 'receivable'));
}

export function reviewDraft(extracted, sourceMessageId = null) {
  const invoice = invoiceProposal(extracted) || {
    invoiceNumber: extracted?.invoiceNumber?.value ?? null, clientName: extracted?.customerName?.value ?? null,
    clientEmail: extracted?.clientEmail?.value ?? null, clientPhone: extracted?.clientPhone?.value ?? null,
    clientPhoneRaw: extracted?.clientPhoneRaw?.value ?? null,
    invoiceDate: extracted?.invoiceDate?.value ?? null, dueDate: extracted?.dueDate?.confidence >= .75 ? extracted.dueDate.value : null,
    subtotal: extracted?.subtotal?.value ?? null, tax: extracted?.tax?.value ?? null,
    total: extracted?.total?.value ?? null,
    outstanding: extracted?.outstandingAmount?.value ?? extracted?.total?.value ?? null,
    currency: extracted?.currency?.value ?? null, notes: extracted?.notes?.value ?? null,
    alreadyPaid: false, direction: extracted?.direction?.value ?? null,
    lineItems: Array.isArray(extracted?.lineItems?.value) ? extracted.lineItems.value : [],
  };
  const hasPhotoCurrency=typeof extracted?.currency?.value==='string'&&extracted.currency.confidence>=0.75
    &&isSupportedCurrency(extracted.currency.value);
  return {type: 'invoice_review_draft', stage: 'incomplete', invoice,
    ...(extracted?.paymentStatus?.value ? {paymentEvidence: {status: extracted.paymentStatus.value,
      text: extracted.paymentStatusEvidence?.value ?? null, confidence: extracted.paymentStatus.confidence}} : {}),
    validationIssues: extractionValidationIssues(extracted),
    missingFields: missingFields(extracted), currencySource: hasPhotoCurrency?'photo':null,sourceMessageId};
}

const CURRENCY_REPLY = /^\s*([A-Za-z]{3})[.!]?\s*$/;
const CANCEL_REPLY = /^\s*(?:cancel|never mind|nevermind|discard|stop)\s*[.!]?\s*$/i;
const CONFIRMATION_REPLY = /^\s*(?:yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve|send it|create it)\s*[.!]?\s*$/i;
const OWNER_CLAIM = /\b(?:i\s*(?:am|'m)\s+(?:the\s+)?owner|my\s+(?:business|account)|owner\s+access)\b/i;
const FILE_REQUEST = /\b(?:send|show|give)\s+(?:me\s+)?(?:the\s+)?invoice\s+(?:file|photo|pdf)\b/i;
const INTENT_REQUEST = /\b(?:change|chnge|make|set|update|edit|modify|fix|paid)\b|\b(?:send|show|give|download)\b.{0,30}\b(?:invoice|invoce|bill|pdf|file)\b|\b(?:list|show)\b.{0,20}\b(?:invoices|invoce|bills)\b/i;

function parseDate(value, clock) {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(`${text} ${new Date(clock()).getUTCFullYear()} 00:00:00 UTC`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

/** Closed, deterministic correction grammar: no model-generated writes. */
export function parseInvoiceCorrection(message, clock = () => new Date()) {
  const text = String(message || '').trim();
  let match;
  if (/\b(?:sql|run|execute|select|delete|drop|table|script)\b/i.test(text)) return null;
  match = text.match(/\b(?:change|make|set|update|edit|modify|fix)\b(.*)\b([a-z]{3,8})\b\s*(?:to|=|as|is|:)?\s*([$₹€£])?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*([a-z]{3})?\b/i);
  if (match && AMOUNT_WORDS.some(word => editDistance(match[2].toLowerCase(), word) <= (word.length >= 5 ? 2 : 0))) {
    const symbols = {'$': 'USD', '₹': 'INR', '€': 'EUR', '£': 'GBP'};
    const code = match[5] ? match[5].toUpperCase() : (match[3] ? symbols[match[3]] : null);
    const hint = invoiceHint(match[1]);
    if (hint && hint.split(' ').length > 5) return null;
    return {changes: {total: Number(match[4].replace(/,/g, '')), ...(code ? {currency: code} : {})}, ...(hint ? {hint} : {})};
  }
  if ((match = text.match(/\b(?:change|make|set)\s+(?:the\s+)?due\s+date\s+(?:to\s+)?(.+)$/i))) return {changes: {dueDate: parseDate(match[1], clock)}};
  if ((match = text.match(/\b(?:change|make|set)\s+(?:the\s+)?(?:invoice|issue)\s+date\s+(?:to\s+)?(.+)$/i))) return {changes: {invoiceDate: parseDate(match[1], clock)}};
  if ((match = text.match(/\b(?:change|set)\s+(?:the\s+)?customer\s+(?:to\s+)?(.+)$/i))) return {changes: {clientName: match[1].trim()}};
  if ((match = text.match(/\bcurrency\s+(?:should\s+be|to|is)\s+([a-z]{3})\b/i))) return {changes: {currency: match[1].toUpperCase()}};
  if ((match = text.match(/\b(?:change|set)\s+(?:the\s+)?notes?\s+(?:to\s+)?(.+)$/i))) return {changes: {notes: match[1].trim()}};
  if (/\bmark\s+(?:it|the invoice)\s+paid\b/i.test(text)) return {changes: {status: 'paid'}};
  return null;
}

const ASK_NUMBER = /Which invoice number should I use\?$/;
const AMOUNT_WORDS = ['amount', 'amt', 'total', 'price', 'value', 'amnt'];
const HINT_STOP = new Set(['the','its','it','my','a','an','of','for','to','invoice','invoices','inovoice','invoce','invoic','bill','that','this','last','latest','recent','please','pls','one','from']);
function hintTokens(text) {
  return String(text || '').toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(t => t && !HINT_STOP.has(t));
}
function invoiceHint(text) { const tokens = hintTokens(text); return tokens.length ? tokens.join(' ') : null; }
function editDistance(a, b) {
  const row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
/** Typo-tolerant match of a spoken customer reference against invoice client names. */
export function matchInvoicesByHint(invoices, hint) {
  const wanted = hintTokens(hint);
  if (!wanted.length) return [];
  return invoices.filter(invoice => {
    const name = hintTokens(`${invoice.clientName || ''} ${invoice.printedInvoiceNumber || ''} ${invoice.metadata?.buyer_name || ''} ${invoice.metadata?.seller_name || ''}`);
    return wanted.every(token => name.some(part => part.startsWith(token) || token.startsWith(part) && part.length >= 4
      || editDistance(token, part) <= (token.length >= 6 ? 2 : token.length >= 4 ? 1 : 0)));
  });
}

const CONTACT_PHONE_REQUEST = /\b(?:contact|phone|mobile|whatsapp|call)\b/i;
const CONTACT_EMAIL_REQUEST = /\be-?mail\b/i;
const PHONE_KEYS = ['debtor_phone', 'client_phone', 'buyer_phone', 'customer_phone', 'contact_phone', 'phone'];
const EMAIL_KEYS = ['debtor_email', 'client_email', 'buyer_email', 'customer_email', 'contact_email', 'email'];
const firstMeta = (metadata, keys) => {
  for (const key of keys) { const value = metadata?.[key]; if (typeof value === 'string' && value.trim()) return value.trim(); }
  return null;
};
/** Deterministic contact lookup from the stored invoice, with plain "I don't have it" answers. */
export function contactAnswer(invoice, {wantPhone, wantEmail}) {
  const label = `${invoice.printedInvoiceNumber || invoice.invoiceNumber}${invoice.clientName ? ` (${invoice.clientName})` : ''}`;
  const phone = firstMeta(invoice.metadata, PHONE_KEYS);
  const rawPhone = firstMeta(invoice.metadata, ['client_phone_raw']);
  const email = firstMeta(invoice.metadata, EMAIL_KEYS);
  const lines = [];
  if (wantPhone) lines.push(phone ? `Phone: ${phone}` : rawPhone
    ? `I only have a local number ${rawPhone}, no country code.` : `I don't have a contact number for ${label}.`);
  if (wantEmail) lines.push(email ? `Email: ${email}` : `I don't have an email address for ${label}.`);
  if (phone || rawPhone || email) lines.unshift(`Contact for ${label}:`);
  return lines.join('\n');
}

function requestedInvoiceNumber(message) {
  return String(message || '').match(/\bINV-[A-Z0-9-]+\b/i)?.[0]?.toUpperCase() || null;
}

function correctionReply(audit) {
  const labels = {total: 'Amount', dueDate: 'Due date', invoiceDate: 'Invoice date', currency: 'Currency',
    notes: 'Notes', clientName: 'Customer', status: 'Status'};
  return Object.entries(audit).map(([field, value]) => `${labels[field]}: ${value.old ?? 'not set'} -> ${value.new ?? 'not set'}`).join('\n');
}

// validateAssistantInvoice intentionally returns derived state for its callers.
// Durable review payloads must remain valid *inputs* to that strict validator.
function approvedInvoice(value) {
  const {missingDueDate: _derived, ...invoice} = validateAssistantInvoice(value);
  return invoice;
}

export function proposalSummary(invoice, {buttonsAvailable = false, continued = false} = {}) {
  return `Invoice ${invoice.invoiceNumber} for ${invoice.clientName}: ${invoice.currency} ${continued ? invoice.total.toFixed(2) : invoice.total.toLocaleString('en-IN')}, due ${invoice.dueDate || 'not shown'}. Save it? ${buttonsAvailable ? 'Tap Confirm or Cancel.' : 'Reply yes to confirm, or no to cancel.'}${continued ? ' Nothing was saved.' : ''}`;
}

const PHONE_CANDIDATE = /\+[\d\s().-]{7,24}\d/;

export async function persistContactQuestion(pending, scope, action) {
  if (typeof pending.loadPendingActionState !== 'function' || typeof pending.storePendingAction !== 'function') return null;
  const expectedState = await pending.loadPendingActionState(scope);
  return pending.storePendingAction({...scope, action, source: 'whatsapp', expectedState});
}

/** Shared owner answer path for typed numbers and contact cards. */
export async function answerDebtorPhone({pending, storeFactory, scope, message, contactCard, clock, pendingRow}) {
  let row = pendingRow;
  if (row === undefined) {
    try { row = await pending.loadPendingAction?.(scope); }
    catch (error) { if (contactCard) throw error; return null; }
  }
  if (contactCard) {
    try { normalizeOwnerPhone(contactCard.phone); }
    catch { return PHONE_FORMAT_GUIDANCE; }
  }
  const contact = row?.action;
  if (contact?.type !== 'invoice_debtor_phone' || contact.stage !== 'awaiting_phone') {
    return contactCard ? 'Which customer or invoice is this number for?' : null;
  }
  const text = String(message || '').trim();
  let candidate = contactCard ? String(contactCard.phone || '')
    : text.match(PHONE_CANDIDATE)?.[0]?.replace(/[\s().-]/g, '')
      || text.match(/(?:^|\b)[6-9][\d -]{8,18}\d(?:$|[.!])/)?.[0]?.replace(/[.!]/g,'').trim() || '';
  const countryCode = !contactCard && text.match(/^\+(\d{1,3})[.!]?$/)?.[1];
  if (!candidate && countryCode && contact.clientPhoneRaw) candidate = `+${countryCode}${String(contact.clientPhoneRaw).replace(/\D/g, '')}`;
  let normalized;
  try { normalized = normalizeOwnerPhone(candidate); }
  catch { return PHONE_FORMAT_GUIDANCE; }
  const store = await storeFactory();
  await store.saveDebtorPhone({invoiceId: contact.invoiceId, phone: normalized, assumedConsentAt: clock().toISOString()});
  await pending.consumePendingAction({...row, ...scope});
  return `Saved ${normalized} for ${contact.clientName}. Before reminders, confirm their agreement and approve the follow-up in cetld.`;
}

/** Create an inbound assistant handler only after the webhook has verified Meta. */
export function createWhatsAppBoundMessageHandler({env = process.env, fetchImpl = fetch, supabase,
  providerFactory = options => new AIProvider(options), channelFactory = createWhatsAppAssistantChannel,
  extract = extractInvoice, pendingActionStoreFactory = createWhatsAppPendingActionStore,
  invoiceStoreFactory = createWhatsAppInvoiceStore,
  clock = () => new Date(), logger = console, authorizeScope, audience='customer'} = {}) {
  if (!supabase?.from) throw new TypeError('A server-side Supabase client is required');

  return async ({workspaceId, customerId, phone, message, messageId, media, mediaError, contactCard, signal, deadlineAt}) => {
    const active = () => {
      if (signal?.aborted || (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt)) throw Object.assign(new Error('Inbound processing deadline expired'), {name: 'AbortError'});
    };
    active();
    if(!authorizeScope&&(media||mediaError||/\b(?:change|chnge|set|edit|modify|fix|update|mark)\b/i.test(message||''))){
      return 'Only the business owner can create or change invoices. Contact the business for help.';
    }
    const {data: settings, error} = await supabase.from('workspace_ai_settings')
      .select('primary_model,fallback_model').eq('workspace_id', workspaceId).maybeSingle();
    if (error) throw error;
    const models = sanitizeModelSettings({primaryModel: settings?.primary_model,
      fallbackModel: settings?.fallback_model});
    const provider = providerFactory({...models, geminiApiKey: env.GEMINI_API_KEY,
      openRouterApiKey: env.OPENROUTER_API_KEY, zenApiKey: env.OPENCODE_ZEN_API_KEY,
      cfAccountId: env.CLOUDFLARE_ACCOUNT_ID, cfApiToken: env.CLOUDFLARE_API_TOKEN,
      fetchImpl, timeoutMs: 8000, maxAttempts: 1});
    const pending = pendingActionStoreFactory({supabase});
    const eligible=async()=>authorizeScope?{allowed:await authorizeScope({workspaceId,customerId,phone}),customer:{id:customerId}}
      :getSendEligibility({supabase,workspaceId,phone,category:'invoice_updates'});
    const channel = channelFactory({supabase, provider,allowInvoiceWrites:Boolean(authorizeScope),
      ...pending,
      createInvoiceStore: scope => invoiceStoreFactory({supabase, workspaceId: scope.workspaceId, customerId: scope.customerId}),
      authorizeChannel: async scope => {
        const eligibility = await eligible();
        return {allowed: eligibility.allowed && eligibility.customer?.id === scope.customerId,
          workspaceId: scope.workspaceId, customerId: scope.customerId, phone: scope.phone};
      },
    });
    if (media || mediaError) {
      // This durable tombstone is written before extraction. Its row/version
      // token prevents an older extraction or currency reply from reviving a
      // review replaced by this photo.
      const token = await pending.beginInvoiceReview({workspaceId, customerId, phone});
      if (token?.action?.stage === 'saving') return 'That invoice is being saved. Wait for it to finish before sending a replacement photo.';
      if (mediaError) return "I couldn’t load that photo. The earlier review was discarded. Send the photo again.";
      let extracted = null;
      let review = null;
      try {
        const {data: workspace, error: workspaceError} = await supabase.from('workspace_settings').select('business_name,default_currency')
          .eq('workspace_id', workspaceId).maybeSingle();
        if (workspaceError) throw workspaceError;
        // Media extraction is deliberately independent of the workspace's chat
        // model choice. This preserves conversational behavior while using the
        // vision-capable extraction chain and its separately configured keys.
        const extractionProvider = providerFactory({primaryModel: DEFAULT_EXTRACTION_MODEL,
          fallbackModel: DEFAULT_EXTRACTION_FALLBACK_MODEL, requestPurpose: 'extraction', geminiApiKey: env.GEMINI_API_KEY,
          openRouterApiKey: env.OPENROUTER_API_KEY, zenApiKey: env.OPENCODE_ZEN_API_KEY,
          fetchImpl, timeoutMs: 12_000, maxAttempts: 1});
        // Reserve invocation time for validation, pending-action persistence,
        // the scoped reply claim/send, and durable completion.
        const extractionDeadlineAt = Math.min(Number.isFinite(deadlineAt) ? deadlineAt : Infinity, Date.now() + 28_000);
        extracted = await extract({provider: extractionProvider, ...media,
          businessName: workspace?.business_name || '', signal, deadlineAt: extractionDeadlineAt, logger});
        active();
        if (audience !== 'owner' && extracted?.direction?.value === 'payable' && extracted.direction.confidence >= 0.75) {
          await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone, fromStage: 'extracting',
            action: {...reviewDraft(extracted,messageId), stage: 'canceled'}});
          return 'This looks like a bill your business owes, so nothing was saved.';
        }
        const currencyResult = inferInvoiceCurrency(extracted, extracted?.rawText || '', workspace?.default_currency || 'INR');
        if (currencyResult.unsupportedCurrency) {
          await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone, fromStage: 'extracting',
            action: {...reviewDraft(extracted,messageId), stage: 'canceled'}});
          return `The invoice uses ${currencyResult.unsupportedCurrency}, which cannot be saved. ${CURRENCY_SUPPORT_MESSAGE} Nothing was saved.`;
        }
        const assumptions = [];
        const invoiceDate = extracted?.invoiceDate?.value && extracted.invoiceDate.confidence >= 0.75
          ? extracted.invoiceDate.value : todayInKolkata(clock());
        if (invoiceDate !== extracted?.invoiceDate?.value) assumptions.push('invoice date was not shown, so today in Asia/Kolkata was used');
        const due = audience === 'owner'
          ? {dueDate: extracted?.dueDate?.confidence >= .75 ? extracted.dueDate.value : null,
            source: extracted?.dueDate?.value && extracted.dueDate.confidence >= .75 ? 'printed' : 'not shown'}
          : deriveInvoiceDueDate(invoiceDate,
          extracted?.dueDate?.confidence >= 0.75 ? extracted.dueDate.value : null,
          extracted?.paymentTerms?.value || extracted?.notes?.value || '');
        if (due.source.startsWith('derived')) assumptions.push(`due date ${due.source}`);
        if (currencyResult.assumed && audience !== 'owner') assumptions.push(currencyResult.source);
        if (audience !== 'owner' && (extracted?.direction?.value !== 'receivable' || extracted.direction.confidence < 0.75)) {
          assumptions.push('direction assumed to be an invoice you issued');
        }
        const invoice = {invoiceNumber: extracted?.invoiceNumber?.value || null, clientName: extracted?.customerName?.value ?? null,
          clientEmail: extracted?.clientEmail?.value ?? null, clientPhone: extracted?.clientPhone?.value ?? null,
          clientPhoneRaw: extracted?.clientPhoneRaw?.value ?? null,
          invoiceDate, dueDate: due.dueDate, subtotal: extracted?.subtotal?.value ?? null,
          tax: extracted?.tax?.value ?? null, total: extracted?.total?.value ?? null,
          outstanding: extracted?.outstandingAmount?.value ?? extracted?.total?.value ?? null,
          currency: currencyResult.currency, notes: extracted?.notes?.value ?? null, alreadyPaid: false,
          direction: 'receivable', lineItems: extracted?.lineItems?.value || []};
        // An unusable printed contact must not block saving the invoice itself.
        try { invoice.clientPhone = normalizeOwnerPhone(invoice.clientPhone); }
        catch { invoice.clientPhone = null; }
        const validationIssues = extractionValidationIssues(extracted);
        const missing = ['invoiceNumber', 'customerName', 'total'].filter(field => extracted?.[field]?.value == null
          || extracted[field].confidence < 0.75 || field === 'total' && extracted[field].value <= 0);
        let validatedInvoice;
        try { validatedInvoice = approvedInvoice(invoice); }
        catch (validationError) {
          // Successful extraction with incomplete or conflicting invoice facts
          // is a review outcome, not an unavailable extraction provider.
          if (validationError?.status !== 422) throw validationError;
          const field = {CLIENT_REQUIRED:'customerName', INVOICE_NUMBER_REQUIRED:'invoiceNumber',
            INVOICE_DATE_REQUIRED:'invoiceDate', INVALID_DUE_DATE:'dueDate', CURRENCY_REQUIRED:'currency',
            INVOICE_TOTAL_REQUIRED:'total', INVOICE_TOTAL_MUST_BE_POSITIVE:'total',
            INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX:'total'}[validationError.code];
          if (field && !missing.includes(field)) missing.push(field);
          if (!field || validationError.code === 'INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX') {
            validationIssues.push(validationError.code);
          }
        }
        if (audience === 'owner') {
          // An attached bill/ambiguous dollar symbol needs owner clarification,
          // not cancellation or an inferred receivable/currency. Keep source
          // facts in the same review; continuation still requires owner evidence.
          const unresolved = reviewDraft(extracted, messageId).missingFields;
          if (unresolved.includes('currency')) {
            missing.push('currency'); invoice.currency = extracted?.currency?.value ?? null;
          }
          if (unresolved.includes('direction')) {
            missing.push('direction'); invoice.direction = extracted?.direction?.value ?? 'uncertain';
          }
        }
        if (missing.length || validationIssues.length) {
          review = {...reviewDraft(extracted, messageId), invoice, missingFields: [...new Set(missing)],
            validationIssues: [...new Set(validationIssues)], failureCode: 'INVOICE_REVIEW_INCOMPLETE',
            currencySource: missing.includes('currency') ? null : 'photo', currencyEvidence: missing.includes('currency') ? null : currencyResult.source,
            dueDateSource: due.source, assumptions, warnings: extracted?.warnings || []};
          const stored = await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone,
            fromStage: 'extracting', action: review});
          return stored ? invoiceReviewClarification(review) : 'A newer photo replaced this review. Nothing from this photo was saved.';
        }
        active();
        // The database only allows extracting -> proposal -> saving, and requires
        // currencySource to be the marker 'photo' or 'user'. The readable evidence
        // is kept separately for the reply.
        const proposal = {type: 'invoice_review_draft', stage: 'proposal', invoice: validatedInvoice,sourceMessageId:messageId,
          missingFields: [], currencySource: 'photo', currencyEvidence: currencyResult.source,
          dueDateSource: due.source, assumptions};
        const proposed = await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone,
          fromStage: 'extracting', action: proposal});
        if (!proposed) return 'A newer photo replaced this review. Nothing from this photo was saved.';
        return proposalSummary(validatedInvoice);

      } catch (error) {
        const failureCode = Object.hasOwn(INVOICE_IMAGE_REPLIES, error?.code || '') ? error.code
          : extracted ? 'INVOICE_REVIEW_UNAVAILABLE' : 'EXTRACTION_UNAVAILABLE';
        const failureReason = error?.code === 'TIMEOUT' || error?.name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE';
        const failureStatus = failureReason === 'TIMEOUT' ? 504
          : Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
        const failedReview = {...(review || reviewDraft(extracted, messageId)), stage: 'canceled', failureCode,
          failureReason, failureStatus};
        logger?.error?.('WhatsApp invoice review failed', {workspaceId, code: failureCode,
          reason: failureReason, status: failureStatus});
        await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone, fromStage: 'extracting',
          action: failedReview}).catch(() => null);
        return invoiceReviewClarification(failedReview);
      }
    }
    if (authorizeScope) {
      const answer = await answerDebtorPhone({pending,
        storeFactory: () => invoiceStoreFactory({supabase, workspaceId, customerId}),
        scope: {workspaceId, customerId, phone}, message, contactCard, clock});
      if (answer) return answer;
    } else {
      let contactPending = null;
      try { contactPending = await pending.loadPendingAction?.({workspaceId, customerId, phone}); } catch {}
      if (contactCard || contactPending?.action?.type === 'invoice_debtor_phone') {
        return 'Only the business owner can change invoice contacts. Contact the business for help.';
      }
    }
    const current = await pending.loadInvoiceReview({workspaceId, customerId, phone});
    let effective = message;
    if (/^\s*INV-[A-Z0-9-]+\s*[.!]?\s*$/i.test(message)) {
      try {
        const turns = await readConversationHistory({supabase, workspaceId, phone,customerId,audience});
        const last = turns.at(-1);
        if (last?.role === 'assistant' && ASK_NUMBER.test(last.content || '')) {
          const original = [...turns].reverse().find(turn => turn.role === 'user');
          if (original) effective = `${original.content} ${message.trim().replace(/[.!]$/, '')}`;
        }
      } catch { /* fall through to normal routing */ }
    }
    contactLookup: if ((CONTACT_PHONE_REQUEST.test(message) || CONTACT_EMAIL_REQUEST.test(message)) && !parseInvoiceCorrection(effective, clock)
      && !/\b(?:your|you|my own)\b/i.test(message)) {
      try {
        const store = await invoiceStoreFactory({supabase, workspaceId, customerId});
        const known = await store.findInvoices({limit: 50});
        const number = requestedInvoiceNumber(message);
        const hint = invoiceHint(message.replace(/\b(?:contact|phone|mobile|whatsapp|call|number|e-?mail|address|info|details?|what'?s|whats|what|is|the|for|of|this|that|invoice|bill)\b/gi, ' '));
        let candidates = number ? known.filter(item => [item.invoiceNumber, item.printedInvoiceNumber].some(n => String(n || '').toUpperCase() === number)) : [];
        if (!candidates.length && hint) candidates = matchInvoicesByHint(known, hint);
        const refersToInvoice = /\b(?:invoice|bill|customer|client|debtor|this|that|him|her|them)\b/i.test(message);
        if (!candidates.length && !refersToInvoice) break contactLookup;
        if (!candidates.length) {
          let turns = [];
          try { turns = await readConversationHistory({supabase, workspaceId, phone,customerId,audience}); } catch { /* optional */ }
          for (const turn of [...turns].reverse()) {
            const mentioned = String(turn.content || '').match(/\bINV-[A-Z0-9-]+\b/ig) || [];
            const hit = known.find(item => mentioned.some(m => [item.invoiceNumber, item.printedInvoiceNumber].some(n => String(n || '').toUpperCase() === m.toUpperCase())));
            if (hit) { candidates = [hit]; break; }
          }
        }
        if (!candidates.length && known.length) candidates = [[...known].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]];
        if (!candidates.length) return "I couldn't find an invoice to look up.";
        return contactAnswer(candidates[0], {wantPhone: CONTACT_PHONE_REQUEST.test(message) || !CONTACT_EMAIL_REQUEST.test(message), wantEmail: CONTACT_EMAIL_REQUEST.test(message)});
      } catch (contactError) {
        logger?.error?.('WhatsApp contact lookup failed', {workspaceId, message: String(contactError?.message || '').slice(0, 200)});
        return "I couldn’t read that invoice’s contact details. Try again in a minute.";
      }
    }
    let correction = parseInvoiceCorrection(effective, clock);
    let modelIntent = null;
    const askNumber = async reply => {
      for (const [role, content] of [['user', message], ['assistant', reply]]) {
        try { await writeConversationTurn({supabase, workspaceId, customerId, phone, role, content,audience}); } catch { /* best effort */ }
      }
      return reply;
    };
    const editLike = INTENT_REQUEST.test(effective);
    if (correction?.changes?.status === 'paid' || /\b(?:mark|make|set|change)\b.{0,40}\b(?:paid|paod|piad|payed|pad|settled)\b/i.test(effective)) {
      return 'Only the business owner can record payments. Ask them to record this in cetld or their linked WhatsApp chat.';
    }
    if (!correction && editLike && !FILE_REQUEST.test(message)) {
      try {
        const intentStore = await invoiceStoreFactory({supabase, workspaceId, customerId});
        const known = await intentStore.findInvoices({limit: 50});
        let history = [];
        try { history = await readConversationHistory({supabase, workspaceId, phone,customerId,audience}); } catch { /* optional context */ }
        const intentProvider = providerFactory({primaryModel: DEFAULT_EXTRACTION_MODEL,
          fallbackModel: DEFAULT_EXTRACTION_FALLBACK_MODEL, requestPurpose: 'extraction', geminiApiKey: env.GEMINI_API_KEY,
          openRouterApiKey: env.OPENROUTER_API_KEY, zenApiKey: env.OPENCODE_ZEN_API_KEY,
          fetchImpl, timeoutMs: 8000, maxAttempts: 1});
        modelIntent = await classifyIntent({provider: intentProvider, message: effective, history, invoices: known, signal, deadlineAt});
        if (modelIntent.action === 'correct_invoice' && modelIntent.confidence >= 0.75) {
          correction = {changes: {[modelIntent.field]: modelIntent.value,
            ...(modelIntent.currency && modelIntent.field === 'total' ? {currency: modelIntent.currency} : {})},
            ...(modelIntent.customerHint ? {hint: modelIntent.customerHint} : {})};
        }
      } catch (intentError) {
        logger?.error?.('WhatsApp intent classification failed', {workspaceId,
          message: String(intentError?.message || '').slice(0, 200)});
        correction = parseInvoiceCorrection(effective, clock);
      }
      const strongEdit = /\b(?:change|chnge|chng|set|edit|modify|fix|update)\b/i.test(effective);
      if (!correction && (!modelIntent ? strongEdit : (modelIntent.action === 'unknown' || modelIntent.confidence < 0.75) && strongEdit)) {
        return askNumber('What would you like to change, and what should the new value be?');
      }
    }
    const fileRequest = FILE_REQUEST.test(message) || modelIntent?.action === 'send_invoice_file' && modelIntent.confidence >= 0.75;
    const listRequest = modelIntent?.action === 'list_invoices' && modelIntent.confidence >= 0.75;
    if (correction || fileRequest || listRequest) {
      if(correction&&!authorizeScope)return 'Only the business owner can change invoice details. Contact the business for help.';
      const store = await invoiceStoreFactory({supabase, workspaceId, customerId});
      const explicitNumber = requestedInvoiceNumber(effective) || modelIntent?.invoiceRef;
      let candidates;
      if (listRequest) candidates = await store.findInvoices({limit: 10});
      else if (explicitNumber) candidates = await store.findInvoices({invoiceNumber: explicitNumber});
      else if (correction?.hint || modelIntent?.customerHint) {
        const hint = correction?.hint || modelIntent.customerHint;
        candidates = matchInvoicesByHint(await store.findInvoices({limit: 50}), hint);
        if (!candidates.length) return askNumber(`I couldn’t find an invoice for “${hint}”. Which invoice number should I use?`);
      }
      else if (current?.action?.stage === 'saved' && current.action.invoice?.id) candidates = [current.action.invoice];
      else candidates = await store.findInvoices();
      if (!candidates.length) return explicitNumber ? `I couldn't find invoice ${explicitNumber}.`
        : listRequest ? "I couldn't find any invoices." : "I couldn't find a recent invoice to change.";
      if (listRequest) return candidates.slice(0, 10).map(item => `• ${item.printedInvoiceNumber || item.invoiceNumber} — ${item.clientName || 'Unknown customer'}`).join('\n') || 'I couldn’t find any invoices.';
      if (candidates.length > 1) return askNumber('Which invoice number should I use?');
      const target = candidates[0];
      if (fileRequest) {
        const file = await store.latestInvoiceFile(target.id);
        return file ? {answer: `Here is invoice ${target.printedInvoiceNumber || target.invoiceNumber}.`, media: file}
          : `I don't have a stored file for invoice ${target.printedInvoiceNumber || target.invoiceNumber}.`;
      }
      if (correction.changes.total != null && !(correction.changes.total > 0)) return 'I can’t change the amount because an invoice total must be positive.';
      if (correction.changes.currency && !isSupportedCurrency(correction.changes.currency)) return `I can’t change the currency to ${correction.changes.currency}. ${CURRENCY_SUPPORT_MESSAGE}`;
      if (Object.values(correction.changes).some(value => value === null || value === '')) return 'I can’t apply that change because the new value is invalid.';
      let result;
      try {
        result = await store.applyCorrection({invoiceId: target.id, changes: correction.changes,
          idempotencyKey: `wa_correction_${messageId || createHash('sha256').update(`${phone}:${message}`).digest('hex')}`,
          changedAt: clock().toISOString()});
      } catch (error) {
        console.error('WhatsApp invoice correction failed', error?.message || error);
        return 'I couldn’t safely apply that invoice change. Nothing was changed. Try again.';
      }
      if (result.reason === 'use_dashboard_for_payment') return 'Only the business owner can record payments. Ask them to record this in cetld or their linked WhatsApp chat.';
      if (result.reason === 'settled') return 'I can’t edit this invoice because it is already paid or settled.';
      if (result.reason === 'payments_exceed_total') return 'I can’t lower the total below payments already recorded on this invoice.';
      if (result.reason) return 'I couldn’t safely apply that invoice change.';
      return result.duplicate && !Object.keys(result.changes).length ? 'That change was already applied.' : correctionReply(result.changes);
    }
    if (current?.action?.type === 'invoice_review_draft') {
      if(!authorizeScope)return 'Only the business owner can create or change invoices. Contact the business for help.';
      const eligibility = await eligible();
      if (!eligibility.allowed || eligibility.customer?.id !== customerId) {
        return 'Verify your number in cetld to continue this invoice review.';
      }
      const action = current.action;
      if (CANCEL_REPLY.test(message)) {
        if (action.stage === 'saved') return 'That invoice was already saved, so cancel can’t undo it.';
        if (action.stage === 'saving') return 'That invoice is already being saved and can’t be canceled now.';
        if (action.stage === 'canceled') return 'Invoice review is already canceled. Nothing new was saved.';
        if (!['extracting', 'incomplete', 'proposal', 'failed'].includes(action.stage)) return 'That invoice review can’t be canceled in its current state.';
        const canceled = await pending.transitionInvoiceReview({...current, workspaceId, customerId, phone,
          fromStage: action.stage, action: {...action, stage: 'canceled'}});
        if (canceled) return 'Invoice review canceled. Nothing was saved.';
        const latest = await pending.loadInvoiceReview({workspaceId, customerId, phone});
        if (latest?.action?.stage === 'saved') return 'That invoice was already saved, so cancel can’t undo it.';
        if (latest?.action?.stage === 'saving') return 'That invoice is already being saved and can’t be canceled now.';
        if (latest?.action?.stage === 'canceled') return 'Invoice review is already canceled. Nothing new was saved.';
        return 'That review was replaced by a newer request; its current status was not changed.';
      }
      if (CONFIRMATION_REPLY.test(message) && ['incomplete', 'extracting', 'failed', 'canceled'].includes(action.stage)) {
        return action.stage === 'canceled'
          ? 'That review was canceled. Send a new photo to start again.'
          : 'The review is incomplete. Send the missing details or a clearer photo before confirming.';
      }
      if (OWNER_CLAIM.test(message) && ['incomplete', 'extracting', 'failed', 'canceled'].includes(action.stage)) {
        return 'Saying you’re the owner doesn’t grant access. Verify ownership in cetld; this review still can’t be confirmed.';
      }
      const candidate = CURRENCY_REPLY.exec(message)?.[1]?.toUpperCase();
      const currency = candidate && isSupportedCurrency(candidate) ? candidate : null;
      if (action.stage === 'incomplete' && !action.validationIssues?.length
        && action.missingFields?.length === 1 && action.missingFields[0] === 'currency') {
        if (!currency) return 'Reply with a supported currency code, like USD or INR.';
        const invoice = approvedInvoice({...action.invoice, currency});
        const next = {...action, stage: 'proposal', invoice, missingFields: [], currencySource: 'user'};
        const stored = await pending.transitionInvoiceReview({...current, workspaceId, customerId, phone,
          fromStage: 'incomplete', action: next});
        if (stored) return proposalSummary(invoice);
        const latest = await pending.loadInvoiceReview({workspaceId, customerId, phone});
        if (latest?.action?.stage === 'proposal') return proposalSummary(latest.action.invoice);
        return 'A newer photo replaced that review. Continue with the newer one.';
      }
      if (currency && action.stage === 'proposal') return proposalSummary(action.invoice);
    }
    let history = [];
    try { history = await readConversationHistory({supabase, workspaceId, phone,customerId,audience}); }
    catch (memoryError) {
      logger?.error?.('WhatsApp conversation memory read failed', {workspaceId,
        message: String(memoryError?.message || '').slice(0, 200)});
    }
    try { await writeConversationTurn({supabase, workspaceId, customerId, phone, role: 'user', content: message,audience}); }
    catch (memoryError) {
      logger?.error?.('WhatsApp conversation memory write failed', {workspaceId, role: 'user',
        message: String(memoryError?.message || '').slice(0, 200)});
    }
    const input = {workspaceId, customerId, phone, message, history};
    if (!String(message || '').trim()) return '';
    let response;
    try { response = await channel.ask(input); }
    catch (error) {
      logger?.error?.('WhatsApp assistant ask failed', {workspaceId, name: error?.name, message: String(error?.message || '').slice(0, 200)});
      return 'I hit a hiccup. Send that again in a minute. Nothing was changed.';
    }
    // Planner failures are safe, read-only fallbacks. Retry only this narrowly
    // identified class, once, to absorb transient free-tier provider failures.
    if (response?.model === null && response?.usedFallback === true) {
      try { response = await channel.ask(input); } catch { /* keep the first fallback answer */ }
    }
    const answer = typeof response?.answer === 'string' ? response.answer : '';
    if (response?.model !== null || response?.usedFallback !== true) return answer;
    return {answer, plannerFailure: response?.evidence?.plannerFailure || null};
  };
}
