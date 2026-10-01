import {AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  sanitizeModelSettings} from '../../ai/provider.mjs';
import {createWhatsAppAssistantChannel} from '../../ai/whatsapp-channel.mjs';
import {getSendEligibility} from './consent.mjs';
import {readConversationHistory, writeConversationTurn} from './conversation-memory.mjs';
import {extractInvoice, validateInvoiceExtractionResponse} from '../../ai/extraction.mjs';
import {validateAssistantInvoice} from '../../ai/invoice-ops.mjs';
import {createWhatsAppPendingActionStore} from './pending-actions.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';

const requiredInvoiceFields = ['invoiceNumber','customerName','invoiceDate','total','currency','direction'];
const fieldLabels = {invoiceNumber: 'invoice number', customerName: 'customer name', invoiceDate: 'invoice date',
  total: 'total', currency: 'explicit currency code (for example INR or USD)',
  direction: 'confirmation that your business issued the invoice'};
const DRAFT_TTL_MS = 15 * 60 * 1000;
const DRAFT_FIELDS = ['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total',
  'outstandingAmount','currency','clientPhone','clientEmail','notes','direction','lineItems'];

function missingInvoiceFields(extracted) {
  return requiredInvoiceFields.filter(name => extracted?.[name]?.value == null
    || extracted[name].confidence < 0.75 || (name === 'direction' && extracted[name].value !== 'receivable'));
}

function clarification(extracted) {
  const missing = missingInvoiceFields(extracted);
  const details = missing.map(name => fieldLabels[name]);
  return `I could only prepare a partial review. Please reply with ${details.join(', ')}. I won't save anything until I can show you a complete proposal and you explicitly confirm it.`;
}

function draftAction(extracted, missing, {messageId, mediaRef, now}) {
  const origin = {};
  if (typeof messageId === 'string' && messageId.length <= 255) origin.messageId = messageId;
  if (typeof mediaRef === 'string' && mediaRef.length <= 255) origin.mediaRef = mediaRef;
  const fields = Object.fromEntries(DRAFT_FIELDS.map(name => [name, structuredClone(extracted[name])]));
  return {type: 'invoice_review_draft', version: 1, fields, missing,
    confirmedFields: [], createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(), origin};
}

function checkedDraft(action) {
  if (!action || action.type !== 'invoice_review_draft' || action.version !== 1
    || !action.fields || typeof action.fields !== 'object' || Array.isArray(action.fields)
    || !Array.isArray(action.missing) || !Array.isArray(action.confirmedFields)
    || action.missing.some(name => !requiredInvoiceFields.includes(name))
    || action.confirmedFields.some(name => !requiredInvoiceFields.includes(name))
    || typeof action.expiresAt !== 'string') return null;
  if (Object.keys(action.fields).length !== DRAFT_FIELDS.length
    || DRAFT_FIELDS.some(name => !Object.hasOwn(action.fields, name))) return null;
  try {
    const checked = validateInvoiceExtractionResponse(action.fields);
    const fields = Object.fromEntries(DRAFT_FIELDS.map(name => [name, checked[name]]));
    return {...action, fields, missing: missingInvoiceFields(fields)};
  } catch { return null; }
}

