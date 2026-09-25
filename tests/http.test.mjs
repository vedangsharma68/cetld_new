import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeWorkspace, authorizeWorker, bodyOf } from '../automation/http.mjs';
const workspaceId = '00000000-0000-0000-0000-000000000001';
const userId = '00000000-0000-0000-0000-000000000002';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'server-only', AUTOMATION_WORKER_SECRET: 'x'.repeat(32) };
test('worker authorization fails closed', () => {
  assert.throws(() => authorizeWorker({ headers: {} }, env));
  authorizeWorker({ headers: { authorization: `Bearer ${env.AUTOMATION_WORKER_SECRET}` } }, env);
  assert.throws(() => authorizeWorker({ headers: {} }, {}));
});
test('workspace ownership is verified beyond authentication', async () => {
  let call = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => ++call === 1 ? { id: userId } : [{ id: workspaceId, owner_id: 'other-user' }] });
  await assert.rejects(authorizeWorkspace({ headers: { authorization: 'Bearer valid' } }, workspaceId, env, fetchImpl), /Workspace unavailable/);
});
test('valid workspace retains user bearer on server verification', async () => {
  let call = 0;
  const fetchImpl = async (url, options) => { assert.equal(options.headers.Authorization, 'Bearer valid'); return { ok: true, json: async () => ++call === 1 ? { id: userId } : [{ id: workspaceId, owner_id: userId }] }; };
  assert.equal((await authorizeWorkspace({ headers: { authorization: 'Bearer valid' } }, workspaceId, env, fetchImpl)).ownerId, userId);
});
test('request body validation rejects oversized/malformed input', () => {
  assert.throws(() => bodyOf({ body: '{' }));
  assert.throws(() => bodyOf({ body: { text: 'a'.repeat(40000) } }));
  assert.throws(() => bodyOf({ body: [] }));
});
