import { resolveActiveBindings, revokeConsentForPhone, suppressUnknownPhone } from './consent.mjs';
import {createWhatsAppInvoiceUpdateStore} from './invoice-update-store.mjs';

const MAX_MESSAGES = 100;
const E164 = /^\+[1-9]\d{6,14}$/;
const refusal = /^(?:stop|unsubscribe|opt[ -]?out|cancel(?: whatsapp)?|remove me|no more (?:messages|texts|whatsapp(?: updates)?)|(?:do not|don't) (?:message|text|contact) me|(?:do not|don't) send me (?:messages|texts|whatsapp updates)|please (?:stop(?: sending me (?:messages|texts|whatsapp updates))?|remove me|(?:do not|don't) (?:message|text|contact) me)|i (?:do not|don't|no longer) (?:consent|agree|want (?:these |whatsapp )?(?:messages|updates)))\b[.!\s]*$/i;

export function isOptOut(text) {
  return typeof text === 'string' && refusal.test(text.trim());
}

export function parseMetaMessages(payload, expectedPhoneNumberId, expectedWabaId) {
  if (!expectedPhoneNumberId) throw Object.assign(new Error('Phone number ID missing'), { status: 503 });
  if (!expectedWabaId) throw Object.assign(new Error('WABA ID missing'), { status: 503 });
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) throw Object.assign(new Error('Invalid Meta webhook'), { status: 400 });
  const found = [];
  for (const entry of payload.entry) for (const change of entry?.changes || []) {
    if (String(entry?.id || '') !== String(expectedWabaId)) continue;
    if (change?.field !== 'messages') continue;
    const value = change.value;
    if (String(value?.metadata?.phone_number_id || '') !== String(expectedPhoneNumberId)) continue;
    for (const message of value?.messages || []) {
      if (found.length >= MAX_MESSAGES) throw Object.assign(new Error('Too many messages'), { status: 413 });
      const id = String(message?.id || '');
      const sender = String(message?.from || '');
      const phone = sender.startsWith('+') ? sender : `+${sender}`;
      const type = String(message?.type || '');
      const body = type === 'text' ? message?.text?.body : type === 'button' ? message?.button?.text : type === 'interactive' ? (message?.interactive?.button_reply?.title || message?.interactive?.list_reply?.title) : '';
      if (!id || id.length > 256 || !E164.test(phone) || !type || type.length > 64 || typeof body !== 'string' || body.length > 4000) continue;
      const seconds = Number(message?.timestamp);
      const timestamp = Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
      found.push({ provider_message_id: id, phone_number_id: String(expectedPhoneNumberId), sender_phone: phone, message_type: type, message_text: body, provider_timestamp: timestamp });
    }
  }
  return found;
}

function dataOrThrow(result, operation) {
  if (result?.error) throw Object.assign(new Error(`WhatsApp ${operation} failed`), { code: 'WHATSAPP_INBOX_STORE_ERROR', cause: result.error });
  return result?.data;
}

/** Service-role-only durable inbox. No webhook body is stored. */
export class SupabaseInboundInbox {
  constructor(supabase) { if (!supabase) throw new Error('Supabase service client required'); this.supabase = supabase; }

  async enqueue(messages) {
    if (!messages.length) return [];
    const inserted = dataOrThrow(await this.supabase.from('whatsapp_inbound_events')
      .upsert(messages, { onConflict: 'provider_message_id', ignoreDuplicates: true })
      .select('*'), 'enqueue') || [];
    const stopIds = messages.filter(message => isOptOut(message.message_text))
      .map(message => message.provider_message_id);
    if (!stopIds.length) return inserted;
    // If storage succeeded but synchronous revocation failed, Meta's retry
    // must finish the STOP even though the message ID is already in the inbox.
    const pendingStops = dataOrThrow(await this.supabase.from('whatsapp_inbound_events')
      .select('*').in('provider_message_id', stopIds).is('stop_processed_at', null), 'recover stop') || [];
    const byId = new Map(inserted.map(event => [event.provider_message_id, event]));
    for (const event of pendingStops) byId.set(event.provider_message_id, event);
    return [...byId.values()];
  }

