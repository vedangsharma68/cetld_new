import { config as appConfig } from '../config.js';
import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function required(env, name) {
  if (!env[name]) throw new HttpError(503, 'Missing server configuration: ' + name);
  return env[name];
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, 'Invalid identifier');
  return value;
}
export function authorizeWorker(request, env) {
  const expected = required(env, 'AUTOMATION_WORKER_SECRET');
  if (expected.length < 32) throw new HttpError(503, 'Worker secret must contain at least 32 characters');
  const actual = String(request.headers?.authorization || '').replace(/^Bearer /, '');
  const a = Buffer.from(actual), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
}
export async function authorizeWorkspace(request, workspaceId, env, fetchImpl = fetch) {
  uuid(workspaceId);
  const token = request.headers?.authorization;
  if (typeof token !== 'string' || !token.startsWith('Bearer ') || token.length > 16384) throw new HttpError(401, 'Sign in required');
  const base = String(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || appConfig.url).replace(/\/$/, '');
  const configuredKey = env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
  const publicKey = configuredKey || (base === String(appConfig.url).replace(/\/$/, '') ? appConfig.key : null);
  if (!publicKey) throw new HttpError(503, 'Supabase authorization project is not configured');
  const headers = { apikey: publicKey, Authorization: token };
  const auth = await fetchImpl(base + '/auth/v1/user', { headers, signal: AbortSignal.timeout(10000) });
  if (!auth.ok) throw new HttpError(401, 'Sign in required');
  const user = await auth.json();
  uuid(user.id);
  const result = await fetchImpl(base + '/rest/v1/workspaces?id=eq.' + workspaceId + '&owner_id=eq.' + user.id + '&select=id,owner_id', { headers, signal: AbortSignal.timeout(10000) });
  if (!result.ok) throw new HttpError(403, 'Workspace unavailable');
  const rows = await result.json();
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].owner_id !== user.id || rows[0].id !== workspaceId) throw new HttpError(403, 'Workspace unavailable');
  return { userId: user.id, ownerId: user.id, workspaceId };
}
export function bodyOf(request) {
  let body = request.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > 32768) throw new HttpError(413, 'Request too large');
    try { body = JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  if (Buffer.byteLength(JSON.stringify(body)) > 32768) throw new HttpError(413, 'Request too large');
  return body;
}
export function respondError(response, error) {
  if (error instanceof HttpError) return response.status(error.status).json({ error: error.message });
  const code = String(error?.code || '');
  // Record only stable accounting error codes. Never log tokens, OAuth codes, or provider bodies.
  if (code.startsWith('ACCOUNTING_')) {
    console.error('Accounting request failed', { code, status: error?.status || 503 });
    if (code === 'ACCOUNTING_KEY_MISSING') {
      return response.status(503).json({ error: 'Missing server configuration: ACCOUNTING_TOKEN_ENCRYPTION_KEY' });
    }
    if (code === 'ACCOUNTING_KEY_INVALID') {
      return response.status(503).json({ error: 'ACCOUNTING_TOKEN_ENCRYPTION_KEY must be a base64 encoded 32-byte key' });
    }
    if (code === 'ACCOUNTING_STORE_ERROR') {
      return response.status(503).json({ error: 'Zoho connection storage failed. Verify the server-side Supabase configuration and integration migration.' });
    }
    if (code === 'ACCOUNTING_PROVIDER_ERROR') {
      return response.status(502).json({ error: 'Zoho authorization provider rejected the request. Verify the Zoho app credentials and callback URL.' });
    }
    if (code === 'ACCOUNTING_ZOHO_CLIENT_ID_MISSING') {
      return response.status(503).json({ error: 'Missing server configuration: ZOHO_BOOKS_CLIENT_ID' });
    }
    if (code === 'ACCOUNTING_ZOHO_CLIENT_SECRET_MISSING') {
      return response.status(503).json({ error: 'Missing server configuration: ZOHO_BOOKS_CLIENT_SECRET' });
    }
    if (code === 'ACCOUNTING_ZOHO_REDIRECT_URI_MISSING') {
      return response.status(503).json({ error: 'Missing server configuration: ZOHO_BOOKS_REDIRECT_URI' });
    }
    return response.status(503).json({ error: 'Zoho connection failed (' + code + '). Check the Vercel function logs for this error code.' });
  }
  console.error('Automation request failed', { name: String(error?.name || 'Error') });
  return response.status(503).json({ error: 'Operation unavailable; no automatic retry of uncertain sends.' });
}
