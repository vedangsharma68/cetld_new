import { createHash } from 'node:crypto';
import { InvalidWhatsAppInputError, WhatsAppError } from './errors.mjs';

const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidWhatsAppInputError(`${field} is required`);
  return value.trim();
};

const stableId = (workspaceId, key) => `mock-${createHash('sha256').update(`${workspaceId}\0${key}`).digest('hex').slice(0, 24)}`;

/** Deterministic, in-memory provider for tests and local development. */
export class MockWhatsAppProvider {
  #records = new Map();
  #failureKeys;
  #unknownKeys;
  #failurePredicate;
  #unknownPredicate;

  constructor(options = {}) {
    this.#failureKeys = new Set(options.failureKeys ?? []);
    this.#unknownKeys = new Set(options.unknownDeliveryKeys ?? []);
    this.#failurePredicate = options.failurePredicate;
    this.#unknownPredicate = options.unknownDeliveryPredicate;
  }

  async sendReminder(input) {
    const workspaceId = text(input?.workspaceId, 'workspaceId');
    const invoiceId = text(input?.invoiceId, 'invoiceId');
    const customerId = text(input?.customerId, 'customerId');
    const to = text(input?.to, 'to');
    const body = text(input?.body, 'body');
    const idempotencyKey = text(input?.idempotencyKey, 'idempotencyKey');
    const scopedKey = `${workspaceId}\0${idempotencyKey}`;
    const existing = this.#records.get(scopedKey);
    if (existing) return { ...existing, duplicate: true };

    const failed = this.#failureKeys.has(idempotencyKey) || this.#failureKeys.has(scopedKey) || this.#failurePredicate?.({ ...input, workspaceId, invoiceId, customerId, to, body, idempotencyKey }) === true;
    const unknown = !failed && (this.#unknownKeys.has(idempotencyKey) || this.#unknownKeys.has(scopedKey) || this.#unknownPredicate?.({ ...input, workspaceId, invoiceId, customerId, to, body, idempotencyKey }) === true);
    const result = {
      workspaceId, invoiceId, customerId, to, idempotencyKey,
      providerMessageId: stableId(workspaceId, idempotencyKey),
      status: failed ? 'failed' : unknown ? 'unknown' : 'accepted',
      ...(failed ? { errorCode: 'MOCK_SEND_FAILED' } : unknown ? { errorCode: 'MOCK_DELIVERY_UNKNOWN' } : {}),
    };
    this.#records.set(scopedKey, result);
    return { ...result };
  }

  get size() { return this.#records.size; }
  clear() { this.#records.clear(); }
}

export const createMockWhatsAppProvider = (options) => new MockWhatsAppProvider(options);
