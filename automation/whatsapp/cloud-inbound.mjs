import {resolveOwnerBinding,resolveOwnerIdentity} from './owner-binding.mjs';
import {createOwnerMessageHandler} from './owner-handler.mjs';
import {createConversationStore} from './conversation-store.mjs';
import { resolveActiveBindings, revokeConsentForPhone, suppressUnknownPhone } from './consent.mjs';
import {createWhatsAppInvoiceUpdateStore} from './invoice-update-store.mjs';
import {writeConversationTurn} from './conversation-memory.mjs';

const MAX_MESSAGES = 100;
const MAX_INBOUND_RETRY_AGE_MS = 60 * 60_000;
const MAX_INTERACTION_ID_LENGTH = 256;
function staleInboundEvent(event, now) {
  const receivedAt = Date.parse(event.received_at || event.created_at || event.provider_timestamp || '');
  return Number.isFinite(receivedAt) && now - receivedAt > MAX_INBOUND_RETRY_AGE_MS;
}
const TIMEOUT_REPLY = 'That took longer than I can handle, so I stopped. Your message was received. Please send it again in a minute.';
const DEFAULT_PROCESS_BUDGET_MS = 240_000;
// Leave enough runway for a database lookup and a deterministic reply. Slow
// planner work may use the first slot, but is never started near the deadline.
const MIN_EVENT_BUDGET_MS = 5_000;
const SAFE_FALLBACK_REPLY = "Something broke on my side while handling that message, so I did not process it. Please send it again. If it keeps failing, tell Vedang.";
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
      const buttonReply = type === 'interactive' ? message?.interactive?.button_reply : null;
      const listReply = type === 'interactive' ? message?.interactive?.list_reply : null;
      const interactionId = buttonReply ? buttonReply.id : listReply?.id
        || (type==='button'&&typeof message.context?.id==='string'&&message.context.id.length<=252?'rt1.'+message.context.id:undefined);
      // Never reinterpret a provider's visible reply title when its opaque
      // selection reference is absent or malformed.
      if ((buttonReply || listReply) && (typeof interactionId !== 'string'
          || !interactionId.trim() || Buffer.byteLength(interactionId, 'utf8') > MAX_INTERACTION_ID_LENGTH)) continue;
      const body = type === 'text' ? message?.text?.body : type === 'button' ? (/^(stop|pause)$/i.test(message?.button?.payload||'')?message.button.payload:message?.button?.text) : type === 'interactive' ? (buttonReply?.title || listReply?.title) : media?.caption || '';
      if (!id || id.length > 256 || !E164.test(phone) || !type || type.length > 64 || typeof body !== 'string' || body.length > 4000) continue;
      const seconds = Number(message?.timestamp);
      const timestamp = Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
      found.push({ provider_message_id: id, phone_number_id: String(expectedPhoneNumberId), sender_phone: phone, message_type: type, message_text: body, provider_timestamp: timestamp,
        ...(interactionId ? {interactionId} : {}),
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
    const rows = messages.map(({interactionId, ...message}) => {
      const storedInteractionId = interactionId ?? message.interaction_id;
      if (storedInteractionId === undefined) return message;
      if (typeof storedInteractionId !== 'string' || !storedInteractionId.trim()
          || Buffer.byteLength(storedInteractionId, 'utf8') > MAX_INTERACTION_ID_LENGTH) {
        throw new TypeError('Invalid WhatsApp interaction ID');
      }
      return {...message, interaction_id: storedInteractionId};
    });
    const inserted = dataOrThrow(await this.supabase.from('whatsapp_inbound_events')
      .upsert(rows, { onConflict: 'provider_message_id', ignoreDuplicates: true })
      .select('*'), 'enqueue') || [];
    const stopIds=[];
    for(const message of messages.filter(item=>isOptOut(item.message_text))){
      // A verified owner can say STOP or cancel as ordinary conversation text.
      // Install the synchronous consent barrier only for non-owner senders.
      const owner=message.message_type==='button'?null
        :await resolveOwnerBinding({supabase:this.supabase,phone:message.sender_phone});
      if(!owner)stopIds.push(message.provider_message_id);
    }
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

  async checkpoint(event, workspaceId, ownerId, checkpoint) {
    if(!checkpoint||checkpoint.version!==1||Buffer.byteLength(JSON.stringify(checkpoint))>256*1024)
      throw Object.assign(new Error('Owner checkpoint exceeds its storage bounds'),{code:'OWNER_JOB_CHECKPOINT_INVALID'});
    const result=await this.supabase.from('whatsapp_inbound_events').update({owner_job_checkpoint:checkpoint,
      owner_job_workspace_id:workspaceId,owner_job_owner_id:ownerId})
      .eq('id',event.id).eq('claim_token',event.claim_token).eq('status','processing').select('id');
    const rows=dataOrThrow(result,'checkpoint');
    if(!rows?.length)throw Object.assign(new Error('Owner job lease was lost'),{code:'OWNER_JOB_LEASE_LOST'});
  }

  async beginOwnerJob(event,workspaceId,ownerId){
    const rows=dataOrThrow(await this.supabase.from('whatsapp_inbound_events').update({owner_job_workspace_id:workspaceId,owner_job_owner_id:ownerId})
      .eq('id',event.id).eq('claim_token',event.claim_token).eq('status','processing').select('id'),'begin owner job');
    if(!rows?.length)throw Object.assign(new Error('Owner job lease was lost'),{code:'OWNER_JOB_LEASE_LOST'});
  }

  async yieldJob(event) {
    const rows=dataOrThrow(await this.supabase.from('whatsapp_inbound_events').update({status:'pending',claim_token:null,
      claimed_at:null,processed_at:null,next_attempt_at:new Date().toISOString(),attempts:Math.max(0,Number(event.attempts||1)-1),
      error_code:null,error_detail:null}).eq('id',event.id).eq('claim_token',event.claim_token).select('id'),'yield owner job');
    if(!rows?.length)throw Object.assign(new Error('Owner job lease was lost'),{code:'OWNER_JOB_LEASE_LOST'});
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
    if (failed && retryable && staleInboundEvent(event, Date.now())) return this.deadLetter(event, errorDetail || errorCode);
    const retry = failed && retryable && event.attempts < 5;
    const next = new Date(Date.now() + Math.min(60_000 * 2 ** Math.max(0, event.attempts - 1), 60 * 60_000)).toISOString();
    dataOrThrow(await this.supabase.from('whatsapp_inbound_events')
      .update({ status: retry ? 'pending' : failed && retryable ? 'failed' : 'done', processed_at: retry ? null : new Date().toISOString(),
        claim_token: null, claimed_at: null, next_attempt_at: retry ? next : event.next_attempt_at,
        ...(!retry?{owner_job_checkpoint:null}:{}),
        error_code: errorCode, error_detail: errorDetail })
      .eq('id', event.id).eq('claim_token', event.claim_token), 'complete');
  }

  async deadLetter(event, errorDetail = null) {
    dataOrThrow(await this.supabase.from('whatsapp_inbound_events').update({
      status: 'failed', processed_at: new Date().toISOString(), claim_token: null, claimed_at: null,
      error_code: 'INBOUND_DEAD_LETTER', error_detail: String(errorDetail || event.error_code || 'Stale delivery retry expired.').slice(0, 1000),
      owner_job_checkpoint:null,
    }).eq('id', event.id).eq('claim_token', event.claim_token), 'dead letter');
  }

  async defer(event, errorCode = null, errorDetail = null) {
    if (errorCode && staleInboundEvent(event, Date.now())) return this.deadLetter(event, errorDetail || errorCode);
    const receivedAt=Date.parse(event.received_at||event.created_at||'');
    const retryAgeSteps=Number.isFinite(receivedAt)
      ?Math.floor(Math.max(0,Date.now()-receivedAt)/60_000):Math.max(0,Number(event.attempts||1)-1);
    const delayMs=Math.min(60_000*2**retryAgeSteps,60*60_000);
    dataOrThrow(await this.supabase.from('whatsapp_inbound_events').update({status: 'pending', processed_at: null,
      claim_token: null, claimed_at: null, next_attempt_at: new Date(Date.now()+delayMs).toISOString(),
      attempts: Math.max(0, Number(event.attempts || 1) - 1),
      ...(errorCode ? {error_code: errorCode, error_detail: String(errorDetail || '').slice(0, 1000)} : {})})
      .eq('id', event.id).eq('claim_token', event.claim_token), 'defer');
  }
}

const stopReply = 'Your request has been recorded. You will no longer receive WhatsApp invoice updates from this business.';

/** Route only through service-role consent/customer binding; never use a claimed name. */
export function createInboundRuntime({ env = process.env, fetchImpl = globalThis.fetch, supabase, inbox = new SupabaseInboundInbox(supabase), outbound,
  onBoundMessage, onOwnerMessage, conversationStore = createConversationStore(supabase), reminderReceiptStore=null, logger = console, clock = () => Date.now() } = {}) {
  if (!supabase) throw new Error('Supabase service client required');
  let ownerHandler=onOwnerMessage||null;
  const runOwnerMessage=async input=>{
    if(!ownerHandler)ownerHandler=createOwnerMessageHandler({supabase,env,fetchImpl});
    return ownerHandler(input);
  };
  async function ownerFailureContext(event){
    let binding;
    try{binding=await resolveOwnerBinding({supabase,phone:event.sender_phone});}
    catch(error){
      logger?.error?.('WhatsApp owner recovery binding lookup failed',{messageId:event.provider_message_id,
        code:String(error?.code||'OWNER_BINDING_UNAVAILABLE').slice(0,60)});
      return {verifiedOwner:false,bindingUnavailable:true};
    }
    if(!binding)return {verifiedOwner:false};
    if(!ownerHandler)ownerHandler=createOwnerMessageHandler({supabase,env,fetchImpl});
    if(typeof ownerHandler.createSafeFailureReply!=='function')return {verifiedOwner:true,binding,reply:null};
    const reply=await ownerHandler.createSafeFailureReply({workspaceId:binding.workspaceId,
      hasAttachment:Boolean(event.media_ref||['image','document'].includes(event.message_type))});
    return {verifiedOwner:true,binding,reply};
  }
  async function transcript(input){await conversationStore?.record(input);}
  let outboundPromise;
  const getOutbound = async () => {
    if (outbound) return outbound;
    outboundPromise ||= import('./cloud-outbound.mjs').then(({ createWhatsAppOutbound }) => {
      const invoiceUpdates = createWhatsAppInvoiceUpdateStore({supabase});
      return createWhatsAppOutbound({env, fetchImpl, supabase, logger, ...invoiceUpdates,
        authorizeInboundReply: async input => input.audience==='owner'
          ? {allowed:dataOrThrow(await supabase.rpc(input.phase==='ack'?'whatsapp_claim_owner_ack':'whatsapp_claim_owner_reply',{p_provider_message_id:input.messageId,p_sender_phone:input.phone,p_workspace_id:input.workspaceId}),'claim owner reply')===true}
          : inbox.claimReply(input)});
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
    // The signed webhook calls this before its worker runs. Resolve the same
    // current owner binding here, before suppression can invalidate it. Historical
    // verification alone must not exempt a recipient from STOP/CANCEL handling.
    // Template reminder buttons retain their recipient opt-out path.
    if(event.message_type!=='button'){
      const owner=await resolveOwnerBinding({supabase,phone:event.sender_phone});
      // A webhook replay of a durable owner job must not become a recipient
      // opt-out if the binding changed after the original turn.
      if((event.owner_job_checkpoint||event.owner_ack_claimed_at||event.owner_job_workspace_id)
        &&(!owner||event.owner_job_workspace_id!==owner.workspaceId||event.owner_job_owner_id!==owner.ownerId))
        throw Object.assign(new Error('Owner job binding changed'),{code:'OWNER_JOB_BINDING_CHANGED'});
      if(owner)return;
    }
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
  async function recordOptOut(event) {
    if(!conversationStore)return;
    // Suppression has already committed. Only verified current identities get history.
    const owner=await resolveOwnerIdentity({supabase,phone:event.sender_phone});
    const bindings=owner?[owner]:[];
    if(!owner){
      const consents=dataOrThrow(await supabase.from('whatsapp_consents').select('workspace_id,customer_id')
        .eq('phone',event.sender_phone),'STOP history scopes')||[];
      for(const consent of consents){
        const customer=dataOrThrow(await supabase.from('customers').select('id')
          .eq('workspace_id',consent.workspace_id).eq('id',consent.customer_id)
          .eq('phone',event.sender_phone).maybeSingle(),'STOP history customer');
        if(customer)bindings.push({workspaceId:consent.workspace_id,customerId:customer.id});
      }
    }
    for(const binding of bindings)await transcript({workspaceId:binding.workspaceId,customerId:binding.customerId,
      phone:event.sender_phone,audience:owner?'owner':'customer',direction:'inbound',body:event.message_text,
      kind:event.message_type,status:'received',providerMessageId:event.provider_message_id,
      key:`inbound:${event.provider_message_id}`,createdAt:event.provider_timestamp||event.received_at});
  }
  async function processEvent(event, {signal, deadlineAt} = {}) {
    const active = () => {
      if (signal?.aborted || (Number.isFinite(deadlineAt) && clock() >= deadlineAt)) throw Object.assign(new Error('Inbound processing deadline expired'), {name: 'AbortError'});
    };
    active();
    const interactionId = event.interaction_id ?? event.interactionId;
    if(event.message_type==='button'){
      // A signed reply must reference an actual reminder to this phone. The
      // server resolves tenant/invoice from its receipt, never from button data.
      if(typeof interactionId!=='string'||!interactionId.startsWith('rt1.'))return 'unmatched_template_button';
      const result=dataOrThrow(await supabase.rpc('cetld_core_handle_reminder_button',{
        p_phone:event.sender_phone,p_context_message_id:interactionId.slice(4),p_message_id:event.provider_message_id,
        p_action:isOptOut(event.message_text)||/^stop(?: updates| messages| reminders)?$/i.test(event.message_text||'')?'stop':'pause',
      }),'reminder button');
      return result?.ok===true?result.status:'unmatched_template_button';
    }
    // Resolve the verified owner before interpreting STOP/CANCEL or onboarding
    // words. Those strings can be ordinary owner conversation turns; only a
    // non-owner debtor message installs consent barriers and exits the model.
    const owner=await resolveOwnerBinding({supabase,phone:event.sender_phone});
    // A resumed owner job cannot be reinterpreted as a debtor message after
    // unbinding. Validate its persisted scope before STOP/link routing.
    if((event.owner_job_checkpoint||event.owner_ack_claimed_at||event.owner_job_workspace_id)
      &&(!owner||event.owner_job_workspace_id!==owner.workspaceId||event.owner_job_owner_id!==owner.ownerId))
      throw Object.assign(new Error('Owner job binding changed'),{code:'OWNER_JOB_BINDING_CHANGED'});
    if (!owner&&isOptOut(event.message_text)) {
      if (!event.stop_processed_at) {
        await revokeOptOut(event);
        // The just-claimed copy predates the stop update; use the fresh binding
        // result only after re-reading the durable row.
        const { data, error } = await supabase.from('whatsapp_inbound_events').select('*').eq('id', event.id).single();
        if (error) throw error;
        event = data;
      }
      await recordOptOut(event);
      if (event.stop_confirmation_due) {
        const sender = await getOutbound();
        await sender.sendServiceReply({ workspaceId: event.stop_workspace_id, to: event.sender_phone,
          body: stopReply, lastInboundAt: event.provider_timestamp || event.received_at, kind: 'stop_confirmation',
          messageId: event.provider_message_id, businessName: await businessName(event.stop_workspace_id) });
      }
      return 'opt_out';
    }
      const linkMatch = /^\s*link[\s:-]*(\d{6})\s*$/i.exec(event.message_text || '');
      if (!owner&&linkMatch) {
        // The sender phone comes from WhatsApp, so a matching dashboard code proves they hold the number.
        try {
          const { data: result, error } = await supabase.rpc('whatsapp_verify_owner_code', { p_phone: event.sender_phone, p_code: linkMatch[1] });
          if (error) throw error;
          const sender = await getOutbound();
          await sender.sendServiceReply({ workspaceId: null, to: event.sender_phone, body: '',
            ownerLinkResult: result?.ok === true ? 'linked' : 'failed',
            lastInboundAt: event.provider_timestamp || event.received_at, kind: 'verification',
            messageId: event.provider_message_id, businessName: 'CETLD' });
          return 'verify';
        } catch (error) {
          logger?.error?.('WhatsApp owner link failed', { message: String(error?.message || '').slice(0, 200) });
        }
      }
    const bindings=owner?[owner]:await resolveActiveBindings({supabase,phone:event.sender_phone});
    if(bindings.length!==1)return 'verify';
    const binding = bindings[0];
    if (!binding.workspaceId || (!owner && (!binding.customerId || !binding.customer))) throw new Error('Incomplete sender binding');
    if(owner&&!event.owner_job_workspace_id&&typeof inbox.beginOwnerJob==='function')await inbox.beginOwnerJob(event,binding.workspaceId,binding.ownerId);
    await transcript({workspaceId:binding.workspaceId,customerId:owner?null:binding.customerId,phone:event.sender_phone,
      audience:owner?'owner':'customer',direction:'inbound',body:event.message_text||`[${event.message_type} attachment]`,
      kind:event.message_type,status:'received',providerMessageId:event.provider_message_id,key:`inbound:${event.provider_message_id}`,
      createdAt:event.provider_timestamp||event.received_at});
    if(!owner)dataOrThrow(await supabase.rpc('whatsapp_pause_customer_followups',{
      p_workspace_id:binding.workspaceId,p_customer_id:binding.customerId,p_message_id:event.provider_message_id}),'pause customer follow-ups');
    const handle=owner?runOwnerMessage:onBoundMessage;
    if (handle) {
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
      const ownerMediaError=owner&&(event.media_error||Boolean(event.media_ref&&!media))?'The attachment could not be loaded.':null;
      // Quick turns only show typing. Progress text is reserved for work that
      // is still running after a full minute, never sent ahead of every reply.
      let progressSend=null;
      const progressTimer=owner&&!event.owner_ack_claimed_at&&typeof inbox.checkpoint==='function'
        ?setTimeout(()=>{
          progressSend=(async()=>{
            try{const sender=await getOutbound();await sender.sendServiceReply({workspaceId:binding.workspaceId,to:event.sender_phone,
              body:"I'm still working on this. I'll message you when it's done.",lastInboundAt:event.provider_timestamp||event.received_at,
              kind:'normal',audience:'owner',phase:'ack',messageId:event.provider_message_id,businessName:binding.businessName||'CETLD'});}
            catch{logger?.warn?.('WhatsApp owner acknowledgement failed',{code:'OWNER_ACK_NOT_ACCEPTED'});}
          })();
        },60_000):null;
      let typingRefreshInFlight=false;
      const typingTimer=owner?setInterval(async()=>{
        if(typingRefreshInFlight)return;
        typingRefreshInFlight=true;
        try{const sender=await getOutbound();await sender.sendTypingIndicator({messageId:event.provider_message_id});}
        catch{logger?.warn?.('WhatsApp typing refresh failed',{code:'TYPING_NOT_ACCEPTED'});}
        finally{typingRefreshInFlight=false;}
      },20_000):null;
      let response;
      try{
        response = event.media_error&&!owner ? MEDIA_FETCH_FAILED_REPLY : await handle({ workspaceId: binding.workspaceId, customerId: binding.customerId, ownerId:binding.ownerId,
        phone: event.sender_phone, message: event.message_text, messageId: event.provider_message_id, media,
        ...(owner&&typeof interactionId==='string'&&Buffer.byteLength(interactionId,'utf8')<=MAX_INTERACTION_ID_LENGTH
          ?{interactionId}:{}),
        mediaError: owner?ownerMediaError:event.media_ref && !media ? 'Stored media unavailable' : null, signal, deadlineAt,
        ...(owner?{verifiedOwnerBinding:binding,allowDeferred:true,checkpoint:event.owner_job_checkpoint||null,
          onCheckpoint:typeof inbox.checkpoint==='function'?checkpoint=>inbox.checkpoint(event,binding.workspaceId,binding.ownerId,checkpoint):null}: {}) });
      }finally{
        if(typingTimer!==null)clearInterval(typingTimer);
        if(progressTimer!==null)clearTimeout(progressTimer);
        if(progressSend)await progressSend;
      }
      if(owner&&response?.deferred){
        if(typeof inbox.yieldJob!=='function')throw Object.assign(new Error('Durable continuation is unavailable'),{code:'OWNER_JOB_STORE_UNAVAILABLE'});
        await inbox.yieldJob(event);
        return {deferred:true};
      }
      active();
      // An accepted reply can outlive its inbox lease. Finish that recovered
      // event without a second Graph send or another claim of the same reply.
      if(owner&&response?.replayed&&response.replayMessageId===event.provider_message_id
        &&['accepted','sent','delivered','read'].includes(response.replayDeliveryStatus))return 'bound';
      const answer = typeof response === 'string' ? response : response?.answer;
      if (typeof answer === 'string' && answer.trim()) {
        const sender = await getOutbound();
        const send = response?.media && typeof sender.sendServiceMedia === 'function' ? sender.sendServiceMedia.bind(sender) : sender.sendServiceReply.bind(sender);
        const sent = await send({ workspaceId: binding.workspaceId, to: event.sender_phone, body: answer, caption: answer,
          ...(response?.media ? {media: response.media} : {}),
          ...(owner&&Array.isArray(response?.buttons)?{buttons:response.buttons}:{}),
          ...(owner&&response?.ownerActionFallback?{ownerActionFallback:response.ownerActionFallback}:{}),
          lastInboundAt: event.provider_timestamp || event.received_at, kind: 'normal', audience:owner?'owner':'customer', messageId: event.provider_message_id,
          businessName: await businessName(binding.workspaceId) });
        if(owner&&sent?.status!=='accepted')throw Object.assign(new Error('Owner reply was not accepted for delivery.'),{code:'OWNER_REPLY_NOT_ACCEPTED'});
        if (sent?.status === 'accepted') {
          try {
            await writeConversationTurn({supabase, workspaceId: binding.workspaceId,
              customerId: owner?null:binding.customerId, phone: event.sender_phone, role: 'assistant', content: answer,audience:owner?'owner':'customer'});
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
  async function deadLetter(event, reason) {
    if (typeof inbox.deadLetter === 'function') await inbox.deadLetter(event, reason);
    else await inbox.complete(event, 'INBOUND_DEAD_LETTER', reason, false);
    logger?.warn?.('WhatsApp inbound event dead-lettered', {messageId: event.provider_message_id,
      code: 'INBOUND_DEAD_LETTER', reason, receivedAt: event.received_at || event.created_at || event.provider_timestamp || null});
    return true;
  }
  async function failFinalAttempt(event) {
    if (staleInboundEvent(event, clock())) return deadLetter(event, 'Stale event exhausted delivery attempts.');
    let failedOwner=null;
    try {
      failedOwner=await ownerFailureContext(event);
      if(failedOwner.bindingUnavailable||(failedOwner.verifiedOwner&&!failedOwner.reply)){
        if(typeof inbox.defer==='function'){await inbox.defer(event, 'OWNER_REPLY_NOT_ACCEPTED');return false;}
        throw new Error('Owner message must remain queued until an AI reply can be generated.');
      }
      const sender = await getOutbound();
      if(failedOwner.verifiedOwner){
        const sent=await sender.sendServiceReply({workspaceId:failedOwner.binding.workspaceId,to:event.sender_phone,
          body:failedOwner.reply,lastInboundAt:event.provider_timestamp||event.received_at,kind:'normal',audience:'owner',
          messageId:event.provider_message_id,businessName:await businessName(failedOwner.binding.workspaceId)});
        if(sent?.status!=='accepted'){await inbox.defer(event, 'OWNER_REPLY_NOT_ACCEPTED');return false;}
      }else await sender.sendServiceReply({ workspaceId: null, to: event.sender_phone, body: SAFE_FALLBACK_REPLY,
        lastInboundAt: event.provider_timestamp || event.received_at, kind: 'verification',
        messageId: event.provider_message_id, businessName: 'CETLD' });
    } catch (error) {
      logger.error('WhatsApp final-attempt fallback failed', { messageId: event.provider_message_id,
        message: String(error?.message || '').slice(0, 200) });
      if(failedOwner?.verifiedOwner||failedOwner?.bindingUnavailable){await inbox.defer(event, 'OWNER_REPLY_NOT_ACCEPTED');return false;}
    }
    await inbox.complete(event, 'PROCESSING_FAILED', null, false);
    return true;
  }
  return {
    async diagnoseOwnerChat(options){
      const {diagnoseOwnerChat}=await import('./owner-diagnostics.mjs');
      return diagnoseOwnerChat({supabase,env,fetchImpl,logger,...options});
    },
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
    async recordStatuses(items){for(const item of items){await conversationStore?.status(item);await reminderReceiptStore?.status(item);}},
    async processPending() {
      const configuredBudget = Number(env.WHATSAPP_PROCESS_BUDGET_MS);
      const budgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0
        ? Math.min(configuredBudget,DEFAULT_PROCESS_BUDGET_MS) : DEFAULT_PROCESS_BUDGET_MS;
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
        if (staleInboundEvent(event, clock()) && (event.error_code || event.reply_claimed_at || (!event.owner_job_workspace_id&&!event.owner_job_checkpoint&&Number(event.attempts) > 1))) {
          await deadLetter(event, 'Stale delivery retry expired before reprocessing.');
          completed++;
          continue;
        }
        if (event.attempts >= 5) {
          if(await failFinalAttempt(event))completed++;
          continue;
        }
        try {
          const result = await processEvent(event, {signal: controller.signal, deadlineAt});
          if(result?.deferred)break;
          if (result?.plannerFailure) {
            const detail = JSON.stringify(result.plannerFailure).slice(0, 1000);
            await inbox.complete(event, 'ASSISTANT_PLANNER_FAILED', detail, false);
          } else await inbox.complete(event);
          completed++;
        }
        catch (error) {
          const timedOut = controller.signal.aborted || clock() >= deadlineAt;
          logger.error('WhatsApp inbound event failed', { messageId: event.provider_message_id, name: error?.name || 'Error',
            timedOut, message: String(error?.message || '').slice(0, 200) });
          if(timedOut&&typeof inbox.yieldJob==='function'){
            await inbox.yieldJob(event);
            logger?.info?.('WhatsApp background work retained',{code:'OWNER_JOB_CONTINUATION',durationMs:clock()-startedAt});
            break;
          }
          if (staleInboundEvent(event, clock())) {
            await deadLetter(event, String(error?.code || 'PROCESSING_FAILED').slice(0, 80));
            completed++;
            if (timedOut) break;
            continue;
          }
          // Never leave the sender in silence: say what happened, then close the event.
          let failedOwner=null;
          let ownerReplyAccepted=false;
          try {
            failedOwner=await ownerFailureContext(event);
            if(failedOwner.bindingUnavailable)throw Object.assign(new Error('Owner binding is temporarily unavailable.'),{code:'OWNER_BINDING_UNAVAILABLE'});
            const sender = await getOutbound();
            if(failedOwner.verifiedOwner){
              if(failedOwner.reply){const sent=await sender.sendServiceReply({workspaceId:failedOwner.binding.workspaceId,to:event.sender_phone,
                body:failedOwner.reply,lastInboundAt:event.provider_timestamp||event.received_at,kind:'normal',audience:'owner',
                messageId:event.provider_message_id,businessName:await businessName(failedOwner.binding.workspaceId)});
                ownerReplyAccepted=sent?.status==='accepted';
              }
            }else await sender.sendServiceReply({ workspaceId: null, to: event.sender_phone,
              body: timedOut ? TIMEOUT_REPLY : SAFE_FALLBACK_REPLY,
              lastInboundAt: event.provider_timestamp || event.received_at, kind: 'verification',
              messageId: event.provider_message_id, businessName: 'CETLD' });
          } catch (replyError) {
            logger.error('WhatsApp failure notice failed', { messageId: event.provider_message_id,
              message: String(replyError?.message || '').slice(0, 200) });
          }
          if((failedOwner?.verifiedOwner&&!ownerReplyAccepted)||failedOwner?.bindingUnavailable){
            if(typeof inbox.defer==='function')await inbox.defer(event, failedOwner?.bindingUnavailable ? 'OWNER_BINDING_UNAVAILABLE' : 'OWNER_REPLY_NOT_ACCEPTED', String(error?.message || '').slice(0, 1000));
            else await inbox.complete(event,timedOut?'PROCESSING_TIMEOUT':'PROCESSING_FAILED',
              String(error?.message||'').slice(0,1000));
            if(timedOut)break;
            continue;
          }
          await inbox.complete(event, timedOut ? 'PROCESSING_TIMEOUT' : 'PROCESSING_FAILED', String(error?.message || '').slice(0, 1000));
          if (timedOut) break;
        }
        // Media is the long path. Leave later events unclaimed for the next
        // webhook continuation or five-minute cron invocation.
        if (event.media_ref) break;
      }} finally { clearTimeout(deadlineTimer); }
      return { claimed, completed };
    },
  };
}