  async claim(limit = 10) {
    return dataOrThrow(await this.supabase.rpc('whatsapp_claim_inbound_events', { p_limit: limit }), 'claim') || [];
  }

  async markStop(event, { confirmationDue = false, workspaceId = null } = {}) {
    dataOrThrow(await this.supabase.rpc('whatsapp_record_inbound_stop', {
      p_provider_message_id: event.provider_message_id,
      p_confirmation_due: confirmationDue,
      p_workspace_id: workspaceId,
    }), 'mark stop');
  }

  async claimReply({ workspaceId, phone, kind, messageId }) {
    const data = dataOrThrow(await this.supabase.rpc('whatsapp_claim_inbound_reply', {
      p_provider_message_id: messageId, p_sender_phone: phone, p_kind: kind, p_workspace_id: workspaceId || null,
    }), 'claim reply');
    return { allowed: data === true };
  }

  async complete(event, errorCode = null, errorDetail = null, retryable = true) {
    const failed = Boolean(errorCode);
    const retry = failed && retryable && event.attempts < 5;
    const next = new Date(Date.now() + Math.min(60_000 * 2 ** Math.max(0, event.attempts - 1), 60 * 60_000)).toISOString();
    dataOrThrow(await this.supabase.from('whatsapp_inbound_events')
      .update({ status: retry ? 'pending' : failed && retryable ? 'failed' : 'done', processed_at: retry ? null : new Date().toISOString(),
        claim_token: null, claimed_at: null, next_attempt_at: retry ? next : event.next_attempt_at,
        error_code: errorCode, error_detail: errorDetail })
      .eq('id', event.id).eq('claim_token', event.claim_token), 'complete');
  }
}

const verifyReply = 'We could not verify this number for invoice updates. Please contact the business that issued your invoice to verify your WhatsApp number.';
const stopReply = 'Your request has been recorded. You will no longer receive WhatsApp invoice updates from this business.';

