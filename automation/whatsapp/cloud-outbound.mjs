import {getSendEligibility} from './consent.mjs';

const APPROVED_QA_RECIPIENTS = new Set(['+919871367051', '+919818685252']);
const E164 = /^\+[1-9]\d{6,14}$/;
const TEMPLATE_NAME = 'cetld_invoice_update_test';
const SERVICE_KINDS = new Set(['normal', 'verification', 'stop_confirmation']);
const CURRENT_INVOICE_STATUSES = new Set(['sent', 'paid']);
const SAFE_GUARD_REPLY = "I have your answer, but couldn't phrase it safely for WhatsApp - please check the cetld app for details.";
const NEUTRAL_CONTENT = /\b(?:overdue|past[ -]?due|debt|debtor|collect(?:ion)?|pay(?:ment)?\s+(?:now|today|immediately)|amount\s+due|outstanding|final\s+notice|late\s+fee)\b/i;
const SESSION_PRESSURE_CONTENT = /\b(?:final\s+notice|pay\s+(?:now|immediately|today)|late\s+fee|legal\s+action)\b/i;

function allowlistFromEnv(env) {
  const raw = env.WHATSAPP_TEST_ALLOWLIST;
  if (typeof raw !== 'string') return null;
  const values = String(raw).split(',').map(value => value.trim()).filter(Boolean);
  if (!values.length || values.some(value => !E164.test(value))) return null;
  return new Set(values);
}

