import {AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  sanitizeModelSettings} from '../../ai/provider.mjs';
import {createWhatsAppAssistantChannel} from '../../ai/whatsapp-channel.mjs';
import {getSendEligibility} from './consent.mjs';
import {readConversationHistory, writeConversationTurn} from './conversation-memory.mjs';
import {extractInvoice} from '../../ai/extraction.mjs';
import {createWhatsAppPendingActionStore} from './pending-actions.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';
import {validateAssistantInvoice} from '../../ai/invoice-ops.mjs';
import {isSupportedCurrency} from '../../currency-contract.mjs';

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

function proposalSummary(invoice) {
  return `🧾 *Invoice ready to save*\n• ${invoice.invoiceNumber} — ${invoice.clientName}\n• ${invoice.currency} ${invoice.total.toLocaleString('en-IN')}\n${invoice.dueDate ? `• Due: ${invoice.dueDate}\n` : ''}\nSave it? Reply yes to confirm.`;
}

/** Create an inbound assistant handler only after the webhook has verified Meta. */
export function createWhatsAppBoundMessageHandler({env = process.env, fetchImpl = fetch, supabase,
  providerFactory = options => new AIProvider(options), channelFactory = createWhatsAppAssistantChannel,
  extract = extractInvoice, pendingActionStoreFactory = createWhatsAppPendingActionStore,
  invoiceStoreFactory = createWhatsAppInvoiceStore, logger = console} = {}) {
  if (!supabase?.from) throw new TypeError('A server-side Supabase client is required');

  return async ({workspaceId, customerId, phone, message, media, mediaError, signal, deadlineAt}) => {
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
      if (mediaError) return "I couldn't fetch that photo. The earlier invoice review was discarded; please resend the photo.";
      try {
        const {data: workspace, error: workspaceError} = await supabase.from('workspace_settings').select('business_name')
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
        const draft = reviewDraft(extracted);
        const invoice = invoiceProposal(extracted);
        if (!invoice) {
          const stored = await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone,
            fromStage: 'extracting', action: draft});
          if (!stored) return 'A newer photo replaced this review. Please continue with the newer photo.';
          if (draft.missingFields.length === 1 && draft.missingFields[0] === 'currency') {
            return 'I found the invoice details, but the currency is not shown clearly. Reply with the 3-letter currency code (for example USD or INR). I won’t save anything until I show the complete proposal and you reply yes.';
          }
          return `${clarification(extracted)} I can only continue from a photo reply when currency is the sole missing field; otherwise send one complete explicit invoice request or a clearer photo.`;
        }
        // Apply the same strict local validation used by Assistant saves before
        // making any proposal confirmable.
        validateAssistantInvoice(invoice);
        active();
        const stored = await pending.transitionInvoiceReview({...token, workspaceId, customerId, phone,
          fromStage: 'extracting', action: {type: 'invoice_review_draft', stage: 'proposal', invoice,
            missingFields: [], currencySource: 'photo'}});
        if (!stored) return 'A newer photo replaced this review. Please continue with the newer photo.';
        return proposalSummary(invoice);
      } catch (error) {
        logger?.error?.('WhatsApp invoice extraction failed', {workspaceId,
          message: String(error?.message || '').slice(0, 200)});
        return "I couldn't extract a review from that image. The earlier review remains discarded. Please send a clearer photo or one complete explicit request with all invoice fields. Nothing was saved.";
      }
    }
    const current = await pending.loadInvoiceReview({workspaceId, customerId, phone});
    if (current?.action?.type === 'invoice_review_draft') {
      const eligibility = await getSendEligibility({supabase, workspaceId, phone, category: 'invoice_updates'});
      if (!eligibility.allowed || eligibility.customer?.id !== customerId) {
        return 'Please verify your number in cetld before continuing this invoice review.';
      }
      const action = current.action;
      if (CANCEL_REPLY.test(message)) {
        const canceled = await pending.transitionInvoiceReview({...current, workspaceId, customerId, phone,
          fromStage: action.stage, action: {...action, stage: 'canceled'}});
        return canceled ? 'Invoice review canceled. Nothing was saved.' : 'That review was already replaced or completed.';
      }
      const currency = CURRENCY_REPLY.exec(message)?.[1]?.toUpperCase();
      if (action.stage === 'incomplete' && action.missingFields?.length === 1 && action.missingFields[0] === 'currency') {
        if (!currency || !isSupportedCurrency(currency)) return 'Please reply with a supported 3-letter currency code, such as USD or INR.';
        const invoice = validateAssistantInvoice({...action.invoice, currency});
        const next = {...action, stage: 'proposal', invoice, missingFields: [], currencySource: 'user'};
        const stored = await pending.transitionInvoiceReview({...current, workspaceId, customerId, phone,
          fromStage: 'incomplete', action: next});
        if (stored) return proposalSummary(invoice);
        const latest = await pending.loadInvoiceReview({workspaceId, customerId, phone});
        if (latest?.action?.stage === 'proposal') return proposalSummary(latest.action.invoice);
        return 'That review was replaced by a newer photo. Please continue with the newer review.';
      }
      if (currency && action.stage === 'proposal') return proposalSummary(action.invoice);
      if (/^\s*(?:yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve|send it|create it)\s*[.!]?\s*$/i.test(message)
        && action.stage === 'incomplete') {
        return 'I can’t confirm an incomplete invoice review. Please send a complete explicit request or a clearer photo.';
      }
    }
    if (CURRENCY_REPLY.test(message)) {
      return 'There is no active currency-only invoice review. Please resend the invoice photo or send one complete explicit invoice request.';
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
    let response = await channel.ask(input);
    // Planner failures are safe, read-only fallbacks. Retry only this narrowly
    // identified class, once, to absorb transient free-tier provider failures.
    if (response?.model === null && response?.usedFallback === true) response = await channel.ask(input);
    const answer = typeof response?.answer === 'string' ? response.answer : '';
    if (response?.model !== null || response?.usedFallback !== true) return answer;
    return {answer, plannerFailure: response?.evidence?.plannerFailure || null};
  };
}
