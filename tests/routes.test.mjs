import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAutomationRequest } from '../automation/routes.mjs';
const workspaceId = '00000000-0000-0000-0000-000000000001';
const ownerId = '00000000-0000-0000-0000-000000000002';
function response() { return { code: null, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return this; } }; }
test('unauthenticated tick never executes runtime', async () => {
  let called = false; const res = response();
  await handleAutomationRequest({ method: 'POST', headers: {}, body: { action: 'tick', workspaceId, ownerId } }, res, { env: { AUTOMATION_WORKER_SECRET: 'x'.repeat(32) }, runtime: { tick() { called = true; } } });
  assert.equal(res.code, 401); assert.equal(called, false);
});
test('authenticated tick preserves tenant scope', async () => {
  const res = response();
  await handleAutomationRequest({ method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(32)}` }, body: { action: 'tick', workspaceId, ownerId } }, res, { env: { AUTOMATION_WORKER_SECRET: 'x'.repeat(32) }, runtime: { async tick(scope) { assert.deepEqual(scope, { workspaceId, ownerId }); return { processed: 0 }; } } });
  assert.equal(res.code, 200); assert.equal(res.payload.processed, 0);
});
test('errors do not expose tokens/provider response payloads', async () => {
  const res = response();
  await handleAutomationRequest({ method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(32)}` }, body: { action: 'tick', workspaceId, ownerId } }, res, { env: { AUTOMATION_WORKER_SECRET: 'x'.repeat(32) }, runtime: { tick() { throw new Error('secret-access-token'); } } });
  assert.equal(res.code, 503); assert.ok(!JSON.stringify(res.payload).includes('secret-access-token'));
});