function parseDraftReply(message, missing) {
  const text = String(message || '').trim();
  if (missing.length !== 1) return null;
  const name = missing[0];
  if (name === 'currency') {
    const match = text.match(/^(?:currency(?:\s+is)?[:\s]+)?([a-z]{3})[.!]?$/i);
    return match ? {name, value: match[1].toUpperCase()} : null;
  }
  if (name === 'invoiceDate') {
    const match = text.match(/^(?:invoice\s+date(?:\s+is)?[:\s]+)?(\d{4}-\d{2}-\d{2})[.!]?$/i);
    return match ? {name, value: match[1]} : null;
  }
  if (name === 'total') {
    const match = text.match(/^(?:total(?:\s+is)?[:\s]+)?(\d+(?:\.\d{1,2})?)[.!]?$/i);
    return match ? {name, value: Number(match[1])} : null;
  }
  if (name === 'invoiceNumber') {
    const match = text.match(/^invoice\s+(?:number|no\.?)(?:\s+is)?[:\s]+([A-Za-z0-9][A-Za-z0-9._\/-]{0,99})[.!]?$/i);
    return match ? {name, value: match[1]} : null;
  }
  if (name === 'customerName') {
    const match = text.match(/^customer(?:\s+name)?(?:\s+is)?[:\s]+(.{1,255})$/i);
    return match ? {name, value: match[1].trim()} : null;
  }
  if (name === 'direction' && /^(?:yes,?\s*)?(?:my|our) business (?:issued|sent) (?:this|the) invoice[.!]?$/i.test(text)) {
    return {name, value: 'receivable'};
  }
  return null;
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

function proposalSummary(invoice, confirmedFields = []) {
  const suppliedCurrency = confirmedFields.includes('currency') ? ' (provided by you)' : '';
  const items = invoice.lineItems.length
    ? `\n• Items: ${invoice.lineItems.map(item => `${item.description}${item.amount == null ? '' : ` (${invoice.currency} ${item.amount.toLocaleString('en-IN')})`}`).join('; ')}`
    : '';
  return `🧾 *Invoice ready to save*\n• ${invoice.invoiceNumber} — ${invoice.clientName}\n• Invoice date: ${invoice.invoiceDate}\n• Total: ${invoice.currency}${suppliedCurrency} ${invoice.total.toLocaleString('en-IN')}\n${invoice.subtotal == null ? '' : `• Subtotal: ${invoice.currency} ${invoice.subtotal.toLocaleString('en-IN')}\n`}${invoice.tax == null ? '' : `• Tax: ${invoice.currency} ${invoice.tax.toLocaleString('en-IN')}\n`}${invoice.dueDate ? `• Due: ${invoice.dueDate}\n` : ''}${items}\n\nNothing has been saved. Save it? Reply yes in a separate message to confirm.`;
}

/** Create an inbound assistant handler only after the webhook has verified Meta. */
export function createWhatsAppBoundMessageHandler({env = process.env, fetchImpl = fetch, supabase,
  providerFactory = options => new AIProvider(options), channelFactory = createWhatsAppAssistantChannel,
  extract = extractInvoice, pendingActionStoreFactory = createWhatsAppPendingActionStore,
  invoiceStoreFactory = createWhatsAppInvoiceStore, logger = console} = {}) {
  if (!supabase?.from) throw new TypeError('A server-side Supabase client is required');

  return async ({workspaceId, customerId, phone, message, messageId, media, mediaRef, mediaError, signal, deadlineAt}) => {
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
    if (mediaError) return "I couldn't fetch that photo. Please resend it and I'll try again.";
    if (media) {
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
        const invoice = invoiceProposal(extracted);
        if (!invoice) {
          const missing = missingInvoiceFields(extracted);
          await pending.storePendingAction({workspaceId, customerId, phone,
            action: draftAction(extracted, missing, {messageId, mediaRef: mediaRef || messageId, now: new Date()}), source: 'whatsapp'});
          logger?.info?.('WhatsApp invoice review draft stored', {messageId: messageId || null,
            actionState: 'invoice_review_draft', missingNames: missing});
          return clarification(extracted);
        }
        active();
        await pending.storePendingAction({workspaceId, customerId, phone,
          action: {type: 'create_invoice', payload: {invoice}}, source: 'whatsapp'});
        return proposalSummary(invoice);
      } catch (error) {
        logger?.error?.('WhatsApp invoice extraction failed', {workspaceId,
          message: String(error?.message || '').slice(0, 200)});
        return "I couldn't extract a review from that image. Please send the invoice number, customer name, invoice date, total, explicit currency code, and confirm whether your business issued it. Nothing was saved.";
      }
    }
    const draftRow = await pending.loadPendingAction({workspaceId, customerId, phone});
    if (draftRow?.action?.type === 'invoice_review_draft') {
      if (draftRow.workspace_id !== undefined && (draftRow.workspace_id !== workspaceId
        || draftRow.customer_id !== customerId || draftRow.phone !== phone)) {
        return 'I could not safely continue that invoice review. Please resend the photo.';
      }
      const eligibility = await getSendEligibility({supabase, workspaceId, phone, category: 'invoice_updates'});
      if (!eligibility.allowed || eligibility.customer?.id !== customerId) {
        return 'Please verify your number in cetld before continuing this invoice review.';
      }
      const draft = checkedDraft(draftRow.action);
      const expired = !draft || !Number.isFinite(Date.parse(draft.expiresAt)) || Date.now() >= Date.parse(draft.expiresAt)
        || Date.now() - new Date(draftRow.created_at).getTime() > DRAFT_TTL_MS;
      if (expired) {
        await pending.consumePendingAction({id: draftRow.id, workspaceId, customerId, phone});
        logger?.info?.('WhatsApp invoice review draft closed', {messageId: messageId || null,
          actionState: draft ? 'expired' : 'invalid', missingNames: draft?.missing || []});
        return draft ? 'That partial invoice review expired. Please resend the photo to start a new review.'
          : 'I could not safely continue that invoice review. Please resend the photo.';
      }
      if (/^(?:cancel|never mind|nevermind|discard|stop review)[.!\s]*$/i.test(String(message || '').trim())) {
        await pending.consumePendingAction({id: draftRow.id, workspaceId, customerId, phone});
        return 'Invoice review cancelled. Nothing was saved.';
      }
      if (/^(?:yes|y|ok|okay|confirm|confirmed|approve|save|save it)[.!\s]*$/i.test(String(message || '').trim())) {
        return `${clarification(draft.fields)} A confirmation cannot save an incomplete review.`;
      }
      if (/\b(?:i am|i'm|im) (?:the )?(?:business )?owner\b/i.test(String(message || ''))) {
        return `${clarification(draft.fields)} Owner setup is not available in this customer-bound chat, and saying you are the owner does not grant owner access.`;
      }
      const supplied = parseDraftReply(message, draft.missing);
      if (supplied) {
        const fields = structuredClone(draft.fields);
        // This confidence means the customer explicitly supplied the value; it is
        // tracked separately and is never represented as evidence printed in the photo.
        fields[supplied.name] = {value: supplied.value, confidence: 0.75};
        let validated;
        try {
          const checked = validateInvoiceExtractionResponse(fields);
          validated = Object.fromEntries(DRAFT_FIELDS.map(name => [name, checked[name]]));
        }
        catch { return `That ${fieldLabels[supplied.name]} is not valid for this invoice. ${clarification(draft.fields)}`; }
        const missing = missingInvoiceFields(validated);
        const invoice = invoiceProposal(validated);
        if (!invoice || missing.length) {
          await pending.storePendingAction({workspaceId, customerId, phone,
            action: {...draft, fields: validated, missing,
              confirmedFields: [...new Set([...draft.confirmedFields, supplied.name])]}, source: 'whatsapp'});
          return clarification(validated);
        }
        try { validateAssistantInvoice(invoice); }
        catch { return `That ${fieldLabels[supplied.name]} does not produce a valid invoice proposal. Please check it and reply again.`; }
        await pending.storePendingAction({workspaceId, customerId, phone,
          action: {type: 'create_invoice', payload: {invoice}}, source: 'whatsapp'});
        logger?.info?.('WhatsApp invoice review draft completed', {messageId: messageId || null,
          actionState: 'create_invoice', missingNames: []});
        return proposalSummary(invoice, [...new Set([...draft.confirmedFields, supplied.name])]);
      }
      return `${clarification(draft.fields)} I kept the partial review open; you can also reply “cancel”.`;
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
