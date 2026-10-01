import {AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  sanitizeModelSettings} from '../../ai/provider.mjs';
import {createWhatsAppAssistantChannel} from '../../ai/whatsapp-channel.mjs';
import {getSendEligibility} from './consent.mjs';
import {readConversationHistory, writeConversationTurn} from './conversation-memory.mjs';
import {extractInvoice} from '../../ai/extraction.mjs';
import {createWhatsAppPendingActionStore} from './pending-actions.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';
import {validateAssistantInvoice} from '../../ai/invoice-ops.mjs';
import {saveAssistantInvoice} from '../../ai/invoice-ops.mjs';
import {createHash} from 'node:crypto';
import {CURRENCY_SUPPORT_MESSAGE, isSupportedCurrency} from '../../currency-contract.mjs';
import {deriveInvoiceDueDate, inferInvoiceCurrency, todayInKolkata} from '../../ai/invoice-photo-inference.mjs';
import {classifyIntent} from './intent.mjs';

const requiredInvoiceFields = ['invoiceNumber','customerName','invoiceDate','dueDate','total','currency','direction'];
const fieldLabels = {invoiceNumber: 'invoice number', customerName: 'customer name', invoiceDate: 'invoice date',
  dueDate: 'due date', total: 'total', currency: 'explicit currency code (for example INR or USD)',
  direction: 'confirmation that your business issued the invoice'};

function clarification(extracted) {
  const missing = requiredInvoiceFields.filter(name => extracted?.[name]?.value == null
    || extracted[name].confidence < 0.75 || (name === 'direction' && extracted[name].value !== 'receivable'));
  const details = missing.map(name => fieldLabels[name]);
  return `I could only prepare a partial review. Please reply with ${details.join(', ')}. I won't save anything until I can show you a complete proposal and you explicitly confirm it.`;
}

function invoiceProposal(extracted) {
  if (requiredInvoiceFields.some(name => extracted?.[name]?.value == null || extracted[name].confidence < 0.75)
    || extracted.direction.value !== 'receivable') return null;
  return {invoiceNumber: extracted.invoiceNumber.value, clientName: extracted.customerName.value,
    clientEmail: extracted.clientEmail.value, clientPhone: extracted.clientPhone.value,
    invoiceDate: extracted.invoiceDate.value, dueDate: extracted.dueDate.value,
    subtotal: extracted.subtotal.value, tax: extracted.tax.value, total: extracted.total.value,
    outstanding: extracted.outstandingAmount.value ?? extracted.total.value, currency: extracted.currency.value,
    notes: extracted.notes.value, alreadyPaid: false, direction: 'receivable', lineItems: extracted.lineItems.value};
}

function missingFields(extracted) {
  return requiredInvoiceFields.filter(name => extracted?.[name]?.value == null
    || extracted[name].confidence < 0.75 || (name === 'direction' && extracted[name].value !== 'receivable'));
}

