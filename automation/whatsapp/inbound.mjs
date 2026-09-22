import { InvalidWhatsAppInputError } from './errors.mjs';

const MAX_EVENTS = 100;
const MAX_ID = 256;
const MAX_PHONE = 16;
const MAX_BODY = 4000;
const e164 = (value, field) => {
  if (typeof value !== 'string' || !/^\+[1-9]\d{6,14}$/.test(value) || value.length > MAX_PHONE) {
    throw new InvalidWhatsAppInputError(`${field} must be an E.164 phone number`);
  }
  return value;
};
const required = (value, field, max = MAX_ID) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InvalidWhatsAppInputError(`${field} is invalid`);
  return value.trim();
};

/**
 * Normalize the provider-neutral webhook shape:
 * { events: [{ id, from, to, type, body, timestamp, context }] }
 * The webhook verifier supplies verifiedWorkspaceId; payload tenant fields are ignored.
 */
export function normalizeInboundEvents(payload, { verifiedWorkspaceId } = {}) {
  const workspaceId = required(verifiedWorkspaceId, 'verifiedWorkspaceId');
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events) || payload.events.length === 0 || payload.events.length > MAX_EVENTS) {
    throw new InvalidWhatsAppInputError('webhook events must be a non-empty bounded array');
  }
  return payload.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new InvalidWhatsAppInputError(`event ${index} is invalid`);
    const providerMessageId = required(event.id, `event ${index} id`);
    const from = e164(event.from, `event ${index} from`);
    const to = e164(event.to, `event ${index} to`);
    const type = required(event.type, `event ${index} type`, 64);
    if (typeof event.body !== 'string' || event.body.length > MAX_BODY) throw new InvalidWhatsAppInputError(`event ${index} body is invalid`);
    const timestamp = typeof event.timestamp === 'string' || typeof event.timestamp === 'number'
      ? String(event.timestamp).slice(0, 64)
      : '';
    if (!timestamp) throw new InvalidWhatsAppInputError(`event ${index} timestamp is invalid`);
    const context = event.context === undefined ? undefined : event.context;
    if (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context))) throw new InvalidWhatsAppInputError(`event ${index} context is invalid`);
    return { workspaceId, providerMessageId, from, to, type, body: event.body, timestamp, ...(context === undefined ? {} : { context: structuredClone(context) }), raw: structuredClone(event) };
  });
}

export const normalizeInboundEvent = (payload, options) => normalizeInboundEvents(payload, options)[0];
