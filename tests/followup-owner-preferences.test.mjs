import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFollowUpPreferences, reminderBody } from '../automation/preferences.mjs';
import { scheduleInitialFollowUp, scheduleNextFollowUp } from '../automation/cadence.mjs';
import { FollowUpEngine } from '../automation/engine.mjs';
import { createAutomationRuntime } from '../automation/runtime.mjs';
import { MemoryAutomationStore } from '../automation/store.mjs';
import { MockWhatsAppProvider } from '../automation/whatsapp/mock.mjs';

const scope = { ownerId: 'owner', workspaceId: 'workspace', invoiceId: 'invoice' };
const now = new Date('2026-09-22T10:00:00Z');
const prefs = {
  tone: 'firm', firstReminderDays: 1, cadenceDays: 2, maxReminders: 2,
  allowedWeekdays: [1, 2, 3, 4, 5], contactStart: '09:00', contactEnd: '17:00',
  escalation: 'manual_review', pauseOnReply: true, stopOnPayment: true, dailySummary: true,
};

function setup(overrides = {}) {
  const store = new MemoryAutomationStore({ now: () => now });
  const approval = { invoice_direction: 'receivable', approved_reminder_text: 'Invoice INV-1 remains outstanding. Please arrange payment or contact us with an update.', approved_preferences_updated_at: 'v1' };
  store.seedInvoice({
    id: scope.invoiceId, ...scope, total_amount: '10.00', amountMinor: 1000,
    paidMinor: 0, status: 'open', due_date: '2026-09-21',
    invoice_number: 'INV-1',
    followupState: 'approved', nextFollowUpAt: '2026-09-22T09:00:00Z',
    customerPhone: '+919876543210', reminderCount: 0, ...overrides.invoice,
    metadata: { ...approval, ...overrides.invoice?.metadata },
  });
  let owner = { follow_up_preferences: { ...prefs, ...overrides.preferences }, default_timezone: 'UTC', updated_at: 'v1' };
  store.getWorkspacePreferences = () => owner;
  const provider = new MockWhatsAppProvider();
  let sends = 0;
  const original = provider.sendReminder.bind(provider);
  provider.sendReminder = async (input) => { sends++; return original(input); };
  const engine = new FollowUpEngine({ store, provider, clock: () => now,
    paymentChecker: overrides.paymentChecker || (async ({ invoice }) => ({ paidMinor: invoice.paidMinor })),
  });
  return { store, engine, sends: () => sends, setOwner: (patch) => { owner = { ...owner, ...patch }; } };
}

test('owner preferences normalize every server policy field and schedule in owner timezone', () => {
  const settings = normalizeFollowUpPreferences(prefs, 'UTC');
  assert.equal(settings.tone, 'firm');
  assert.equal(settings.maxReminders, 2);
  assert.equal(settings.dailySummary, true);
  assert.equal(settings.pauseOnReply, true);
  assert.equal(settings.stopOnPayment, true);
  assert.match(reminderBody({invoice_number:'INV-1'},settings),/arrange payment/i);
  assert.deepEqual(settings.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(scheduleInitialFollowUp({ due_date: '2026-09-25' }, settings, now).toISOString(), '2026-09-28T09:00:00.000Z');
  assert.equal(scheduleNextFollowUp(now, settings, 'UTC').toISOString(), '2026-09-24T09:00:00.000Z');
});

test('runtime resume schedules from owner firstReminderDays', async () => {
  const x = setup({ invoice: { followupState: 'paused', nextFollowUpAt: null }, preferences: { firstReminderDays: 7 } });
  const runtime = createAutomationRuntime({ store: x.store, provider: new MockWhatsAppProvider(),
    env: { WHATSAPP_PROVIDER: 'mock', NODE_ENV: 'test' }, clock: () => now });
  const result = await runtime.resume(scope);
  assert.equal(result.nextFollowUpAt, '2026-09-28T09:00:00.000Z');
  assert.equal(x.store.getInvoice(scope).nextFollowUpAt, result.nextFollowUpAt);
});

test('owner tone and cadence drive a mock reminder and its next schedule', async () => {
  const x = setup();
  assert.equal((await x.engine.run(scope)).status, 'sent');
  assert.equal(x.sends(), 1);
  const message = [...x.store.messages.values()][0];
  assert.match(message.payload.body, /arrange payment/i);
  assert.equal(x.store.getInvoice(scope).nextFollowUpAt, '2026-09-24T09:00:00.000Z');
});

test('owner allowed weekdays and contact window block a due invoice', async () => {
  const x = setup({ preferences: { allowedWeekdays: [1], contactStart: '12:00' } });
  const result = await x.engine.run(scope);
  assert.equal(result.reason, 'contact_hours');
  assert.equal(x.sends(), 0);
  assert.equal(x.store.getInvoice(scope).nextFollowUpAt, '2026-09-28T12:00:00.000Z');
});

test('owner max reminders escalates without another customer message', async () => {
  const x = setup({ invoice: { reminderCount: 2 } });
  assert.equal((await x.engine.run(scope)).status, 'needs_attention');
  assert.equal(x.sends(), 0);
  assert.equal(x.store.getInvoice(scope).followupState, 'paused');
});

test('preference change during accounting refresh blocks final send authorization', async () => {
  let x;
  x = setup({ paymentChecker: async ({ invoice }) => {
    x.setOwner({ follow_up_preferences: { ...prefs, contactStart: '12:00' }, updated_at: 'v2' });
    return { paidMinor: invoice.paidMinor };
  } });
  const result = await x.engine.run(scope);
  assert.equal(result.reason, 'preferences_changed');
  assert.equal(x.sends(), 0);
});

test('payment and customer reply stop or pause before another send', async () => {
  const payment = setup({ paymentChecker: async () => ({ paidMinor: 1000 }) });
  assert.equal((await payment.engine.run(scope)).reason, 'paid');
  assert.equal(payment.sends(), 0);
  const reply = setup();
  assert.equal((await reply.engine.processReply({ ...scope, from: '+919876543210', body: 'I already paid', messageId: 'reply-1' })).status, 'paused');
  assert.equal((await reply.engine.run(scope)).reason, 'paused');
  assert.equal(reply.sends(), 0);
});

test('ineligible public invoice direction, due date, and total fail closed', async () => {
  for (const invoice of [
    { metadata: { invoice_direction: 'payable' } },
    { metadata: { invoice_direction: 'uncertain' } },
    { metadata: { invoice_direction: null } },
    { due_date: null },
    { total_amount: '0.00' },
  ]) {
    const x = setup({ invoice });
    assert.equal((await x.engine.run(scope)).reason, 'ineligible_invoice');
    assert.equal(x.sends(), 0);
  }
});
