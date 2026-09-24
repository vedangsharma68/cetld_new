import { randomBytes } from 'node:crypto';
import { authorizeWorkspace, bodyOf, HttpError, required, respondError } from './http.mjs';

const providers = new Set(['zoho_books', 'quickbooks']);
function cookieName(provider) { return `__Host-cetld-accounting-${provider}`; }
function cookieValue(request, name) {
  return String(request.headers?.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function redirectUri(env, provider) {
  const configured = required(env, provider === 'zoho_books' ? 'ZOHO_BOOKS_REDIRECT_URI' : 'QUICKBOOKS_REDIRECT_URI');
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(503, 'OAuth callback must use HTTPS');
  return configured;
}
export async function handleAccountingRequest(request, response, dependencies = {}) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const env = dependencies.env || process.env;
    const url = new URL(request.url, 'https://cetld.invalid');
    const input = request.method === 'POST' ? bodyOf(request) : Object.fromEntries(url.searchParams);
    const provider = input.provider;
    if (!providers.has(provider)) throw new HttpError(400, 'Unsupported accounting provider');
    const getIntegration = async () => dependencies.integration || await import('./runtime.mjs').then(module => module.createAccountingRuntime({ env }));
    if (request.method === 'GET') {
      const browserSession = cookieValue(request, cookieName(provider));
      if (!browserSession) throw new HttpError(401, 'Restart the accounting connection in this browser');
      const integration = await getIntegration();
      const result = await integration.callback({ provider, state: input.state, code: input.code, error: input.error, realmId: input.realmId, browserSession, redirectUri: redirectUri(env, provider) });
      response.setHeader('Set-Cookie', `${cookieName(provider)}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      return response.status(200).json({ connected: true, provider: result.provider, workspaceId: result.workspaceId });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'GET or POST required');
    const identity = await authorizeWorkspace(request, input.workspaceId, env, dependencies.fetchImpl);
    if (input.action === 'start') {
      const integration = await getIntegration();
      const browserSession = randomBytes(32).toString('base64url');
      const result = await integration.startOAuth({ ...identity, provider, browserSession, organizationId: input.organizationId, redirectUri: redirectUri(env, provider), region: env.ZOHO_BOOKS_REGION || 'com' });
      response.setHeader('Set-Cookie', `${cookieName(provider)}=${browserSession}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      return response.status(200).json({ authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt });
    }
    if (input.action === 'sync') { const integration = await getIntegration(); return response.status(200).json(await integration.sync({ ...identity, provider, invoicePage:input.invoicePage ?? 1, paymentPage:input.paymentPage ?? 1 })); }
    throw new HttpError(400, 'Unknown accounting action');
  } catch (error) { return respondError(response, error); }
}
