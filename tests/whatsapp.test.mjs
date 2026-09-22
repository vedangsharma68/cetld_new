import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidWhatsAppInputError,
  MockWhatsAppProvider,
  UnsupportedWhatsAppProviderError,
  createWhatsAppProvider,
  normalizeInboundEvents,
} from '../automation/whatsapp/index.mjs';

const reminder = (overrides = {}) => ({
  workspaceId: 'workspace-a', invoiceId: 'invoice-1', customerId: 'customer-1',
  to: '+15551234567', body: 'Invoice INV-1 is due', idempotencyKey: 'invoice-1:customer-1:2026-09-22', ...overrides,
});

test('mock accepts a reminder and deduplicates the same idempotency key', async () => {
  const provider = new MockWhatsAppProvider();
  const first = await provider.sendReminder(reminder());
  const second = await provider.sendReminder(reminder());
  assert.equal(first.status, 'accepted');
  assert.match(first.providerMessageId, /^mock-/);
  assert.deepEqual(second, { ...first, duplicate: true });
  assert.equal(provider.size, 1);
});

test('idempotency is isolated by workspace', async () => {
  const provider = new MockWhatsAppProvider();
  const a = await provider.sendReminder(reminder());
  const b = await provider.sendReminder(reminder({ workspaceId: 'workspace-b' }));
  assert.equal(a.duplicate, undefined);
  assert.equal(b.duplicate, undefined);
  assert.notEqual(a.providerMessageId, b.providerMessageId);
  assert.equal(provider.size, 2);
});

test('mock can deterministically simulate failed and unknown delivery outcomes', async () => {
  const provider = new MockWhatsAppProvider({ failureKeys: ['failed'], unknownDeliveryKeys: ['unknown'] });
  assert.equal((await provider.sendReminder(reminder({ idempotencyKey: 'failed' }))).status, 'failed');
  assert.equal((await provider.sendReminder(reminder({ idempotencyKey: 'unknown' }))).status, 'unknown');
});

test('inbound normalization uses verified server workspace and ignores payload tenant fields', () => {
  const [event] = normalizeInboundEvents({
    workspaceId: 'attacker-workspace',
    events: [{ id: 'mock-msg-1', from: '+15551111111', to: '+15550000000', type: 'text', body: 'hello', timestamp: '1727000000', context: { thread: 't1' } }],
  }, { verifiedWorkspaceId: 'workspace-a' });
  assert.equal(event.workspaceId, 'workspace-a');
  assert.equal(event.providerMessageId, 'mock-msg-1');
  assert.equal(event.body, 'hello');
});

test('malformed inbound webhook is rejected and malformed messages are not emitted', () => {
  assert.throws(() => normalizeInboundEvents({ nope: true }, { verifiedWorkspaceId: 'workspace-a' }), InvalidWhatsAppInputError);
  assert.throws(() => normalizeInboundEvents({ events: [{ id: 'x', from: '+15551111111', to: '+15550000000', type: 'text', body: 'missing timestamp' }] }, { verifiedWorkspaceId: 'workspace-a' }), InvalidWhatsAppInputError);
  assert.throws(() => normalizeInboundEvents({ events: [{ id: 'x', from: '15551111111', to: '+15550000000', type: 'text', body: 'bad phone', timestamp: '1' }] }, { verifiedWorkspaceId: 'workspace-a' }), InvalidWhatsAppInputError);
  assert.throws(() => normalizeInboundEvents({ events: [{ id: 'x', from: '+15551111111', to: '+15550000000', type: 'text', body: 'ok', timestamp: '1' }, { id: '', from: '+15551111111', to: '+15550000000', type: 'text', body: 'bad', timestamp: '1' }] }, { verifiedWorkspaceId: 'workspace-a' }), InvalidWhatsAppInputError);
  assert.throws(() => normalizeInboundEvents({ events: [{ id: 'x', from: '+15551111111', to: '+15550000000', type: 'text', body: 'ok', timestamp: '1' }] }), InvalidWhatsAppInputError);
});

test('factory requires explicit mode and never uses mock in production', () => {
  assert.throws(() => createWhatsAppProvider({}), UnsupportedWhatsAppProviderError);
  assert.throws(() => createWhatsAppProvider({ mode: 'mock', environment: 'production' }), UnsupportedWhatsAppProviderError);
  assert.throws(() => createWhatsAppProvider({ mode: 'wapi' }), UnsupportedWhatsAppProviderError);
  assert.equal(createWhatsAppProvider({ mode: 'mock', environment: 'test' }).constructor, MockWhatsAppProvider);
});
