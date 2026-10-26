import { config as appConfig } from '../config.js';
import { authorizeWorkspace, bodyOf, HttpError, required, uuid } from './http.mjs';
import { SupabaseAccountingStore } from './accounting/store.mjs';
import { createAccountingIntegration, sameAccountingConnection } from './accounting/integration.mjs';
import { TokenCipher, encryptionKeyFromEnv } from './accounting/crypto.mjs';
import { createAccountingProviders } from './accounting/providers.mjs';
import { AccountingProviderError } from './accounting/errors.mjs';

export const INVOICE_DIAGNOSTIC_TIMEOUT_MS = 5000;
const numericId = value => typeof value === 'string' && /^[0-9]{1,40}$/.test(value);
const regions = new Set(['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'com.cn', 'sa']);
const linkageKeys = ['id', 'workspace_id', 'external_provider', 'external_invoice_id', 'updated_at', 'deleted_at',
  'accounting_provider', 'bookkeeping_provider', 'bookkeeping_record_id'];
const sameInvoice = (a, b) => Boolean(a && b && linkageKeys.every(key => a[key] === b[key]));
class Unavailable extends Error {
  constructor(reason) { super('Invoice diagnostic unavailable'); this.reason = reason; }
}
const unavailable = reason => { throw new Unavailable(reason); };

// Deliberately separate from /api/accounting's action dispatcher and assistant
// runtime. No caller-selected provider, external invoice, organization or user.
export async function handleInvoiceDiagnostic(request, response, dependencies = {}) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  let controller, timer, input;
  const result = (existence, facts = {}) => ({ workspaceId: input.workspaceId, invoiceId: input.invoiceId,
    provenance: 'provenance_unverified', checkedAt: new Date().toISOString(), existence, ...facts });
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'POST required');
    input = bodyOf(request);
    if (new URL(request.url, 'https://cetld.invalid').search
      || Object.keys(input).sort().join(',') !== 'invoiceId,workspaceId') throw new HttpError(400, 'Invalid request');
    uuid(input.invoiceId); uuid(input.workspaceId);
    controller = new AbortController();
    const signal = controller.signal;
    const fetchImpl = dependencies.fetchImpl || fetch;
    // This wrapper also covers auth, store calls and ordinary token refresh.
    // Late continuations cannot initiate another request after the deadline.
    const boundedFetch = (url, options = {}) => {
      signal.throwIfAborted();
      return fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
    };
    const work = async () => {
      const env = dependencies.env || process.env;
      const context = await authorizeWorkspace(request, input.workspaceId, env, boundedFetch);
      signal.throwIfAborted();
      const store = new SupabaseAccountingStore({ url: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || appConfig.url,
        serviceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'), fetchImpl: boundedFetch });
      const saved = await store.getDiagnosticInvoice(context, input.invoiceId);
      if (!saved || saved.id !== input.invoiceId || saved.workspace_id !== context.workspaceId) throw new HttpError(404, 'Invoice unavailable');
      const provider = saved.external_provider, exactId = saved.external_invoice_id;
      if (!provider || !exactId) unavailable('invoice_unlinked');
      if (!['zoho_books', 'quickbooks'].includes(provider)) unavailable('provider_unsupported');
      if (!numericId(exactId)
        || [saved.accounting_provider, saved.bookkeeping_provider].some(marker => marker != null && marker !== provider)
        || saved.bookkeeping_record_id != null && saved.bookkeeping_record_id !== exactId) unavailable('linkage_invalid');
      const identity = { userId: context.userId, workspaceId: context.workspaceId, provider };
      const connection = await store.getConnection(identity);
      if (!connection || connection.status !== 'connected') unavailable('not_connected');
      if (connection.userId !== identity.userId || connection.workspaceId !== identity.workspaceId
        || connection.provider !== provider || !numericId(connection.providerAccountId)) unavailable('connection_invalid');
      // QuickBooks has no verified diagnostic contract here. Tally never reaches
      // connection/token work. Neither integration is simulated as available.
      if (provider !== 'zoho_books') unavailable('provider_unsupported');
      if (!regions.has(connection.region)
        || connection.apiDomain !== `https://www.zohoapis.${connection.region}`
        || connection.accountsDomain !== `https://accounts.zoho.${connection.region}`) unavailable('connection_invalid');
      const providers = createAccountingProviders({ zoho_books: { clientId: env.ZOHO_BOOKS_CLIENT_ID,
        clientSecret: env.ZOHO_BOOKS_CLIENT_SECRET, fetchImpl: boundedFetch } });
      const integration = createAccountingIntegration({ store, providers,
        cipher: new TokenCipher(encryptionKeyFromEnv(env.ACCOUNTING_TOKEN_ENCRYPTION_KEY)) });
      const { token, connection: active } = await integration.accessToken(identity, { signal, expectedConnection: connection });
      if (active.status !== 'connected' || active.providerAccountId !== connection.providerAccountId
        || active.region !== connection.region || active.apiDomain !== connection.apiDomain
        || active.accountsDomain !== connection.accountsDomain || token.apiDomain !== active.apiDomain
        || token.region !== active.region || token.accountsDomain !== active.accountsDomain
        || token.providerAccountId && token.providerAccountId !== active.providerAccountId) unavailable('connection_changed');
      if (!sameAccountingConnection(active, await store.getConnection(identity))) unavailable('connection_changed');
      if (!sameInvoice(saved, await store.getDiagnosticInvoice(context, input.invoiceId))) unavailable('local_record_changed');
      // Current-account scope only: this is not evidence of original linkage,
      // an export destination, or authority to remind, queue or send.
      let remote, failure;
      try {
        remote = await providers.zoho_books.fetchInvoiceBalance({ token, accountId: active.providerAccountId,
          invoiceId: exactId, signal, retryReads: false, diagnostic: true });
      } catch (error) { failure = error; }
      signal.throwIfAborted();
      if (!sameAccountingConnection(active, await store.getConnection(identity))) unavailable('connection_changed');
      if (!sameInvoice(saved, await store.getDiagnosticInvoice(context, input.invoiceId))) unavailable('local_record_changed');
      const reauthorized = await authorizeWorkspace(request, input.workspaceId, env, boundedFetch);
      if (reauthorized.userId !== context.userId || reauthorized.workspaceId !== context.workspaceId) unavailable('connection_changed');
      if (!sameAccountingConnection(active, await store.getConnection(identity))) unavailable('connection_changed');
      if (!sameInvoice(saved, await store.getDiagnosticInvoice(context, input.invoiceId))) unavailable('local_record_changed');
      signal.throwIfAborted();
      const facts = { provider, currentAccountId: active.providerAccountId, exactId };
      if (failure) {
        // No verified Zoho exact-resource absence contract is asserted. In
        // particular, both 403 and 404 remain unverifiable, regardless of text/code.
        const status = failure instanceof AccountingProviderError ? failure.status : null;
        const reason = status === 401 ? 'provider_authentication_failed' : status === 403 ? 'provider_access_denied'
          : status === 429 ? 'provider_throttled' : status === 404 ? 'provider_absence_unverifiable' : 'provider_read_unverifiable';
        return result('unverifiable', { ...facts, reason });
      }
      return result('present', { ...facts, status: remote.status, currency: remote.currency,
        totalMinor: remote.totalMinor, balanceMinor: remote.balanceMinor, paidMinor: remote.paidMinor });
    };
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(result('unverifiable', { reason: 'timeout' })); },
        Math.min(INVOICE_DIAGNOSTIC_TIMEOUT_MS, Math.max(1, dependencies.timeoutMs || INVOICE_DIAGNOSTIC_TIMEOUT_MS)));
    });
    return response.status(200).json(await Promise.race([work(), deadline]));
  } catch (error) {
    if (error instanceof HttpError) return response.status(error.status).json({ error: error.status === 401 ? 'authentication_required'
      : error.status === 403 ? 'workspace_unavailable' : error.status === 404 ? 'invoice_unavailable'
      : error.status === 405 ? 'post_required' : error.status < 500 ? 'invalid_request' : 'diagnostic_unavailable' });
    const reason = controller?.signal.aborted ? 'timeout' : error instanceof Unavailable ? error.reason
      : error?.code === 'ACCOUNTING_CONNECTION_CONFLICT' ? 'connection_changed' : 'diagnostic_unavailable';
    return response.status(200).json(result('unverifiable', { reason }));
  } finally {
    clearTimeout(timer);
    controller?.abort();
  }
}
