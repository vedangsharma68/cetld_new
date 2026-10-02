import { resolveActiveBindings, revokeConsentForPhone, suppressUnknownPhone } from './consent.mjs';
import {createWhatsAppInvoiceUpdateStore} from './invoice-update-store.mjs';
import {writeConversationTurn} from './conversation-memory.mjs';

const MAX_MESSAGES = 100;
const DEFAULT_PROCESS_BUDGET_MS = 40_000;
// Leave enough runway for a database lookup and a deterministic reply. Slow
// planner work may use the first slot, but is never started near the deadline.
const MIN_EVENT_BUDGET_MS = 5_000;
const SAFE_FALLBACK_REPLY = "I couldn't safely check that just now. Please try again.";
const MEDIA_FETCH_FAILED_REPLY = "I couldn't fetch that photo. Please resend it and I'll try again.";
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
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
      const media = type === 'image' || type === 'document' ? message?.[type] : null;
      const body = type === 'text' ? message?.text?.body : type === 'button' ? message?.button?.text : type === 'interactive' ? (message?.interactive?.button_reply?.title || message?.interactive?.list_reply?.title) : media?.caption || '';
      if (!id || id.length > 256 || !E164.test(phone) || !type || type.length > 64 || typeof body !== 'string' || body.length > 4000) continue;
      const seconds = Number(message?.timestamp);
      const timestamp = Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
      found.push({ provider_message_id: id, phone_number_id: String(expectedPhoneNumberId), sender_phone: phone, message_type: type, message_text: body, provider_timestamp: timestamp,
        ...(media ? {media_id: String(media.id || ''), media_mime_type: String(media.mime_type || ''), media_caption: String(media.caption || '')} : {}) });
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

  async hasMedia(providerMessageId) {
    const row = dataOrThrow(await this.supabase.from('whatsapp_inbound_media').select('provider_message_id')
      .eq('provider_message_id', providerMessageId).maybeSingle(), 'check media');
    return Boolean(row);
  }

  async storeMedia(message, bytes, mimeType) {
    dataOrThrow(await this.supabase.from('whatsapp_inbound_media').upsert({provider_message_id: message.provider_message_id,
      media_id: message.media_id, mime_type: mimeType, bytes: `\\x${Buffer.from(bytes).toString('hex')}`,
      size_bytes: bytes.byteLength}, {onConflict: 'provider_message_id', ignoreDuplicates: true}), 'store media');
  }

  async getMedia(event) {
    const row = dataOrThrow(await this.supabase.from('whatsapp_inbound_media').select('mime_type,bytes,size_bytes')
      .eq('provider_message_id', event.media_ref).maybeSingle(), 'read media');
    if (!row) return null;
    const bytes = typeof row.bytes === 'string' && row.bytes.startsWith('\\x')
      ? Buffer.from(row.bytes.slice(2), 'hex') : Buffer.from(row.bytes || []);
    return {bytes, mimeType: row.mime_type, fileName: event.message_type === 'document' ? 'invoice.pdf' : 'invoice-image'};
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

  async defer(event) {
    dataOrThrow(await this.supabase.from('whatsapp_inbound_events').update({status: 'pending', processed_at: null,
      claim_token: null, claimed_at: null, next_attempt_at: new Date().toISOString(),
      attempts: Math.max(0, Number(event.attempts || 1) - 1)})
      .eq('id', event.id).eq('claim_token', event.claim_token), 'defer');
  }
}

const stopReply = 'Your request has been recorded. You will no longer receive WhatsApp invoice updates from this business.';