/** Route only through service-role consent/customer binding; never use a claimed name. */
export function createInboundRuntime({ env = process.env, fetchImpl = globalThis.fetch, supabase, inbox = new SupabaseInboundInbox(supabase), outbound,
  onBoundMessage, logger = console } = {}) {
  if (!supabase) throw new Error('Supabase service client required');
  let outboundPromise;
  const getOutbound = async () => {
    if (outbound) return outbound;
    outboundPromise ||= import('./cloud-outbound.mjs').then(({ createWhatsAppOutbound }) => {
      const invoiceUpdates = createWhatsAppInvoiceUpdateStore({supabase});
      return createWhatsAppOutbound({env, fetchImpl, supabase, logger, ...invoiceUpdates,
        authorizeInboundReply: input => inbox.claimReply(input)});
    });
    return outboundPromise;
  };
  async function businessName(workspaceId) {
    if (!workspaceId) return 'CETLD';
    const settings = dataOrThrow(await supabase.from('workspace_settings').select('business_name')
      .eq('workspace_id', workspaceId).maybeSingle(), 'business name');
    if (settings?.business_name?.trim()) return settings.business_name.trim();
    const workspace = dataOrThrow(await supabase.from('workspaces').select('name')
      .eq('id', workspaceId).maybeSingle(), 'workspace name');
    return workspace?.name?.trim() || 'CETLD';
  }
  async function revokeOptOut(event) {
    if (event.stop_processed_at) return;
    // Install the phone-wide barrier before discovering workspace scopes. A
    // consent added in another workspace during this loop must stay blocked.
    const global = await suppressUnknownPhone({ supabase, phone: event.sender_phone,
      messageId: event.provider_message_id });
    const consents = dataOrThrow(await supabase.from('whatsapp_consents').select('workspace_id')
      .eq('phone', event.sender_phone), 'find revocation scopes') || [];
    let confirmation = null;
    // Revoke all consent scopes for this phone, including stale customer links.
    // A claimed name in the message never selects a workspace.
    for (const workspaceId of new Set(consents.map(row => row.workspace_id))) {
      const result = await revokeConsentForPhone({ supabase, workspaceId,
        phone: event.sender_phone, via: /^stop\b/i.test(event.message_text.trim()) ? 'stop' : 'refusal', messageId: event.provider_message_id });
      if (result.confirmationDue && !confirmation) confirmation = workspaceId;
    }
    await inbox.markStop(event, { confirmationDue: Boolean(confirmation || global.confirmationDue), workspaceId: confirmation });
  }
  async function processEvent(event) {
    if (isOptOut(event.message_text)) {
      if (!event.stop_processed_at) {
        await revokeOptOut(event);
        // The just-claimed copy predates the stop update; use the fresh binding
        // result only after re-reading the durable row.
        const { data, error } = await supabase.from('whatsapp_inbound_events').select('*').eq('id', event.id).single();
        if (error) throw error;
        event = data;
      }
      if (event.stop_confirmation_due) {
        const sender = await getOutbound();
        await sender.sendServiceReply({ workspaceId: event.stop_workspace_id, to: event.sender_phone,
          body: stopReply, lastInboundAt: event.provider_timestamp || event.received_at, kind: 'stop_confirmation',
          messageId: event.provider_message_id, businessName: await businessName(event.stop_workspace_id) });
      }
      return 'opt_out';
    }
    const bindings = await resolveActiveBindings({ supabase, phone: event.sender_phone });
    if (bindings.length !== 1) {
      const sender = await getOutbound();
      await sender.sendServiceReply({ workspaceId: null, to: event.sender_phone, body: verifyReply,
        lastInboundAt: event.provider_timestamp || event.received_at, kind: 'verification', messageId: event.provider_message_id,
        businessName: 'CETLD' });
      return 'verify';
    }
    const binding = bindings[0];
    if (!binding.customerId || !binding.customer || !binding.workspaceId) throw new Error('Incomplete customer binding');
    if (onBoundMessage) {
      // This UX signal must never affect durable event processing. In
      // particular, Graph failures must not cause the inbound event to retry.
      try {
        const sender = await getOutbound();
        await sender.sendTypingIndicator({messageId: event.provider_message_id});
      } catch (error) {
        logger?.error?.('WhatsApp typing indicator failed', {messageId: event.provider_message_id,
          message: String(error?.message || '').slice(0, 200)});
      }
      const response = await onBoundMessage({ workspaceId: binding.workspaceId, customerId: binding.customerId,
        phone: event.sender_phone, message: event.message_text, messageId: event.provider_message_id });
      const answer = typeof response === 'string' ? response : response?.answer;
      if (typeof answer === 'string' && answer.trim()) {
        const sender = await getOutbound();
        await sender.sendServiceReply({ workspaceId: binding.workspaceId, to: event.sender_phone, body: answer,
          lastInboundAt: event.provider_timestamp || event.received_at, kind: 'normal', messageId: event.provider_message_id,
          businessName: await businessName(binding.workspaceId) });
      }
      if (response?.plannerFailure) return {outcome: 'bound', plannerFailure: response.plannerFailure};
    }
    return 'bound';
  }
  return {
    enqueue: messages => inbox.enqueue(messages),
    revokeOptOut,
    async processPending() {
      const claimed = await inbox.claim(10);
      let completed = 0;
      for (const event of claimed) {
        try {
          const result = await processEvent(event);
          if (result?.plannerFailure) {
            const detail = JSON.stringify(result.plannerFailure).slice(0, 1000);
            await inbox.complete(event, 'ASSISTANT_PLANNER_FAILED', detail, false);
          } else await inbox.complete(event);
          completed++;
        }
        catch (error) {
          logger.error('WhatsApp inbound event failed', { messageId: event.provider_message_id, name: error?.name || 'Error',
            message: String(error?.message || '').slice(0, 200) });
          await inbox.complete(event, 'PROCESSING_FAILED');
        }
      }
      return { claimed: claimed.length, completed };
    },
  };
}
