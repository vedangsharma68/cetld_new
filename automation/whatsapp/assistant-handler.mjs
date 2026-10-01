import {AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  sanitizeModelSettings} from '../../ai/provider.mjs';
import {createWhatsAppAssistantChannel} from '../../ai/whatsapp-channel.mjs';
import {getSendEligibility} from './consent.mjs';
import {readConversationHistory, writeConversationTurn} from './conversation-memory.mjs';
import {extractInvoice} from '../../ai/extraction.mjs';
import {createWhatsAppPendingActionStore} from './pending-actions.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';

const unreadable = "I couldn't confidently read the invoice number, customer, date, total, explicit currency code, and whether you issued it. Please resend a clearer photo so I can prepare a review; nothing was saved.";

function invoiceProposal(extracted) {
  const required = ['invoiceNumber','customerName','invoiceDate','total','currency','direction'];
  if (required.some(name => extracted?.[name]?.value == null || extracted[name].confidence < 0.75)
    || extracted.direction.value !== 'receivable') return null;
  return {invoiceNumber: extracted.invoiceNumber.value, clientName: extracted.customerName.value,
    clientEmail: extracted.clientEmail.value, clientPhone: extracted.clientPhone.value,
    invoiceDate: extracted.invoiceDate.value, dueDate: extracted.dueDate.value,
    subtotal: extracted.subtotal.value, tax: extracted.tax.value, total: extracted.total.value,
    outstanding: extracted.outstandingAmount.value ?? extracted.total.value, currency: extracted.currency.value,
    notes: extracted.notes.value, alreadyPaid: false, direction: 'receivable', lineItems: extracted.lineItems.value};
}

function proposalSummary(invoice) {
  return `🧾 *Invoice ready to save*\n• ${invoice.invoiceNumber} — ${invoice.clientName}\n• ${invoice.currency} ${invoice.total.toLocaleString('en-IN')}\n${invoice.dueDate ? `• Due: ${invoice.dueDate}\n` : ''}\nSave it? Reply yes to confirm.`;
}

/** Create an inbound assistant handler only after the webhook has verified Meta. */
export function createWhatsAppBoundMessageHandler({env = process.env, fetchImpl = fetch, supabase,
  providerFactory = options => new AIProvider(options), channelFactory = createWhatsAppAssistantChannel,
  extract = extractInvoice, pendingActionStoreFactory = createWhatsAppPendingActionStore,
  invoiceStoreFactory = createWhatsAppInvoiceStore, logger = console} = {}) {
  if (!supabase?.from) throw new TypeError('A server-side Supabase client is required');

  return async ({workspaceId, customerId, phone, message, media, mediaError}) => {
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
        const extracted = await extract({provider: extractionProvider, ...media,
          businessName: workspace?.business_name || ''});
        const invoice = invoiceProposal(extracted);
        if (!invoice) return unreadable;
        await pending.storePendingAction({workspaceId, customerId, phone,
          action: {type: 'create_invoice', payload: {invoice}}, source: 'whatsapp'});
        return proposalSummary(invoice);
      } catch (error) {
        logger?.error?.('WhatsApp invoice extraction failed', {workspaceId,
          message: String(error?.message || '').slice(0, 200)});
        return unreadable;
      }
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