/** Route only through service-role consent/customer binding; never use a claimed name. */
export function createInboundRuntime({ env = process.env, fetchImpl = globalThis.fetch, supabase, inbox = new SupabaseInboundInbox(supabase), outbound,
  onBoundMessage, logger = console, clock = () => Date.now() } = {}) {
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
  async function downloadMedia(message) {
    if (!message.media_id) throw new Error('Media ID missing');
    const version = String(env.WHATSAPP_GRAPH_API_VERSION || '');
    const token = String(env.WHATSAPP_ACCESS_TOKEN || '');
    if (!/^v\d+\.\d+$/.test(version) || !token) throw new Error('WhatsApp media credentials unavailable');
    const headers = {Authorization: `Bearer ${token}`};
    const metadata = await fetchImpl(`https://graph.facebook.com/${version}/${encodeURIComponent(message.media_id)}`,
      {headers, redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!metadata.ok) throw new Error('Media lookup failed');
    const details = await metadata.json();
    if (typeof details?.url !== 'string' || !details.url.startsWith('https://')) throw new Error('Invalid media URL');
    const response = await fetchImpl(details.url, {headers, redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('Media download failed');
    const declared = String(details.mime_type || message.media_mime_type || '').split(';')[0].toLowerCase();
    const allowed = message.message_type === 'document' ? ['application/pdf'] : ['image/png','image/jpeg','image/webp'];
    if (!allowed.includes(declared)) throw new Error('Unsupported media type');
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_MEDIA_BYTES) throw new Error('Media exceeds 10 MiB');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error('Media exceeds 10 MiB');
    return {bytes, mimeType: declared};
  }
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
  async function processEvent(event, {signal, deadlineAt} = {}) {
    const active = () => {
      if (signal?.aborted || (Number.isFinite(deadlineAt) && clock() >= deadlineAt)) throw Object.assign(new Error('Inbound processing deadline expired'), {name: 'AbortError'});
    };
    active();
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
      // An unbound or ambiguous phone has no authorized workspace/recipient
      // scope. Keep verification inside the established binding flow rather
      // than emitting a direct workspace-null message.
      const linkMatch = bindings.length === 0 && /^\s*link[\s:-]*(\d{6})\s*$/i.exec(event.message_text || '');
      if (linkMatch) {
        // The sender phone comes from WhatsApp, so a matching dashboard code proves they hold the number.
        try {
          const { data: result, error } = await supabase.rpc('whatsapp_verify_owner_code', { p_phone: event.sender_phone, p_code: linkMatch[1] });
          if (error) throw error;
          const sender = await getOutbound();
          await sender.sendServiceReply({ workspaceId: null, to: event.sender_phone, body: '',
            ownerLinkResult: result?.ok === true ? 'linked' : 'failed',
            lastInboundAt: event.provider_timestamp || event.received_at, kind: 'verification',
            messageId: event.provider_message_id, businessName: 'CETLD' });
        } catch (error) {
          logger?.error?.('WhatsApp owner link failed', { message: String(error?.message || '').slice(0, 200) });
        }
      }
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
      const media = event.media_ref && !event.media_error ? await inbox.getMedia(event) : null;
      const response = event.media_error ? MEDIA_FETCH_FAILED_REPLY : await onBoundMessage({ workspaceId: binding.workspaceId, customerId: binding.customerId,
        phone: event.sender_phone, message: event.message_text, messageId: event.provider_message_id, media,
        mediaError: event.media_ref && !media ? 'Stored media unavailable' : null, signal, deadlineAt });
      active();
      const answer = typeof response === 'string' ? response : response?.answer;
      if (typeof answer === 'string' && answer.trim()) {
        const sender = await getOutbound();
        const send = response?.media && typeof sender.sendServiceMedia === 'function' ? sender.sendServiceMedia.bind(sender) : sender.sendServiceReply.bind(sender);
        const sent = await send({ workspaceId: binding.workspaceId, to: event.sender_phone, body: answer, caption: answer,
          ...(response?.media ? {media: response.media} : {}),
          lastInboundAt: event.provider_timestamp || event.received_at, kind: 'normal', messageId: event.provider_message_id,
          businessName: await businessName(binding.workspaceId) });
        if (sent?.status === 'accepted') {
          try {
            await writeConversationTurn({supabase, workspaceId: binding.workspaceId,
              customerId: binding.customerId, phone: event.sender_phone, role: 'assistant', content: answer});
          } catch (memoryError) {
            logger?.error?.('WhatsApp conversation memory write failed', {workspaceId: binding.workspaceId,
              role: 'assistant', message: String(memoryError?.message || '').slice(0, 200)});
          }
        }
      }
      if (response?.plannerFailure) return {outcome: 'bound', plannerFailure: response.plannerFailure};
    }
    return 'bound';
  }
  async function failFinalAttempt(event) {
    try {
      const sender = await getOutbound();
      await sender.sendServiceReply({ workspaceId: null, to: event.sender_phone, body: SAFE_FALLBACK_REPLY,
        lastInboundAt: event.provider_timestamp || event.received_at, kind: 'verification',
        messageId: event.provider_message_id, businessName: 'CETLD' });
    } catch (error) {
      logger.error('WhatsApp final-attempt fallback failed', { messageId: event.provider_message_id,
        message: String(error?.message || '').slice(0, 200) });
    }
    await inbox.complete(event, 'PROCESSING_FAILED', null, false);
  }
  return {
    async enqueue(messages) {
      for (const message of messages) {
        if (!['image','document'].includes(message.message_type)) continue;
        message.media_ref = message.provider_message_id;
        try {
          if (!await inbox.hasMedia(message.provider_message_id)) {
            const media = await downloadMedia(message);
            await inbox.storeMedia(message, media.bytes, media.mimeType);
          }
        } catch (error) {
          message.media_error = String(error?.message || 'Media download failed').slice(0, 500);
          logger?.error?.('WhatsApp media ingest failed', {messageId: message.provider_message_id,
            message: message.media_error});
        }
      }
      return inbox.enqueue(messages);
    },
    revokeOptOut,
    async processPending() {
      const configuredBudget = Number(env.WHATSAPP_PROCESS_BUDGET_MS);
      const budgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0
        ? configuredBudget : DEFAULT_PROCESS_BUDGET_MS;
      const startedAt = clock();
      const deadlineAt = startedAt + budgetMs;
      const controller = new AbortController();
      const deadlineTimer = setTimeout(() => controller.abort(), budgetMs);
      const seen = new Set();
      let claimed = 0;
      let completed = 0;
      try { while (claimed < 10 && deadlineAt - clock() >= MIN_EVENT_BUDGET_MS) {
        // Claim individually so a deadline never leaves an unstarted batch
        // leased for five minutes.
        const [event] = await inbox.claim(1);
        if (!event || seen.has(event.id)) break;
        seen.add(event.id);
        claimed++;
        if (deadlineAt - clock() < MIN_EVENT_BUDGET_MS) {
          if (typeof inbox.defer === 'function') await inbox.defer(event);
          break;
        }
        if (event.attempts >= 5) {
          await failFinalAttempt(event);
          completed++;
          continue;
        }
        try {
          const result = await processEvent(event, {signal: controller.signal, deadlineAt});
          if (result?.plannerFailure) {
            const detail = JSON.stringify(result.plannerFailure).slice(0, 1000);
            await inbox.complete(event, 'ASSISTANT_PLANNER_FAILED', detail, false);
          } else await inbox.complete(event);
          completed++;
        }
        catch (error) {
          if (controller.signal.aborted || clock() >= deadlineAt) {
            if (typeof inbox.defer === 'function') await inbox.defer(event);
            break;
          }
          logger.error('WhatsApp inbound event failed', { messageId: event.provider_message_id, name: error?.name || 'Error',
            message: String(error?.message || '').slice(0, 200) });
          await inbox.complete(event, 'PROCESSING_FAILED', String(error?.message || '').slice(0, 1000));
        }
        // Media is the long path. Leave later events unclaimed for the next
        // webhook continuation or five-minute cron invocation.
        if (event.media_ref) break;
      }} finally { clearTimeout(deadlineTimer); }
      return { claimed, completed };
    },
  };
}
