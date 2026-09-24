import {createHmac, timingSafeEqual} from 'node:crypto';
import {APIError, uuid} from './http.mjs';

const MAX_AGE_SECONDS = 10 * 60;
const ACTIONS = new Set(['create_invoice', 'update_invoice']);

function secretValue(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new APIError(503, 'ACCOUNTING_CONFIRMATION_UNAVAILABLE');
  return secret;
}

function sign(content, secret) {
  return createHmac('sha256', secretValue(secret)).update(content).digest();
}

export function createAccountingActionToken({action, payload, userId, workspaceId, secret, now = Date.now()} = {}) {
  if (!ACTIONS.has(action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new APIError(400, 'INVALID_ACCOUNTING_ACTION');
  const body = Buffer.from(JSON.stringify({v:1,action,payload,userId:uuid(userId),workspaceId:uuid(workspaceId),exp:Math.floor(now / 1000) + MAX_AGE_SECONDS})).toString('base64url');
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

export function verifyAccountingActionToken(token, {userId, workspaceId, secret, now = Date.now()} = {}) {
  if (typeof token !== 'string' || token.length > 16000 || token.split('.').length !== 2) throw new APIError(400, 'INVALID_ACCOUNTING_ACTION');
  const [body, encodedSignature] = token.split('.');
  const expected = sign(body, secret);
  let supplied;
  try { supplied = Buffer.from(encodedSignature, 'base64url'); } catch { throw new APIError(400, 'INVALID_ACCOUNTING_ACTION'); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new APIError(400, 'INVALID_ACCOUNTING_ACTION');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new APIError(400, 'INVALID_ACCOUNTING_ACTION'); }
  if (parsed?.v !== 1 || !ACTIONS.has(parsed.action) || parsed.userId !== uuid(userId) || parsed.workspaceId !== uuid(workspaceId)) throw new APIError(403, 'ACCOUNTING_ACTION_SCOPE_MISMATCH');
  if (!Number.isSafeInteger(parsed.exp) || parsed.exp <= Math.floor(now / 1000) || parsed.exp > Math.floor(now / 1000) + MAX_AGE_SECONDS + 5) throw new APIError(409, 'ACCOUNTING_ACTION_EXPIRED');
  return Object.freeze({action:parsed.action,payload:parsed.payload});
}
