import { waitUntil } from '@vercel/functions';
import { createWhatsAppWebhookHandler } from '../automation/whatsapp/webhook.mjs';
import { createWhatsAppBoundMessageHandler } from '../automation/whatsapp/assistant-handler.mjs';

// Vercel must leave the incoming bytes untouched for Meta HMAC verification.
export const config = { api: { bodyParser: false } };
export default createWhatsAppWebhookHandler({ waitUntil,
  boundMessageFactory: createWhatsAppBoundMessageHandler });
