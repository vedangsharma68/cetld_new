import { config as appConfig } from '../config.js';
import { authorizeWorkspace, bodyOf, HttpError, required, uuid } from './http.mjs';
import { SupabaseAccountingStore } from './accounting/store.mjs';
import { createAccountingIntegration, sameAccountingConnection } from './accounting/integration.mjs';
import { TokenCipher, encryptionKeyFromEnv } from './accounting/crypto.mjs';
import { createAccountingProviders } from './accounting/providers.mjs';
import { AccountingProviderError } from './accounting/errors.mjs';

export const INVOICE_CLEANUP_TIMEOUT_MS = 8000;
export const INVOICE_CLEANUP_ACTION = 'invoice-cleanup';

// A local invoice selector reserves the envelope even with a forged action.
// Query selectors also reserve it so they cannot reach OAuth callbacks. This
// classifier performs no auth, provider, integration or other external work.
export function isInvoiceCleanupRequest(request) {
  const cleanupAction = value => value === INVOICE_CLEANUP_ACTION
    || Array.isArray(value) && value.includes(INVOICE_CLEANUP_ACTION);
  const reserved = value => value && typeof value === 'object'
    && (Object.hasOwn(value, 'invoiceId') || cleanupAction(value.action));
  let body = request.body;
  // OAuth callbacks have no request body. Never reinterpret a malformed/non-POST
  // cleanup body as a callback solely because parsing its selector failed.
  if (request.method !== 'POST' && (typeof body === 'string' ? body.length > 0
    : body && typeof body === 'object' && Object.keys(body).length > 0)) return true;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > 32768) return true; // Rejected by bodyOf before work.
    try { body = JSON.parse(body); } catch {
      if (/"invoiceId"\s*:|"action"\s*:\s*"invoice-cleanup"/.test(body)) return true;
      body = null;
    }
  }
  if (reserved(body) || reserved(request.query)) return true;
  try {
    const query = new URL(request.url, 'https://cetld.invalid').searchParams;
    return query.has('invoiceId') || query.getAll('action').some(cleanupAction);
  } catch { return false; }
}
const allowedInvoices = Object.freeze({
  '27e4bc93-fa0c-42ff-8813-bc371a623fb0': '4264719000000068001',
  '5076cb85-c892-44d6-aea9-9b7af8e95d38': '4264719000000044008',
});
const numericId = value => typeof value === 'string' && /^[0-9]{1,40}$/.test(value);
const regions = new Set(['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'com.cn', 'sa']);
const linkageKeys = ['id', 'workspace_id', 'external_provider', 'external_invoice_id', 'updated_at', 'deleted_at',
  'accounting_provider', 'bookkeeping_provider', 'bookkeeping_record_id'];
const sameInvoice = (a, b) => Boolean(a && b && linkageKeys.every(key => a[key] === b[key]));
class Unavailable extends Error {
  constructor(reason) { super('Invoice cleanup unavailable'); this.reason = reason; }
}
const unavailable = reason => { throw new Unavailable(reason); };

// Deliberately separate from /api/accounting's action dispatcher and assistant
// runtime. No caller-selected provider, external invoice, organization or user.
export async function handleInvoiceCleanup(request, response, dependencies = {}) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  let controller, timer, input, validated = false;
  const result = (outcome, facts = {}) => ({ workspaceId: input.workspaceId, invoiceId: input.invoiceId,
    provenance: 'provenance_unverified', checkedAt: new Date().toISOString(), outcome, ...facts });
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'POST required');
    input = bodyOf(request);
    if (new URL(request.url, 'https://cetld.invalid').search || Object.keys(request.query || {}).length
      || Object.keys(input).sort().join(',') !== 'action,invoiceId,workspaceId'
      || input.action !== INVOICE_CLEANUP_ACTION) throw new HttpError(400, 'Invalid request');
    uuid(input.invoiceId); uuid(input.workspaceId);
    validated = true;
    controller = new AbortController();
    const signal = controller.signal;
    const fetchImpl = dependencies.fetchImpl || fetch;
    // This wrapper also covers auth, store calls and token preparation.
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
        serviceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'), fetchImpl: (url, options = {}) => {
          // The shared refresh machinery claims a durable lease before refreshing.
          // Cleanup has zero local write authority, including connection metadata.
          // Fail closed before that first write; keep the existing token/CAS checks.
          if ((options.method || 'GET') !== 'GET') unavailable('token_refresh_required');
          return boundedFetch(url, options);
        } });
      const saved = await store.getDiagnosticInvoice(context, input.invoiceId);
      if (!saved || saved.id !== input.invoiceId || saved.workspace_id !== context.workspaceId) throw new HttpError(404, 'Invoice unavailable');
      const provider = saved.external_provider, exactId = saved.external_invoice_id;
      if (!Object.hasOwn(allowedInvoices, input.invoiceId)
        || exactId !== allowedInvoices[input.invoiceId] || provider !== 'zoho_books') unavailable('invoice_not_allowlisted');
      if ([saved.accounting_provider, saved.bookkeeping_provider].some(marker => marker != null && marker !== provider)
        || saved.bookkeeping_record_id != null && saved.bookkeeping_record_id !== exactId) unavailable('linkage_invalid');
      const identity = { userId: context.userId, workspaceId: context.workspaceId, provider };
      const connection = await store.getConnection(identity);
      if (!connection || connection.status !== 'connected') unavailable('not_connected');
      if (connection.userId !== identity.userId || connection.workspaceId !== identity.workspaceId
        || connection.provider !== provider || !numericId(connection.providerAccountId)) unavailable('connection_invalid');
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
      // Repeat the diagnostic's owner, connection and saved-row checks around
      // each remote operation. A revision change also detects away-and-back switches.
      const revalidate = async () => {
        signal.throwIfAborted();
        if (!sameAccountingConnection(active, await store.getConnection(identity))) unavailable('connection_changed');
        if (!sameInvoice(saved, await store.getDiagnosticInvoice(context, input.invoiceId))) unavailable('local_record_changed');
        const reauthorized = await authorizeWorkspace(request, input.workspaceId, env, boundedFetch);
        if (reauthorized.userId !== context.userId || reauthorized.workspaceId !== context.workspaceId) unavailable('connection_changed');
        if (!sameAccountingConnection(active, await store.getConnection(identity))) unavailable('connection_changed');
        if (!sameInvoice(saved, await store.getDiagnosticInvoice(context, input.invoiceId))) unavailable('local_record_changed');
        signal.throwIfAborted();
      };
      const facts = { provider, currentAccountId: active.providerAccountId, exactId };
      const read = () => providers.zoho_books.fetchInvoiceBalance({ token, accountId: active.providerAccountId,
        invoiceId: exactId, signal, retryReads: false, diagnostic: true });
      let remote, failure;
      try { remote = await read(); } catch (error) { failure = error; }
      await revalidate();
      if (failure) {
        const status = failure instanceof AccountingProviderError ? failure.status : null;
        if (status === 404) return result('already_absent', facts);
        const reason = status === 401 ? 'provider_authentication_failed' : status === 403 ? 'provider_access_denied'
          : status === 429 ? 'provider_throttled' : 'provider_read_unverifiable';
        return result('unverifiable', { ...facts, reason });
      }
      if (remote.status !== 'draft') return result('skipped', { ...facts, reason: 'not_draft' });
      if (remote.balanceMinor !== remote.totalMinor || remote.paidMinor !== null && remote.paidMinor !== 0)
        return result('skipped', { ...facts, reason: 'paid_or_partially_paid' });
      // Only this single exact-ID write is permitted, after all preconditions.
      let deleteConfirmed = false;
      try {
        await providers.zoho_books.deleteInvoiceDraft({ token, accountId: active.providerAccountId, invoiceId: exactId, signal });
        deleteConfirmed = true;
      } catch { /* An uncertain DELETE is never retried; still attempt the exact post-read. */ }
      await revalidate();
      let absent = false;
      try { await read(); } catch (error) { absent = error instanceof AccountingProviderError && error.status === 404; }
      await revalidate();
      return result(deleteConfirmed ? 'deleted' : 'unverifiable', { ...facts,
        ...(!deleteConfirmed ? { reason: 'provider_delete_unverifiable' } : {}),
        verification: absent ? 'absent_confirmed' : 'absence_unverifiable' });
    };
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(result('unverifiable', { reason: 'timeout' })); },
        Math.min(INVOICE_CLEANUP_TIMEOUT_MS, Math.max(1, dependencies.timeoutMs || INVOICE_CLEANUP_TIMEOUT_MS)));
    });
    return response.status(200).json(await Promise.race([work(), deadline]));
  } catch (error) {
    if (!validated && !(error instanceof HttpError)) return response.status(400).json({ error: 'invalid_request' });
    if (error instanceof HttpError) return response.status(error.status).json({ error: error.status === 401 ? 'authentication_required'
      : error.status === 403 ? 'workspace_unavailable' : error.status === 404 ? 'invoice_unavailable'
      : error.status === 405 ? 'post_required' : error.status < 500 ? 'invalid_request' : 'cleanup_unavailable' });
    const reason = controller?.signal.aborted ? 'timeout' : error instanceof Unavailable ? error.reason
      : error?.code === 'ACCOUNTING_CONNECTION_CONFLICT' ? 'connection_changed' : 'cleanup_unavailable';
    return response.status(200).json(result('unverifiable', { reason }));
  } finally {
    clearTimeout(timer);
    controller?.abort();
  }
}
