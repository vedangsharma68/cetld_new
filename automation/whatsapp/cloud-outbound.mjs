import {authorizeOwnerPhone} from './owner-binding.mjs';
import {createConversationStore,conversationCallbackToken} from './conversation-store.mjs';
import {getSendEligibility} from './consent.mjs';
import {normalizeOwnerActionButtons} from './owner-action-buttons.mjs';
import {OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY,normalizeOwnerActionRef} from './owner-reply-store.mjs';

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
  const body = nonempty(value, 'body', kind==='normal'?3790:1000);
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
  return null;
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
  conversationStore = createConversationStore(supabase),
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

  async function prepareMessage({workspaceId,to,kind,payload,key,customerId=null,invoiceId=null,audience='customer',ownerActionFallback=null}) {
    const body=payload.type==='template'?`Hi, this is ${payload.template.components[0].parameters[0].text}. Invoice ${payload.template.components[0].parameters[1].text} has an update. Reply STOP anytime.`:payload.text?.body||payload.interactive?.body?.text||payload.image?.caption||payload.document?.caption||'[Attachment]';
    const fallbackRef=ownerActionFallback==null?null:normalizeOwnerActionRef(ownerActionFallback);
    if(ownerActionFallback!=null&&(!fallbackRef||audience!=='owner'||kind!=='normal'||body!==OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY
      ||payload.type!=='text'||!payload.text||payload.interactive))throw new TypeError('invalid owner action fallback');
    if(workspaceId&&conversationStore){
      const stored=await conversationStore.record({workspaceId,customerId,invoiceId,phone:to,direction:'outbound',audience,body,kind,status:'pending',key});
      if(!stored?.body)throw Error('Outbound message intent missing');
      if(stored.audience!==audience||stored.phone!==to||stored.kind!==kind
        ||(stored.customer_id??null)!==customerId||(stored.invoice_id??null)!==invoiceId)
        throw Error('Outbound intent recipient scope changed');
      if(stored.status==='blocked')throw Error('Outbound message was blocked');
      // A retry before the atomic claim must send the exact first saved text.
      if(payload.type==='template'&&stored.body!==body)throw Error('Reviewed template intent changed');
      if(fallbackRef){
        const storedRef=normalizeOwnerActionRef(stored.owner_action_ref);
        if(!['pending','failed'].includes(stored.status)||!storedRef
          ||storedRef.pendingId!==fallbackRef.pendingId||storedRef.pendingVersion!==fallbackRef.pendingVersion)
          throw Error('Owner action fallback no longer matches the pending receipt');
        // This is a fixed recovery sentence, permitted only for the same
        // pending owner-action receipt. Never let a caller replace ordinary
        // saved replies through retry metadata.
        payload.text.body=OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY;
      }else if(payload.text)payload.text.body=stored.body;
      if(payload.interactive)payload.interactive.body.text=stored.body;
      if(payload.image)payload.image.caption=stored.body;
      if(payload.document)payload.document.caption=stored.body;
      payload.biz_opaque_callback_data=conversationCallbackToken(workspaceId,key);
    }else if(fallbackRef)throw Error('Owner action fallback requires a durable receipt');
    return payload;
  }

  async function denyPrepared({workspaceId,to,kind,key,reason,claimed=false}) {
    if(workspaceId&&conversationStore){
      if(claimed)await conversationStore.finish({workspaceId,key,status:'blocked'});
      else await conversationStore.abandonReply?.({workspaceId,key});
    }
    return block(logger,reason,{workspaceId,to,kind});
  }

  async function postMessage({workspaceId,to,kind,payload,key}) {
    const finish=async result=>{
      if(workspaceId&&conversationStore){
        for(let attempt=0;attempt<3;attempt++){
          try{await conversationStore.finish({workspaceId,key,...result});return result;}
          catch(error){if(attempt===2)logger?.error?.('WhatsApp receipt history pending callback recovery',{
            providerMessageId:result.providerMessageId,message:String(error?.message||'').slice(0,200)});}
        }
        // Never resend an accepted or uncertain Graph request. A verified callback
        // matches the pre-saved token even when the response ID wasn't persisted.
        return {...result,historySyncPending:true};
      }
      return result;
    };
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
      return finish({status: 'unknown', reason: 'network_error'});
    }
    if (!response.ok) {
      logger?.error?.({event: 'whatsapp_outbound_failed', workspaceId, recipient: maskedPhone(to), kind, httpStatus: response.status});
      return finish({status: 'failed', reason: 'graph_rejected', httpStatus: response.status});
    }
    let data;
    try { data = await response.json(); } catch { return finish({status: 'unknown', reason: 'invalid_graph_response'}); }
    const providerMessageId = data?.messages?.[0]?.id;
    return finish(typeof providerMessageId === 'string' && providerMessageId
      ? {status: 'accepted', providerMessageId}
      : {status: 'unknown', reason: 'missing_graph_message_id'});
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
    const name = nonempty(businessName, 'businessName', 200);
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
    const key=`template:${idempotencyKey}`;
    const payload=await prepareMessage({workspaceId,to,customerId,invoiceId,key,kind:'invoice_update',payload:{
      type:'template',template:{name:TEMPLATE_NAME,language:{code:'en_US'},components:[
        {type:'body',parameters:[{type:'text',text:name},{type:'text',text:number}]},
      ]},
    }});
    const claim = await claimInvoiceUpdate({workspaceId, invoiceId, customerId, phone: to, idempotencyKey: eventKey, expectedUpdatedAt: revision});
    if (claim?.claimed !== true) return block(logger, claim?.reason || 'duplicate_invoice_update', {workspaceId, to, kind: 'invoice_update'});
    if(!await verifiedBusinessName(supabase,workspaceId,name))
      return denyPrepared({workspaceId,to,key,kind:'invoice_update',reason:'business_name_changed',claimed:true});
    const postClaimEligibility = await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
    if (!postClaimEligibility.allowed || postClaimEligibility.customer?.id !== customerId) {
      return denyPrepared({workspaceId,to,key,kind:'invoice_update',reason:postClaimEligibility.reason||'customer_mismatch',claimed:true});
    }
    // This is an explicitly neutral, fixed test template. The approved Meta
    // template must say "Hi, this is {{1}}" and provide an invoice update with
    // {{2}}. No caller-controlled reminder content is accepted.
    return postMessage({workspaceId,to,key,kind:'invoice_update',payload});
  }

  async function sendServiceReply({workspaceId = null, to, body, buttons, ownerActionFallback, lastInboundAt, kind = 'normal', messageId, businessName, audience='customer', ownerLinkResult, phase='answer'} = {}) {
    if(!['answer','ack'].includes(phase)||(phase==='ack'&&(audience!=='owner'||kind!=='normal')))throw new TypeError('invalid owner delivery phase');
    const blocked = preflight({workspaceId, to, kind});
    if (blocked) return blocked;
    recipient(to);
    if (!SERVICE_KINDS.has(kind)) throw new TypeError('invalid service reply kind');
    if (!withinServiceWindow(lastInboundAt, clock)) return block(logger, 'service_window_closed', {workspaceId, to, kind});
    if (typeof authorizeInboundReply !== 'function') return block(logger, 'missing_inbound_authorizer', {workspaceId, to, kind});
    const inboundId = nonempty(messageId, 'messageId');
    const ownerButtons=normalizeOwnerActionButtons(buttons);
    if(ownerButtons.length&&(audience!=='owner'||kind!=='normal'))throw new TypeError('interactive buttons are owner-only');
    const fallbackRef=ownerActionFallback==null?null:normalizeOwnerActionRef(ownerActionFallback);
    if(ownerActionFallback!=null&&(!fallbackRef||audience!=='owner'||kind!=='normal'||ownerButtons.length
      ||body!==OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY))throw new TypeError('invalid owner action fallback');
    if(ownerButtons.length&&Array.from(String(body??'')).length>1024)
      throw new TypeError('interactive owner button body exceeds the WhatsApp limit');
    if (kind === 'normal') nonempty(workspaceId, 'workspaceId');
    if (kind === 'verification' && workspaceId !== null) return block(logger, 'verification_must_be_unbound', {workspaceId, to, kind});
    const owner = nonempty(businessName, 'businessName', 200);
    if (kind === 'verification' || (kind === 'stop_confirmation' && workspaceId === null)) {
      if (owner !== 'CETLD') return block(logger, 'invalid_platform_identity', {workspaceId, to, kind});
    } else if (!await verifiedBusinessName(supabase, workspaceId, owner)) {
      return block(logger, 'business_name_mismatch', {workspaceId, to, kind});
    }
    // Fixed owner-linking confirmations are the only variants allowed on the unbound verification path.
    const linkText = kind === 'verification' ? {
      linked: 'Connected. I can access the invoices in your dashboard. Ask me to list your invoices, check a balance, or retrieve a file.',
      failed: 'We could not link this number. Start again from Settings on the dashboard and send the new code.',
    }[ownerLinkResult] : null;
    let text = linkText ? linkText
      : kind === 'verification'
      ? 'Please contact the business that issued your invoice to verify your WhatsApp number. Reply STOP to opt out.'
      : kind === 'stop_confirmation'
        ? "You've been opted out of WhatsApp updates. We won't message you again."
        : null;
    if (kind === 'normal') {
      if(audience==='owner'){
        text=nonempty(body,'body',3790);
        if(SESSION_PRESSURE_CONTENT.test(text))return block(logger,'owner_reply_safety_guard',{workspaceId,to,kind});
      }else try {
        const bounded=typeof body==='string'&&body.length>3790
          ?body.slice(0,3730)+'\n… View the full details in your dashboard.':body;
        text = neutralText(bounded, kind);
      } catch (error) {
        if (!(error instanceof TypeError) || error.message !== 'collection content is disabled') throw error;
        logger?.warn?.({event: 'whatsapp_outbound_guard_fallback', workspaceId, recipient: maskedPhone(to), kind});
        text = SAFE_GUARD_REPLY;
      }
    }
    let customerId=null;
    if (kind === 'normal') {
      if (!supabase) return block(logger, 'missing_store', {workspaceId, to, kind});
      const eligibility = audience==='owner'?{allowed:await authorizeOwnerPhone({supabase,workspaceId,phone:to})}:await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
      if (!eligibility.allowed) return block(logger, eligibility.reason, {workspaceId, to, kind});
      customerId=eligibility.customer?.id||null;
    }
    if(audience!=='owner')text=`${text}\n\n- ${owner}`;
    const key=`${phase==='ack'?'ack':'reply'}:${inboundId}`;
    const replyPayload=ownerButtons.length?{type:'interactive',interactive:{type:'button',body:{text},
      action:{buttons:ownerButtons.map(({id,title})=>({type:'reply',reply:{id,title}}))}}}
      :{type:'text',text:{preview_url:false,body:text}};
    const payload=await prepareMessage({workspaceId,to,kind,audience,customerId,key,payload:replyPayload,ownerActionFallback:fallbackRef});
    if(audience!=='owner'&&!payload.text.body.endsWith(`\n\n- ${owner}`))return denyPrepared({workspaceId,to,kind,key,reason:'business_name_changed'});
    const authorization = await authorizeInboundReply({workspaceId, phone: to, kind, messageId: inboundId,...(audience==='owner'?{audience,phase}: {})});
    if (authorization?.allowed !== true) return denyPrepared({workspaceId,to,kind,key,reason:authorization?.reason||'inbound_reply_denied'});
    if(workspaceId&&!await verifiedBusinessName(supabase,workspaceId,owner))
      return denyPrepared({workspaceId,to,kind,key,reason:'business_name_changed',claimed:true});
    if (kind === 'verification') {
      const suppression = await unboundSuppression(supabase, to);
      if (suppression) return denyPrepared({workspaceId,to,kind,key,reason:suppression,claimed:true});
    }
    if (kind === 'normal') {
      const finalEligibility = audience==='owner'?{allowed:await authorizeOwnerPhone({supabase,workspaceId,phone:to})}:await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
      if (!finalEligibility.allowed||(audience==='customer'&&finalEligibility.customer?.id!==customerId))
        return denyPrepared({workspaceId,to,kind,key,reason:finalEligibility.allowed?'customer_binding_changed':finalEligibility.reason||'owner_binding_changed',claimed:true});
    }
    return postMessage({workspaceId,to,kind,key,payload});
  }

  async function sendServiceMedia({workspaceId, to, media, caption, lastInboundAt, messageId, businessName,audience='customer'} = {}) {
    const kind = 'normal';
    const blocked = preflight({workspaceId, to, kind});
    if (blocked) return blocked;
    recipient(to); nonempty(workspaceId, 'workspaceId'); nonempty(messageId, 'messageId');
    if (!withinServiceWindow(lastInboundAt, clock)) return block(logger, 'service_window_closed', {workspaceId, to, kind});
    if (!await verifiedBusinessName(supabase, workspaceId, nonempty(businessName, 'businessName', 200))) return block(logger, 'business_name_mismatch', {workspaceId, to, kind});
    const eligibility = audience==='owner'?{allowed:await authorizeOwnerPhone({supabase,workspaceId,phone:to})}
      :await getSendEligibility({supabase, workspaceId, phone: to, category: 'invoice_updates'});
    if (!eligibility.allowed) return block(logger, eligibility.reason, {workspaceId, to, kind});
    if(typeof authorizeInboundReply!=='function')return block(logger,'missing_inbound_authorizer',{workspaceId,to,kind});
    const bytes = media?.bytes;
    if (!bytes?.length || bytes.length > 10 * 1024 * 1024) throw new TypeError('invalid invoice media');
    const image = String(media.mime_type || media.mimeType).startsWith('image/');
    const brandedCaption=audience==='owner'?nonempty(caption,'caption',1000)
      :`${String(caption||'').slice(0,Math.max(0,1000-businessName.length-4))}\n\n- ${businessName}`;
    if(audience==='owner'&&SESSION_PRESSURE_CONTENT.test(brandedCaption))return block(logger,'owner_reply_safety_guard',{workspaceId,to,kind});
    const key=`reply:${messageId}`;
    const payload=await prepareMessage({workspaceId,to,kind,audience,customerId:eligibility.customer?.id||null,key,payload:image
      ? {type:'image',image:{id:'',caption:brandedCaption}}
      : {type:'document',document:{id:'',filename:media.file_name||media.fileName||'invoice.pdf',caption:brandedCaption}}});
    if(audience!=='owner'&&!(payload.image?.caption||payload.document?.caption).endsWith(`\n\n- ${businessName}`))
      return denyPrepared({workspaceId,to,kind,key,reason:'business_name_changed'});
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', media.mime_type || media.mimeType || 'application/octet-stream');
    form.set('file', new Blob([bytes], {type: media.mime_type || media.mimeType}), media.file_name || media.fileName || 'invoice');
    const upload = await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: 'POST', headers: {Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`}, body: form, signal: AbortSignal.timeout(15000)});
    if (!upload.ok) {
      await conversationStore?.abandonReply?.({workspaceId,key});
      return {status: 'failed', reason: 'media_upload_rejected', httpStatus: upload.status};
    }
    const uploaded = await upload.json();
    if (!uploaded?.id) {
      await conversationStore?.abandonReply?.({workspaceId,key});
      return {status:'failed',reason:'missing_media_id'};
    }
    const authorization=await authorizeInboundReply({workspaceId,phone:to,kind,messageId,...(audience==='owner'?{audience}:{})});
    if(authorization?.allowed!==true)return denyPrepared({workspaceId,to,kind,key,reason:authorization?.reason||'inbound_reply_denied'});
    const finalEligibility=audience==='owner'?{allowed:await authorizeOwnerPhone({supabase,workspaceId,phone:to})}
      :await getSendEligibility({supabase,workspaceId,phone:to,category:'invoice_updates'});
    if(!finalEligibility.allowed||audience==='customer'&&finalEligibility.customer?.id!==eligibility.customer?.id)
      return denyPrepared({workspaceId,to,kind,key,reason:finalEligibility.allowed?'customer_binding_changed':finalEligibility.reason||'owner_binding_changed',claimed:true});
    if(!await verifiedBusinessName(supabase,workspaceId,businessName))return denyPrepared({workspaceId,to,kind,key,reason:'business_name_changed',claimed:true});
    if(image)payload.image.id=uploaded.id;else payload.document.id=uploaded.id;
    return postMessage({workspaceId,to,kind,key,payload});
  }

  // Intentionally no sendReminder method. Collection content remains on hold.
  return Object.freeze({sendInvoiceUpdateTemplate, sendServiceReply, sendServiceMedia, sendTypingIndicator});
}