function reviewDraft(extracted) {
  const invoice = invoiceProposal(extracted) || {
    invoiceNumber: extracted?.invoiceNumber?.value ?? null, clientName: extracted?.customerName?.value ?? null,
    clientEmail: extracted?.clientEmail?.value ?? null, clientPhone: extracted?.clientPhone?.value ?? null,
    invoiceDate: extracted?.invoiceDate?.value ?? null, dueDate: extracted?.dueDate?.value ?? null,
    subtotal: extracted?.subtotal?.value ?? null, tax: extracted?.tax?.value ?? null,
    total: extracted?.total?.value ?? null,
    outstanding: extracted?.outstandingAmount?.value ?? extracted?.total?.value ?? null,
    currency: extracted?.currency?.value ?? null, notes: extracted?.notes?.value ?? null,
    alreadyPaid: false, direction: extracted?.direction?.value ?? null,
    lineItems: Array.isArray(extracted?.lineItems?.value) ? extracted.lineItems.value : [],
  };
  return {type: 'invoice_review_draft', stage: 'incomplete', invoice,
    missingFields: missingFields(extracted), currencySource: null};
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

function proposalSummary(invoice) {
  return `🧾 *Invoice ready to save*\n• ${invoice.invoiceNumber} — ${invoice.clientName}\n• ${invoice.currency} ${invoice.total.toLocaleString('en-IN')}\n${invoice.dueDate ? `• Due: ${invoice.dueDate}\n` : ''}\nSave it? Reply yes to confirm.`;
}

function money(currency, amount) {
  return new Intl.NumberFormat('en-US', {style: 'currency', currency, minimumFractionDigits: 2,
    maximumFractionDigits: 2}).format(amount);
}

function loggedSummary(invoice, {currencySource, dueDateSource, assumptions, fileKept = true}) {
  return [`Logged invoice ${invoice.invoiceNumber}.`, `Invoice number: ${invoice.invoiceNumber}`,
    invoice.printedInvoiceNumber ? `Printed invoice number: ${invoice.printedInvoiceNumber}` : null,
    `Customer: ${invoice.clientName}`, `Total: ${money(invoice.currency, invoice.total)} ${invoice.currency}`,
    `Invoice date: ${invoice.invoiceDate}`, `Due date: ${invoice.dueDate || 'not shown on the invoice'}`,
    `Currency source: ${invoice.currency}, ${currencySource}`,
    assumptions.length ? `Assumptions: ${assumptions.join('; ')}` : null, fileKept ? null : 'The invoice was saved, but the original file was not kept.',
    "Reply with any corrections, like 'change the due date to 2026-08-19'."].filter(Boolean).join('\n');
}

/** Create an inbound assistant handler only after the webhook has verified Meta. */
export function createWhatsAppBoundMessageHandler({env = process.env, fetchImpl = fetch, supabase,
  providerFactory = options => new AIProvider(options), channelFactory = createWhatsAppAssistantChannel,
  extract = extractInvoice, pendingActionStoreFactory = createWhatsAppPendingActionStore,
  invoiceStoreFactory = createWhatsAppInvoiceStore, saveInvoice = saveAssistantInvoice,
  clock = () => new Date(), logger = console} = {}) {
  if (!supabase?.from) throw new TypeError('A server-side Supabase client is required');

  return async ({workspaceId, customerId, phone, message, messageId, media, mediaError, signal, deadlineAt}) => {
    const active = () => {
      if (signal?.aborted || (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt)) throw Object.assign(new Error('Inbound processing deadline expired'), {name: 'AbortError'});
    };
    active();
    const {data: settings, error} = await supabase.from('workspace_ai_settings')
      .select('primary_model,fallback_model').eq('workspace_id', workspaceId).maybeSingle();
    if (error) throw error;
    const models = sanitizeModelSettings({primaryModel: settings?.primary_model,
      fallbackModel: settings?.fallback_model});
    const provider = providerFactory({...models, geminiApiKey: env.GEMINI_API_KEY,
      openRouterApiKey: env.OPENROUTER_API_KEY, zenApiKey: env.OPENCODE_ZEN_API_KEY,
      fetchImpl, timeoutMs: 8000, maxAttempts: 1});
    const pending = pendingActionStoreFactory({supabase});
    const channel = channelFactory({supabase, provider,
      ...pending,
      createInvoiceStore: scope => invoiceStoreFactory({supabase, workspaceId: scope.workspaceId, customerId: scope.customerId}),
      authorizeChannel: async scope => {
        const eligibility = await getSendEligibility({supabase, workspaceId: scope.workspaceId,
          phone: scope.phone, category: 'invoice_updates'});
        return {allowed: eligibility.allowed && eligibility.customer?.id === scope.customerId,
          workspaceId: scope.workspaceId, customerId: scope.customerId, phone: scope.phone};
      },
    });
    if (media || mediaError) {
      // This durable tombstone is written before extraction. Its row/version
      // token prevents an older extraction or currency reply from reviving a
      // review replaced by this photo.
      const token = await pending.beginInvoiceReview({workspaceId, customerId, phone});
      if (token?.action?.stage === 'saving') return 'That invoice is already being saved. Please wait for it to finish before sending a replacement photo.';
      if (mediaError) return "I couldn't fetch that photo. The earlier invoice review was discarded; please resend the photo.";
      try {
        const {data: workspace, error: workspaceError} = await supabase.from('workspace_settings').select('business_name,default_currency')
          .eq('workspace_id', workspaceId).maybeSingle();
        if (workspaceError) throw workspaceError;
        // Media extraction is deliberately independent of the workspace's chat
        // model choice. This preserves conversational behavior while using the
        // vision-capable extraction chain and its separately configured keys.
        const extractionProvider = providerFactory({primaryModel: DEFAULT_EXTRACTION_MODEL,
          fallbackModel: DEFAULT_EXTRACTION_FALLBACK_MODEL, geminiApiKey: env.GEMINI_API_KEY,
          openRouterApiKey: env.OPENROUTER_API_KEY, zenApiKey: env.OPENCODE_ZEN_API_KEY,
          fetchImpl, timeoutMs: 12_000, maxAttempts: 1});
        // Reserve invocation time for validation, pending-action persistence,
        // the scoped reply claim/send, and durable completion.
        const extractionDeadlineAt = Math.min(Number.isFinite(deadlineAt) ? deadlineAt : Infinity, Date.now() + 28_000);
        const extracted = await extract({provider: extractionProvider, ...media,
          businessName: workspace?.business_name || '', signal, deadlineAt: extractionDeadlineAt, logger});
        active();
        if (extracted?.direction?.value === 'payable' && extracted.direction.confidence >= 0.75) {
          await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone, fromStage: 'extracting',
            action: {...reviewDraft(extracted), stage: 'canceled'}});
          return 'This looks like a bill your business owes, so nothing was saved.';
        }
        if (!extracted?.customerName?.value || extracted.customerName.confidence < 0.75
          || extracted?.total?.value == null || extracted.total.confidence < 0.75 || extracted.total.value <= 0) {
          await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone, fromStage: 'extracting',
            action: {...reviewDraft(extracted), stage: 'canceled'}});
          return "I couldn't reliably read the customer name and total. Please send a clearer photo. Nothing was saved.";
        }
        const currencyResult = inferInvoiceCurrency(extracted, extracted?.rawText || '', workspace?.default_currency || 'INR');
        if (currencyResult.unsupportedCurrency) {
          await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone, fromStage: 'extracting',
            action: {...reviewDraft(extracted), stage: 'canceled'}});
          return `The invoice uses ${currencyResult.unsupportedCurrency}, which cannot be saved. ${CURRENCY_SUPPORT_MESSAGE} Nothing was saved.`;
        }
        const assumptions = [];
        const invoiceDate = extracted?.invoiceDate?.value && extracted.invoiceDate.confidence >= 0.75
          ? extracted.invoiceDate.value : todayInKolkata(clock());
        if (invoiceDate !== extracted?.invoiceDate?.value) assumptions.push('invoice date was not shown, so today in Asia/Kolkata was used');
        const due = deriveInvoiceDueDate(invoiceDate,
          extracted?.dueDate?.confidence >= 0.75 ? extracted.dueDate.value : null,
          extracted?.paymentTerms?.value || extracted?.notes?.value || '');
        if (due.source.startsWith('derived')) assumptions.push(`due date ${due.source}`);
        if (currencyResult.assumed) assumptions.push(currencyResult.source);
        if (extracted?.direction?.value !== 'receivable' || extracted.direction.confidence < 0.75) {
          assumptions.push('direction assumed to be an invoice you issued');
        }
        const invoice = {invoiceNumber: extracted?.invoiceNumber?.value || 'AUTO', clientName: extracted.customerName.value,
          clientEmail: extracted?.clientEmail?.value ?? null, clientPhone: extracted?.clientPhone?.value ?? null,
          invoiceDate, dueDate: due.dueDate, subtotal: extracted?.subtotal?.value ?? null,
          tax: extracted?.tax?.value ?? null, total: extracted.total.value,
          outstanding: extracted?.outstandingAmount?.value ?? extracted.total.value,
          currency: currencyResult.currency, notes: extracted?.notes?.value ?? null, alreadyPaid: false,
          direction: 'receivable', lineItems: extracted?.lineItems?.value || []};
        const validatedInvoice = approvedInvoice(invoice);
        active();
        // The database only allows extracting -> proposal -> saving, and requires
        // currencySource to be the marker 'photo' or 'user'. The readable evidence
        // is kept separately for the reply.
        const proposal = {type: 'invoice_review_draft', stage: 'proposal', invoice: validatedInvoice,
          missingFields: [], currencySource: 'photo', currencyEvidence: currencyResult.source,
          dueDateSource: due.source, assumptions};
        const proposed = await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone,
          fromStage: 'extracting', action: proposal});
        if (!proposed) return 'A newer photo replaced this review. Nothing from this photo was saved.';
        const action = {...proposal, stage: 'saving'};
        const claimed = await pending.transitionInvoiceReview({...proposed, workspaceId, customerId, phone,
          fromStage: 'proposal', action});
        if (!claimed) return 'A newer photo replaced this review. Nothing from this photo was saved.';
        const key = `wa_invoice_${createHash('sha256').update(`${workspaceId}:${customerId}:${phone}:${token.id}`).digest('hex').slice(0, 32)}`;
        try {
          const saved = await saveInvoice({store: await invoiceStoreFactory({supabase, workspaceId, customerId}),
            invoice: validatedInvoice, confirmed: true, idempotencyKey: key, accounting: null, allowMissingDueDate: true});
          if (saved?.needsInput || !saved?.invoice) throw new TypeError('invoice save returned no invoice');
          const savedInvoice = {...saved.invoice, clientName: saved.invoice.clientName || validatedInvoice.clientName,
            printedInvoiceNumber: validatedInvoice.invoiceNumber === 'AUTO' ? null : validatedInvoice.invoiceNumber};
          let fileKept = true;
          try {
            const invoiceStore = await invoiceStoreFactory({supabase, workspaceId, customerId});
            await invoiceStore.keepInvoiceFile({invoiceId: savedInvoice.id, bytes: media.bytes,
              fileName: media.fileName || (media.mimeType === 'application/pdf' ? 'invoice.pdf' : 'invoice-image'),
              mimeType: media.mimeType, idempotencyKey: `${messageId || token.id}-${media.fileName || 'invoice'}`.replace(/[^a-zA-Z0-9._-]/g, '-')});
          } catch (fileError) {
            fileKept = false;
            logger?.error?.('WhatsApp invoice file persistence failed', {workspaceId, invoiceId: savedInvoice.id,
              message: String(fileError?.message || '').slice(0, 200)});
          }
          const completed = await pending.transitionInvoiceReview({...claimed, workspaceId, customerId, phone,
            fromStage: 'saving', action: {...action, stage: 'saved', invoice: savedInvoice}});
          if (!completed) return 'The invoice was saved, but I could not finish its WhatsApp status update. Please check cetld before retrying.';
          return loggedSummary(savedInvoice, {currencySource: currencyResult.source, dueDateSource: due.source, assumptions, fileKept});
        } catch (saveError) {
          await pending.transitionInvoiceReview({...claimed, workspaceId, customerId, phone,
            fromStage: 'saving', action: {...action, stage: 'failed'}}).catch(() => null);
          logger?.error?.('WhatsApp invoice save failed', {workspaceId, code: String(saveError?.code || saveError?.name || 'SAVE_FAILED').slice(0, 80)});
          return `The invoice was NOT saved because ${saveError?.code === 'UNSUPPORTED_CURRENCY' ? 'its currency is not supported' : 'cetld could not save it right now'}. Please send the photo again to retry.`;
        }
      } catch (error) {
        logger?.error?.('WhatsApp invoice extraction failed', {workspaceId,
          message: String(error?.message || '').slice(0, 200)});
        await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone, fromStage: 'extracting',
          action: {type: 'invoice_review_draft', stage: 'canceled'}}).catch(() => null);
        return "I couldn't reliably read that invoice. Please send a clearer photo. Nothing was saved.";
      }
    }
    const current = await pending.loadInvoiceReview({workspaceId, customerId, phone});
    let effective = message;
    if (/^\s*INV-[A-Z0-9-]+\s*[.!]?\s*$/i.test(message)) {
      try {
        const turns = await readConversationHistory({supabase, workspaceId, phone});
        const last = turns.at(-1);
        if (last?.role === 'assistant' && ASK_NUMBER.test(last.content || '')) {
          const original = [...turns].reverse().find(turn => turn.role === 'user');
          if (original) effective = `${original.content} ${message.trim().replace(/[.!]$/, '')}`;
        }
      } catch { /* fall through to normal routing */ }
    }
    let correction = parseInvoiceCorrection(effective, clock);
    let modelIntent = null;
    const askNumber = async reply => {
      for (const [role, content] of [['user', message], ['assistant', reply]]) {
        try { await writeConversationTurn({supabase, workspaceId, customerId, phone, role, content}); } catch { /* best effort */ }
      }
      return reply;
    };
    const editLike = INTENT_REQUEST.test(effective);
    if (!correction && /\b(?:mark|make|set|change)\b.{0,30}\bpaid\b/i.test(effective)) {
      return 'Payments are recorded in the cetld dashboard, so I can’t mark this paid from WhatsApp.';
    }
    if (!correction && editLike && !FILE_REQUEST.test(message)) {
      try {
        const intentStore = await invoiceStoreFactory({supabase, workspaceId, customerId});
        const known = await intentStore.findInvoices({limit: 50});
        let history = [];
        try { history = await readConversationHistory({supabase, workspaceId, phone}); } catch { /* optional context */ }
        modelIntent = await classifyIntent({provider, message: effective, history, invoices: known, signal, deadlineAt});
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
      if (!correction && (!modelIntent || modelIntent.action === 'unknown' || modelIntent.confidence < 0.75)) {
        return askNumber('What would you like to change, and what should the new value be? 🙂');
      }
    }
    const fileRequest = FILE_REQUEST.test(message) || modelIntent?.action === 'send_invoice_file' && modelIntent.confidence >= 0.75;
    const listRequest = modelIntent?.action === 'list_invoices' && modelIntent.confidence >= 0.75;
    if (correction || fileRequest || listRequest) {
      const store = await invoiceStoreFactory({supabase, workspaceId, customerId});
      const explicitNumber = requestedInvoiceNumber(effective) || modelIntent?.invoiceRef;
      let candidates;
      if (listRequest) candidates = await store.findInvoices();
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
        return 'I couldn’t safely apply that invoice change. Nothing was changed, please try again.';
      }
      if (result.reason === 'use_dashboard_for_payment') return 'Payments are recorded in the cetld dashboard, so I can’t mark this paid from WhatsApp.';
      if (result.reason === 'settled') return 'I can’t edit this invoice because it is already paid or settled.';
      if (result.reason === 'payments_exceed_total') return 'I can’t lower the total below payments already recorded on this invoice.';
      if (result.reason) return 'I couldn’t safely apply that invoice change.';
      return result.duplicate && !Object.keys(result.changes).length ? 'That change was already applied.' : correctionReply(result.changes);
    }
    if (current?.action?.type === 'invoice_review_draft') {
      const eligibility = await getSendEligibility({supabase, workspaceId, phone, category: 'invoice_updates'});
      if (!eligibility.allowed || eligibility.customer?.id !== customerId) {
        return 'Please verify your number in cetld before continuing this invoice review.';
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
          ? 'That invoice review was canceled. Please send a new photo to start again.'
          : 'I can’t confirm an incomplete invoice review. Please send the requested details or a clearer photo.';
      }
      if (OWNER_CLAIM.test(message) && ['incomplete', 'extracting', 'failed', 'canceled'].includes(action.stage)) {
        return 'Saying you are the owner does not grant account access. Verify ownership separately in the cetld dashboard; this invoice review still can’t be confirmed.';
      }
      const candidate = CURRENCY_REPLY.exec(message)?.[1]?.toUpperCase();
      const currency = candidate && isSupportedCurrency(candidate) ? candidate : null;
      if (action.stage === 'incomplete' && action.missingFields?.length === 1 && action.missingFields[0] === 'currency') {
        if (!currency) return 'Please reply with a supported 3-letter currency code, such as USD or INR.';
        const invoice = approvedInvoice({...action.invoice, currency});
        const next = {...action, stage: 'proposal', invoice, missingFields: [], currencySource: 'user'};
        const stored = await pending.transitionInvoiceReview({...current, workspaceId, customerId, phone,
          fromStage: 'incomplete', action: next});
        if (stored) return proposalSummary(invoice);
        const latest = await pending.loadInvoiceReview({workspaceId, customerId, phone});
        if (latest?.action?.stage === 'proposal') return proposalSummary(latest.action.invoice);
        return 'That review was replaced by a newer photo. Please continue with the newer review.';
      }
      if (currency && action.stage === 'proposal') return proposalSummary(action.invoice);
    }
    let history = [];
    try { history = await readConversationHistory({supabase, workspaceId, phone}); }
    catch (memoryError) {
      logger?.error?.('WhatsApp conversation memory read failed', {workspaceId,
        message: String(memoryError?.message || '').slice(0, 200)});
    }
    try { await writeConversationTurn({supabase, workspaceId, customerId, phone, role: 'user', content: message}); }
    catch (memoryError) {
      logger?.error?.('WhatsApp conversation memory write failed', {workspaceId, role: 'user',
        message: String(memoryError?.message || '').slice(0, 200)});
    }
    const input = {workspaceId, customerId, phone, message, history};
    if (!String(message || '').trim()) return 'What can I help with? 🙂';
    let response;
    try { response = await channel.ask(input); }
    catch (error) {
      logger?.error?.('WhatsApp assistant ask failed', {workspaceId, name: error?.name, message: String(error?.message || '').slice(0, 200)});
      return 'My brain is having a hiccup right now 😅 Please send that again in a minute. Nothing was changed.';
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
