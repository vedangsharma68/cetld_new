import {parseMetaStatuses} from './conversation-store.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createInboundRuntime, isOptOut, parseMetaMessages } from './cloud-inbound.mjs';

const MAX_BODY_BYTES = 256 * 1024;

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !appSecret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const actual = Buffer.from(signature.slice(7), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function readRawBody(request, limit = MAX_BODY_BYTES) {
  if (Buffer.isBuffer(request.rawBody)) {
    if (request.rawBody.length > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    return request.rawBody;
  }
  // Never serialize request.body: Vercel's parsed helper loses the signed bytes.
  if (!request || typeof request[Symbol.asyncIterator] !== 'function') throw Object.assign(new Error('Raw request body unavailable'), { status: 400 });
  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    parts.push(bytes);
  }
  return Buffer.concat(parts, size);
}

function header(request, name) {
  return request.headers?.[name] || request.headers?.[name.toLowerCase()] || request.headers?.[name.toUpperCase()];
}
function query(request) {
  if (request.query) return request.query;
  const url = new URL(request.url || '/', 'https://local.invalid');
  return Object.fromEntries(url.searchParams);
}
function safeEqualToken(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}
function createSupabase(env, fetchImpl) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('WhatsApp inbox storage unavailable');
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl },
  });
}

/** Dependency-injected to test signature, acknowledgments and dedupe without network calls. */
export function createWhatsAppWebhookHandler({ env = process.env, fetchImpl = globalThis.fetch, runtime, boundMessageFactory, waitUntil, logger = console } = {}) {
  const run = () => {
    if (runtime) return runtime;
    const supabase = createSupabase(env, fetchImpl);
    return createInboundRuntime({ env, fetchImpl, supabase, logger,
      onBoundMessage: boundMessageFactory?.({ env, fetchImpl, supabase, logger }) });
  };
  return async function handleWhatsAppWebhook(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    const params = query(request);
    if (request.method === 'GET' && params.process === '1') {
      if (!safeEqualToken(header(request, 'authorization'), `Bearer ${env.CRON_SECRET || ''}`) || !env.CRON_SECRET) return response.status(401).json({ error: 'Unauthorized' });
      try {
        if(params.diagnostic){
          if(!['john-invoices','meta'].includes(params.diagnostic))return response.status(400).json({error:'Unsupported diagnostic'});
          const result=await run().diagnoseOwnerChat({scenario:params.diagnostic,forceCloudflareUnavailable:params.quotaDead==='1'});
          return response.status(200).json(result);
        }
        const result = await run().processPending();
        return response.status(200).json(result);
      } catch (error) {
        logger.error('WhatsApp inbox processor failed', { name: error?.name || 'Error' });
        return response.status(503).json({ error: 'Inbox processor unavailable' });
      }
    }
    if (request.method === 'GET') {
      const valid = params['hub.mode'] === 'subscribe' && safeEqualToken(params['hub.verify_token'], env.WHATSAPP_VERIFY_TOKEN);
      if (!valid || !env.WHATSAPP_VERIFY_TOKEN) return response.status(403).send('Forbidden');
      return response.status(200).send(String(params['hub.challenge'] || ''));
    }
    if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
    try {
      const rawBody = await readRawBody(request);
      if (!verifyMetaSignature(rawBody, header(request, 'x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) return response.status(403).json({ error: 'Invalid signature' });
      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); }
      catch { return response.status(400).json({ error: 'Invalid JSON' }); }
      if (Array.isArray(payload?.entry)) for (const entry of payload.entry) {
        if (!Array.isArray(entry?.changes)) continue;
        for (const change of entry.changes) {
          if (change?.field !== 'messages') continue;
          const callbackMessages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
          const callbackStatuses = Array.isArray(change?.value?.statuses) ? change.value.statuses : [];
          for (const item of callbackStatuses) {
            try {
              const errors = Array.isArray(item?.errors) ? item.errors : [];
              logger.log('whatsapp-status ' + JSON.stringify({
                id: item?.id,
                status: item?.status,
                recipient_id: item?.recipient_id,
                timestamp: item?.timestamp,
                errors: errors.map(error => ({
                  code: error?.code,
                  title: error?.title,
                  message: error?.message,
                  details: error?.error_data?.details,
                })),
              }));
            } catch {}
          }
          try {
            logger.log('whatsapp-callback ' + JSON.stringify({
              messages: callbackMessages.length,
              statuses: callbackStatuses.length,
            }));
          } catch {}
        }
      }
      const messages = parseMetaMessages(payload, env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID);
      const inbound = run();
      const statuses=parseMetaStatuses(payload,env.WHATSAPP_PHONE_NUMBER_ID,env.WHATSAPP_WABA_ID);
      if(statuses.length&&typeof inbound.recordStatuses==='function')await inbound.recordStatuses(statuses);
      const inserted = await inbound.enqueue(messages);
      // An opt-out is persisted before Meta receives 200. The inbox holds a
      // durable retry if the handler is interrupted after insertion.
      for (const event of inserted) if (isOptOut(event.message_text)) await inbound.revokeOptOut(event);
      if (inserted.length && waitUntil) {
        waitUntil(inbound.processPending().catch(error => {
          logger.error('WhatsApp inbox continuation failed', { name: error?.name || 'Error' });
        }));
      }
      return response.status(200).json({ received: true });
    } catch (error) {
      const status = Number(error?.status) || 503;
      logger.error('WhatsApp webhook rejected', { status, name: error?.name || 'Error' });
      return response.status(status).json({ error: status === 413 ? 'Request too large' : status === 400 ? 'Invalid webhook' : 'Webhook unavailable' });
    }
  };
}
