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
function callbackOrigin(env, provider) {
  try { return new URL(redirectUri(env, provider)).origin; } catch { return null; }
}
function callbackPage(response, { provider = 'zoho_books', origin, status, organizations = [], organizationId = null, syncStatus = null, message = null, failed = false }) {
  const returnPath = '/?page=Connections';
  const payload = Buffer.from(JSON.stringify({ type: provider === 'zoho_books' ? 'cetld:zoho-oauth' : `cetld:${provider}-oauth`, provider, status, organizations, organizationId, syncStatus, message }), 'utf8').toString('base64url');
  const targetOrigin = Buffer.from(String(origin || ''), 'utf8').toString('base64url');
  const title = failed ? 'Could not connect Zoho Books' : status === 'needs_organization' ? 'Choose your Zoho organization' : status === 'connected' ? 'Zoho Books connected' : 'Zoho connection needs attention';
  const description = failed ? 'We could not finish connecting Zoho Books. Return to cetld and try again.' : status === 'needs_organization' ? 'Your Zoho account has more than one organization. Choose one in cetld to finish setup.' : status === 'connected' ? 'Your Zoho Books organization is connected. You can return to cetld.' : 'Zoho authorization finished, but cetld could not verify a usable organization. Return to cetld to review the connection.';
  const autoClose = status === 'connected';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><link rel="stylesheet" href="/oauth-callback.css"><script src="/oauth-callback.js" defer></script></head><body><main id="oauth-result" class="card" data-payload="${payload}" data-origin="${targetOrigin}" data-auto-close="${autoClose ? 'true' : 'false'}"><h1>${title}</h1><p>${description}</p><a href="${returnPath}">Return to cetld</a></main></body></html>`;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (typeof response.send === 'function') return response.status(failed ? 400 : 200).send(html);
  return response.status(failed ? 400 : 200).json({ html });
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
      const result = await integration.callback({ provider, state: input.state, code: input.code, error: input.error, realmId: input.realmId, location: input.location, browserSession, redirectUri: redirectUri(env, provider) });
      response.setHeader('Set-Cookie', `${cookieName(provider)}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      if (provider !== 'zoho_books') return response.status(200).json({ connected: true, provider: result.provider, workspaceId: result.workspaceId });
      let syncStatus = null;
      if (result.status === 'connected') {
        try { await integration.sync({ userId: result.userId, workspaceId: result.workspaceId, provider }); syncStatus = 'synced'; }
        catch { syncStatus = 'failed'; }
      }
      return callbackPage(response, { provider, origin: callbackOrigin(env, provider), status: result.status || (result.providerAccountId ? 'connected' : 'needs_attention'), organizations: (result.organizations || []).map(({id, name}) => ({id, name})), organizationId: result.providerAccountId || null, syncStatus, message: syncStatus === 'failed' ? 'Zoho Books is connected, but the first sync did not finish. Use Sync now to retry.' : null });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'GET or POST required');
    const identity = await authorizeWorkspace(request, input.workspaceId, env, dependencies.fetchImpl);
    const integration = await getIntegration();
    if (input.action === 'status') return response.status(200).json(await integration.connectionStatus({ ...identity, provider }));
    if (input.action === 'select-organization') {
      if (provider !== 'zoho_books') throw new HttpError(400, 'Organization selection is only supported for Zoho Books');
      const result = await integration.selectOrganization({ ...identity, provider, organizationId: input.organizationId });
      try { result.sync = await integration.sync({ ...identity, provider }); result.syncStatus = 'synced'; }
      catch { result.syncStatus = 'failed'; }
      return response.status(200).json(result);
    }
    if (input.action === 'disconnect') return response.status(200).json(await integration.disconnect({ ...identity, provider }));
    if (input.action === 'start') {
      const browserSession = randomBytes(32).toString('base64url');
      const result = await integration.startOAuth({ ...identity, provider, browserSession, organizationId: input.organizationId, redirectUri: redirectUri(env, provider), region: env.ZOHO_BOOKS_REGION || 'com' });
      response.setHeader('Set-Cookie', `${cookieName(provider)}=${browserSession}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      return response.status(200).json({ authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt });
    }
    if (input.action === 'sync') { const integration = await getIntegration(); return response.status(200).json(await integration.sync({ ...identity, provider, invoicePage:input.invoicePage ?? 1, paymentPage:input.paymentPage ?? 1 })); }
    throw new HttpError(400, 'Unknown accounting action');
  } catch (error) {
    if (request.method === 'GET' && new URL(request.url, 'https://cetld.invalid').searchParams.get('provider') === 'zoho_books') {
      response.setHeader('Set-Cookie', `${cookieName('zoho_books')}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      const status = error?.code === 'ACCOUNTING_OAUTH_DENIED' ? 'not_connected' : 'needs_attention';
      const message = error?.code === 'ACCOUNTING_OAUTH_DENIED' ? 'Zoho authorization was cancelled.' : 'Zoho could not complete the connection. Restart the connection from cetld.';
      return callbackPage(response, { origin: callbackOrigin(dependencies.env || process.env, 'zoho_books'), status, message, failed: true });
    }
    return respondError(response, error);
  }
}