function nonempty(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${field} is required`);
  return value.trim();
}

function recipient(value) {
  if (typeof value !== 'string' || !E164.test(value)) throw new TypeError('to must be an E.164 number');
  return value;
}

function maskedPhone(value) {
  return typeof value === 'string' && value.length >= 4 ? `***${value.slice(-4)}` : '***';
}

function block(logger, reason, {workspaceId = null, to = null, kind = null} = {}) {
  logger?.warn?.({event: 'whatsapp_outbound_blocked', reason, workspaceId, recipient: maskedPhone(to), kind});
  return {status: 'blocked', reason};
}

function withinServiceWindow(lastInboundAt, clock) {
  const received = typeof lastInboundAt === 'string' && /^\d{10}$/.test(lastInboundAt)
    ? Number(lastInboundAt) * 1000
    : new Date(lastInboundAt).getTime();
  const now = new Date(clock()).getTime();
  return Number.isFinite(received) && Number.isFinite(now) && now >= received && now - received < 24 * 60 * 60 * 1000;
}

export function neutralText(value, kind = 'business_initiated') {
  const body = nonempty(value, 'body', 1000);
  // Factual invoice vocabulary is permitted only for user-initiated replies in
  // the service window. Business-initiated surfaces retain the original guard.
  const blockedContent = kind === 'normal' ? SESSION_PRESSURE_CONTENT : NEUTRAL_CONTENT;
  if (blockedContent.test(body)) {
    throw new TypeError('collection content is disabled');
  }
  return body;
}

async function verifiedBusinessName(supabase, workspaceId, suppliedName) {
  if (!supabase?.from) return null;
  const result = await supabase.from('workspace_settings').select('business_name')
    .eq('workspace_id', workspaceId).maybeSingle();
  if (result?.error) throw result.error;
  const actual = result?.data?.business_name?.trim();
  if (actual) return actual === suppliedName ? actual : null;
  const fallback = await supabase.from('workspaces').select('name')
    .eq('id', workspaceId).maybeSingle();
  if (fallback?.error) throw fallback.error;
  const workspaceName = fallback?.data?.name?.trim();
  return workspaceName && workspaceName === suppliedName ? workspaceName : null;
}

async function unboundSuppression(supabase, phone) {
  if (!supabase?.from) return 'missing_store';
  const global = await supabase.from('whatsapp_global_suppressions')
    .select('suppressed_at').eq('phone', phone).maybeSingle();
  if (global?.error) throw global.error;
  if (global?.data) return 'globally_suppressed';
  const scoped = await supabase.from('whatsapp_suppressions')
    .select('workspace_id').eq('phone', phone).limit(1);
  if (scoped?.error) throw scoped.error;
  return scoped?.data?.length ? 'suppressed' : null;
}

/**
 * Test-only Cloud API transport. The feature flag and E.164 test allowlist are
 * mandatory even when a caller supplies an injected fetch implementation.
 * No reminders or arbitrary template/body sends are exposed here.
 */
export function createWhatsAppOutbound({
  env = process.env,
  fetchImpl = fetch,
  supabase,
  invoiceStore,
  logger = console,
  clock = () => new Date(),
  authorizeInboundReply,
  claimInvoiceUpdate,
} = {}) {
  const allowlist = allowlistFromEnv(env);

  function preflight({workspaceId, to, kind}) {
    // All gates run before any credential use or network operation.
    if (env.WHATSAPP_OUTBOUND_ENABLED !== 'true') return block(logger, 'disabled', {workspaceId, to, kind});
    if (!allowlist) return block(logger, 'invalid_test_allowlist', {workspaceId, to, kind});
    // The configured allowlist may narrow the test, never widen it beyond the
    // fixed contacts authorized for QA.
    if (!E164.test(to) || !APPROVED_QA_RECIPIENTS.has(to) || !allowlist.has(to)) return block(logger, 'test_allowlist', {workspaceId, to, kind});
    if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return block(logger, 'missing_credentials', {workspaceId, to, kind});
    if (!/^\d{5,30}$/.test(String(env.WHATSAPP_PHONE_NUMBER_ID))) return block(logger, 'invalid_phone_number_id', {workspaceId, to, kind});
    if (!/^v\d+\.\d+$/.test(String(env.WHATSAPP_GRAPH_API_VERSION || ''))) return block(logger, 'missing_graph_api_version', {workspaceId, to, kind});
    return null;
  }

  async function postMessage({workspaceId, to, kind, payload}) {
    const version = env.WHATSAPP_GRAPH_API_VERSION;
    let response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({messaging_product: 'whatsapp', recipient_type: 'individual', to: to.slice(1), ...payload}),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      logger?.error?.({event: 'whatsapp_outbound_unknown', workspaceId, recipient: maskedPhone(to), kind, message: error?.message});
      return {status: 'unknown', reason: 'network_error'};
    }
    if (!response.ok) {
      logger?.error?.({event: 'whatsapp_outbound_failed', workspaceId, recipient: maskedPhone(to), kind, httpStatus: response.status});
      return {status: 'failed', reason: 'graph_rejected', httpStatus: response.status};
    }
    let data;
    try { data = await response.json(); } catch { return {status: 'unknown', reason: 'invalid_graph_response'}; }
    const providerMessageId = data?.messages?.[0]?.id;
    return typeof providerMessageId === 'string' && providerMessageId
      ? {status: 'accepted', providerMessageId}
      : {status: 'unknown', reason: 'missing_graph_message_id'};
  }

  /** Best-effort read receipt that also displays WhatsApp's typing indicator. */
  async function sendTypingIndicator({messageId} = {}) {
    try {
      const inboundId = nonempty(messageId, 'messageId');
      if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) throw new Error('WhatsApp credentials missing');
      if (!/^\d{5,30}$/.test(String(env.WHATSAPP_PHONE_NUMBER_ID))) throw new Error('Invalid WhatsApp phone number ID');
      if (!/^v\d+\.\d+$/.test(String(env.WHATSAPP_GRAPH_API_VERSION || ''))) throw new Error('WhatsApp Graph API version missing');
      const response = await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({messaging_product: 'whatsapp', status: 'read', message_id: inboundId,
          typing_indicator: {type: 'text'}}),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Object.assign(new Error('WhatsApp Graph API rejected typing indicator'), {httpStatus: response.status});
      return {status: 'accepted'};
    } catch (error) {
      logger?.error?.({event: 'whatsapp_typing_indicator_failed', messageId: typeof messageId === 'string' ? messageId : null,
        httpStatus: error?.httpStatus, message: error?.message});
      return {status: 'failed'};
    }
  }

  async function sendInvoiceUpdateTemplate({workspaceId, to, invoiceId, customerId, businessName, expectedUpdatedAt, idempotencyKey} = {}) {
    const blocked = preflight({workspaceId, to, kind: 'invoice_update'});
    if (blocked) return blocked;
    nonempty(workspaceId, 'workspaceId');
    recipient(to);
    nonempty(invoiceId, 'invoiceId');
    nonempty(customerId, 'customerId');
    const revision = nonempty(expectedUpdatedAt, 'expectedUpdatedAt');
    const eventKey = nonempty(idempotencyKey, 'idempotencyKey');
    const name = nonempty(businessName, 'businessName', 100);
    if (!supabase || !invoiceStore?.getCurrentInvoice) return block(logger, 'missing_store', {workspaceId, to, kind: 'invoice_update'});
    if (typeof claimInvoiceUpdate !== 'function') return block(logger, 'missing_invoice_claim', {workspaceId, to, kind: 'invoice_update'});
    const eligibility = await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
    if (!eligibility.allowed || eligibility.customer?.id !== customerId) {
      return block(logger, eligibility.reason || 'customer_mismatch', {workspaceId, to, kind: 'invoice_update'});
    }
    if (!await verifiedBusinessName(supabase, workspaceId, name)) return block(logger, 'business_name_mismatch', {workspaceId, to, kind: 'invoice_update'});
    const invoice = await invoiceStore.getCurrentInvoice({workspaceId, invoiceId});
    if (!invoice || invoice.workspaceId !== workspaceId || invoice.customerId !== customerId
      || !CURRENT_INVOICE_STATUSES.has(invoice.status)
      || invoice.updatedAt !== revision) {
      return block(logger, 'invoice_state_changed', {workspaceId, to, kind: 'invoice_update'});
    }
    const number = nonempty(invoice.invoiceNumber, 'invoiceNumber', 100);
    if (/\b(?:overdue|debt|debtor|past[ -]?due|due|reminder|collect(?:ion)?)\b/i.test(number)) return block(logger, 'collection_content', {workspaceId, to, kind: 'invoice_update'});
    // STOP can arrive while the invoice state is being read. Recheck as close
    // as possible to transport, and fail closed if the recipient changed.
    const finalEligibility = await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
    if (!finalEligibility.allowed || finalEligibility.customer?.id !== customerId) {
      return block(logger, finalEligibility.reason || 'customer_mismatch', {workspaceId, to, kind: 'invoice_update'});
    }
    // A durable atomic claim must be keyed by workspace, invoice and the
    // originating event. Claim-before-send favors at-most-once delivery when
    // Graph returns an uncertain outcome; callers must not retry blindly.
    const claim = await claimInvoiceUpdate({workspaceId, invoiceId, customerId, phone: to, idempotencyKey: eventKey, expectedUpdatedAt: revision});
    if (claim?.claimed !== true) return block(logger, claim?.reason || 'duplicate_invoice_update', {workspaceId, to, kind: 'invoice_update'});
    const postClaimEligibility = await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
    if (!postClaimEligibility.allowed || postClaimEligibility.customer?.id !== customerId) {
      return block(logger, postClaimEligibility.reason || 'customer_mismatch', {workspaceId, to, kind: 'invoice_update'});
    }
    // This is an explicitly neutral, fixed test template. The approved Meta
    // template must say "Hi, this is {{1}}" and provide an invoice update with
    // {{2}}. No caller-controlled reminder content is accepted.
    return postMessage({workspaceId, to, kind: 'invoice_update', payload: {
      type: 'template', template: {name: TEMPLATE_NAME, language: {code: 'en_US'}, components: [
        {type: 'body', parameters: [{type: 'text', text: name}, {type: 'text', text: number}]},
      ]},
    }});
  }

  async function sendServiceReply({workspaceId = null, to, body, lastInboundAt, kind = 'normal', messageId, businessName} = {}) {
    const blocked = preflight({workspaceId, to, kind});
    if (blocked) return blocked;
    recipient(to);
    if (!SERVICE_KINDS.has(kind)) throw new TypeError('invalid service reply kind');
    if (!withinServiceWindow(lastInboundAt, clock)) return block(logger, 'service_window_closed', {workspaceId, to, kind});
    if (typeof authorizeInboundReply !== 'function') return block(logger, 'missing_inbound_authorizer', {workspaceId, to, kind});
    const inboundId = nonempty(messageId, 'messageId');
    if (kind === 'normal') nonempty(workspaceId, 'workspaceId');
    if (kind === 'verification' && workspaceId !== null) return block(logger, 'verification_must_be_unbound', {workspaceId, to, kind});
    const owner = nonempty(businessName, 'businessName', 100);
    if (kind === 'verification' || (kind === 'stop_confirmation' && workspaceId === null)) {
      if (owner !== 'CETLD') return block(logger, 'invalid_platform_identity', {workspaceId, to, kind});
    } else if (!await verifiedBusinessName(supabase, workspaceId, owner)) {
      return block(logger, 'business_name_mismatch', {workspaceId, to, kind});
    }
    let text = kind === 'verification'
      ? 'Please contact the business that issued your invoice to verify your WhatsApp number. Reply STOP to opt out.'
      : kind === 'stop_confirmation'
        ? "You've been opted out of WhatsApp updates. We won't message you again."
        : null;
    if (kind === 'normal') {
      try {
        text = neutralText(body, kind);
      } catch (error) {
        if (!(error instanceof TypeError) || error.message !== 'collection content is disabled') throw error;
        logger?.warn?.({event: 'whatsapp_outbound_guard_fallback', workspaceId, recipient: maskedPhone(to), kind});
        text = SAFE_GUARD_REPLY;
      }
    }
    if (kind === 'normal') {
      if (!supabase) return block(logger, 'missing_store', {workspaceId, to, kind});
      const eligibility = await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
      if (!eligibility.allowed) return block(logger, eligibility.reason, {workspaceId, to, kind});
    }
    const authorization = await authorizeInboundReply({workspaceId, phone: to, kind, messageId: inboundId});
    if (authorization?.allowed !== true) return block(logger, authorization?.reason || 'inbound_reply_denied', {workspaceId, to, kind});
    if (kind === 'verification') {
      const suppression = await unboundSuppression(supabase, to);
      if (suppression) return block(logger, suppression, {workspaceId, to, kind});
    }
    if (kind === 'normal') {
      const finalEligibility = await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
      if (!finalEligibility.allowed) return block(logger, finalEligibility.reason, {workspaceId, to, kind});
    }
    return postMessage({workspaceId, to, kind, payload: {type: 'text', text: {preview_url: false, body: text}}});
  }

  async function sendServiceMedia({workspaceId, to, media, caption, lastInboundAt, messageId, businessName} = {}) {
    const kind = 'normal';
    const blocked = preflight({workspaceId, to, kind});
    if (blocked) return blocked;
    recipient(to); nonempty(workspaceId, 'workspaceId'); nonempty(messageId, 'messageId');
    if (!withinServiceWindow(lastInboundAt, clock)) return block(logger, 'service_window_closed', {workspaceId, to, kind});
    if (!await verifiedBusinessName(supabase, workspaceId, nonempty(businessName, 'businessName', 100))) return block(logger, 'business_name_mismatch', {workspaceId, to, kind});
    const eligibility = await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
    if (!eligibility.allowed) return block(logger, eligibility.reason, {workspaceId, to, kind});
    const authorization = await authorizeInboundReply({workspaceId, phone: to, kind, messageId});
    if (authorization?.allowed !== true) return block(logger, authorization?.reason || 'inbound_reply_denied', {workspaceId, to, kind});
    const bytes = media?.bytes;
    if (!bytes?.length || bytes.length > 10 * 1024 * 1024) throw new TypeError('invalid invoice media');
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', media.mime_type || media.mimeType || 'application/octet-stream');
    form.set('file', new Blob([bytes], {type: media.mime_type || media.mimeType}), media.file_name || media.fileName || 'invoice');
    const upload = await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: 'POST', headers: {Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`}, body: form, signal: AbortSignal.timeout(15000)});
    if (!upload.ok) return {status: 'failed', reason: 'media_upload_rejected', httpStatus: upload.status};
    const uploaded = await upload.json();
    if (!uploaded?.id) return {status: 'unknown', reason: 'missing_media_id'};
    const image = String(media.mime_type || media.mimeType).startsWith('image/');
    return postMessage({workspaceId, to, kind, payload: image
      ? {type: 'image', image: {id: uploaded.id, caption: String(caption || '').slice(0, 1000)}}
      : {type: 'document', document: {id: uploaded.id, filename: media.file_name || media.fileName || 'invoice.pdf', caption: String(caption || '').slice(0, 1000)}}});
  }

  // Intentionally no sendReminder method. Collection content remains on hold.
  return Object.freeze({sendInvoiceUpdateTemplate, sendServiceReply, sendServiceMedia, sendTypingIndicator});
}
