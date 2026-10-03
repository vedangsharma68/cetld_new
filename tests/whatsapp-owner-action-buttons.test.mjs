import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerActionButtons, verifyOwnerActionButton} from '../automation/whatsapp/owner-action-buttons.mjs';

const env = { WHATSAPP_APP_SECRET: 'app-secret', CRON_SECRET: 'cron-secret' };
const scope = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', phone: '+919871367051' };
const clock = () => new Date('2026-10-03T12:00:00.000Z');
const action = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 4,
  action: { type: 'owner_invoice_update', proposalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    invoiceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', expectedUpdatedAt: '2026-10-03T11:45:00.000Z',
    changes: { total: 4200 }, expiresAt: '2026-10-03T12:10:00.000Z', requestedAt: '2026-10-03T11:59:00.000Z',
    sourceMessageId: 'wamid.source' },
};

test('owner action button helpers expose the agreed server-bound API', () => {
  assert.equal(typeof createOwnerActionButtons, 'function');
  assert.equal(typeof verifyOwnerActionButton, 'function');
});

test('owner action references are scoped to the exact phone, workspace, action version, and decision', () => {
  const buttons = createOwnerActionButtons({ scope, action, env, clock });
  assert.deepEqual(buttons.map(({ title }) => title), ['Confirm', 'Cancel']);
  assert.ok(buttons.every(({ id }) => Buffer.byteLength(id, 'utf8') <= 256));
  assert.deepEqual(buttons.map(({ id }) => verifyOwnerActionButton({ id, scope, action, env, clock })), [
    { decision: 'confirm', valid: true }, { decision: 'cancel', valid: true },
  ]);
  assert.deepEqual(verifyOwnerActionButton({ id: buttons[0].id,
    scope: { ...scope, workspaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, action, env, clock }), { decision: null, valid: false });
  assert.deepEqual(verifyOwnerActionButton({ id: buttons[0].id,
    scope: { ...scope, phone: '+919818685252' }, action, env, clock }), { decision: null, valid: false });
  assert.deepEqual(verifyOwnerActionButton({ id: buttons[0].id, scope,
    action: { ...action, version: action.version + 1 }, env, clock }), { decision: null, valid: false });
});

test('owner action references bind changed proposal data, expire with the proposal, and reject tampering', () => {
  const [confirm] = createOwnerActionButtons({ scope, action, env, clock });
  const changed = structuredClone(action);
  changed.action.changes.total = 4201;
  assert.deepEqual(verifyOwnerActionButton({ id: confirm.id, scope, action: changed, env, clock }),
    { decision: null, valid: false });
  const transportChanged = structuredClone(action);
  transportChanged.action.requestedAt = '2026-10-03T12:00:00.000Z';
  transportChanged.action.sourceMessageId = 'wamid.retry';
  assert.deepEqual(verifyOwnerActionButton({ id: confirm.id, scope, action: transportChanged, env, clock }),
    { decision: 'confirm', valid: true });
  assert.deepEqual(verifyOwnerActionButton({ id: `${confirm.id.slice(0, -1)}x`, scope, action, env, clock }),
    { decision: null, valid: false });
  assert.deepEqual(verifyOwnerActionButton({ id: confirm.id, scope, action, env,
    clock: () => new Date('2026-10-03T12:10:00.000Z') }), { decision: null, valid: false });
});

test('owner action buttons fail closed without scope, secret, or proposal expiry and accept safe server labels', () => {
  assert.deepEqual(createOwnerActionButtons({ scope, action,
    env: { WHATSAPP_APP_SECRET: '', CRON_SECRET: '' }, clock }), []);
  assert.deepEqual(createOwnerActionButtons({ scope: { ...scope, phone: 'not-a-phone' }, action, env, clock }), []);
  const noExpiry = structuredClone(action);
  delete noExpiry.action.expiresAt;
  assert.deepEqual(createOwnerActionButtons({ scope, action: noExpiry, env, clock }), []);
  const titled = createOwnerActionButtons({ scope, action, env, clock,
    confirmTitle: 'Delete', cancelTitle: 'Keep invoice' });
  assert.deepEqual(titled.map(({ title }) => title), ['Delete', 'Keep invoice']);
  assert.deepEqual(createOwnerActionButtons({ scope, action, env, clock, confirmTitle: 'A title that is much too long' }), []);
  const maxPhone = createOwnerActionButtons({ scope: {...scope,phone:'+123456789012345'}, action, env, clock });
  assert.ok(maxPhone.length === 2 && maxPhone.every(button => Buffer.byteLength(button.id,'utf8') <= 256));
});

test('owner buttons use the durable expires_at column and reject action types the SQL executor cannot handle', () => {
  const durableExpiry={...action,action:{...action.action}};
  delete durableExpiry.action.expiresAt;
  durableExpiry.expires_at='2026-10-03T12:10:00.000Z';
  const [confirm]=createOwnerActionButtons({scope,action:durableExpiry,env,clock});
  assert.equal(verifyOwnerActionButton({id:confirm.id,scope,action:durableExpiry,env,clock}).valid,true);

  const invoiceReview={...durableExpiry,action:{...durableExpiry.action,type:'invoice_review_draft',stage:'proposal'}};
  assert.deepEqual(createOwnerActionButtons({scope,action:invoiceReview,env,clock}),[]);
});
