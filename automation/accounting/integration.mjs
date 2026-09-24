import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { TokenCipher, connectionAad } from './crypto.mjs';
import { AccountingError, redactedError } from './errors.mjs';
import { ACCOUNTING_PROVIDERS, createAccountingProviders } from './providers.mjs';

const DEFAULT_STATE_TTL = 10 * 60 * 1000;
const EXPIRY_SKEW = 60 * 1000;

function hashState(state) {
  return createHash('sha256').update(state).digest('hex');
}

function equalText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateIdentity({ userId, workspaceId, provider }) {
  if (!userId || !workspaceId) throw new AccountingError('ACCOUNTING_CONTEXT_REQUIRED', 'Verified user and workspace are required');
  if (!ACCOUNTING_PROVIDERS.includes(provider)) throw new AccountingError('ACCOUNTING_PROVIDER_UNSUPPORTED', 'Accounting provider is unsupported');
}

function identity({ userId, workspaceId, provider }) {
  validateIdentity({ userId, workspaceId, provider });
  return { userId: String(userId), workspaceId: String(workspaceId), provider };
}

function tokenEnvelope(tokenCipher, token, provider, workspaceId) {
  return tokenCipher.encrypt(token, connectionAad(provider, workspaceId));
}

export function createAccountingIntegration({ store, cipher = new TokenCipher(), providers = createAccountingProviders(), now = () => Date.now(), stateTtlMs = DEFAULT_STATE_TTL, randomState = () => randomBytes(32).toString('base64url'), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), refreshLeaseMs = 30000 } = {}) {
  if (!store) throw new TypeError('createAccountingIntegration requires a durable accounting store');
  for (const provider of ACCOUNTING_PROVIDERS) if (!providers[provider]) throw new TypeError(`Missing provider adapter: ${provider}`);

  async function startOAuth({ userId, workspaceId, provider, redirectUri, region, providerAccountId, organizationId, browserSession } = {}) {
    const context = identity({ userId, workspaceId, provider });
    if (!redirectUri) throw new AccountingError('ACCOUNTING_REDIRECT_REQUIRED', 'OAuth redirect URI is required');
    const state = randomState();
    const browserNonce = browserSession || randomState();
    const expiresAt = now() + stateTtlMs;
    const authorizationUrl = providers[provider].authorizationUrl({ state, redirectUri, region });
    await store.putOAuthState({ stateHash: hashState(state), userId: context.userId, workspaceId: context.workspaceId, provider, redirectUri, region: region || null, providerAccountId: providerAccountId || organizationId || null, browserNonceHash: hashState(browserNonce), expiresAt, usedAt: null });
    // The caller should set browserNonce in a Secure, HttpOnly, SameSite=Lax
    // cookie. The callback accepts it as proof that the browser started this flow.
    return { authorizationUrl, state, browserNonce, expiresAt };
  }

  async function callback({ provider, state, code, redirectUri, userId, workspaceId, browserNonce, browserSession, providerAccountId, accountId, realmId, error } = {}) {
    if (error) throw new AccountingError('ACCOUNTING_OAUTH_DENIED', 'Accounting authorization was denied');
    if (!state || !code) throw new AccountingError('ACCOUNTING_OAUTH_INVALID', 'Accounting authorization callback is invalid');
    const record = await store.consumeOAuthState(hashState(state), now());
    if (!record || record.provider !== provider) throw new AccountingError('ACCOUNTING_OAUTH_STATE_INVALID', 'Accounting authorization state is invalid or expired');
    if (redirectUri && !equalText(redirectUri, record.redirectUri)) throw new AccountingError('ACCOUNTING_OAUTH_STATE_INVALID', 'Accounting authorization state is invalid or expired');
    browserNonce = browserNonce || browserSession;
    if (!browserNonce || !record.browserNonceHash || !equalText(hashState(browserNonce), record.browserNonceHash)) throw new AccountingError('ACCOUNTING_OAUTH_STATE_INVALID', 'Accounting authorization state is invalid or expired');
    // Browser callbacks may not carry a bearer token. When supplied, the caller's
    // verified session still has to match the state-bound identity.
    if ((userId && !equalText(userId, record.userId)) || (workspaceId && !equalText(workspaceId, record.workspaceId))) throw new AccountingError('ACCOUNTING_OAUTH_STATE_INVALID', 'Accounting authorization state is invalid or expired');
    const token = await providers[provider].exchangeCode({ code, redirectUri: record.redirectUri, region: record.region });
    if (!token.accessToken || !token.refreshToken) throw new AccountingError('ACCOUNTING_TOKEN_INVALID', 'Accounting provider did not return required credentials');
    let organizations = [];
    if (provider === 'zoho_books' && typeof providers[provider].fetchOrganizations === 'function') {
      organizations = await providers[provider].fetchOrganizations({ token });
    }
    const chosenOrganization = organizations.length === 1 ? organizations[0] : null;
    const encrypted = tokenEnvelope(cipher, token, provider, record.workspaceId);
    // Zoho organization IDs must be selected from the authenticated user's organization
    // list. Never trust an ID supplied by the browser/callback query as a substitute.
    const selectedAccountId = provider === 'zoho_books'
      ? chosenOrganization?.id || null
      : token.providerAccountId || providerAccountId || accountId || realmId || record.providerAccountId || null;
    const connectionStatus = selectedAccountId && token.refreshToken && token.apiDomain ? 'connected' : provider === 'zoho_books' && organizations.length > 1 ? 'needs_organization' : 'needs_attention';
    const connection = { userId: record.userId, workspaceId: record.workspaceId, provider, providerAccountId: selectedAccountId, organizationName: chosenOrganization?.name || null, region: token.region || record.region || null, accountsDomain: token.accountsDomain || null, apiDomain: token.apiDomain || null, status: connectionStatus, lastSyncStatus: 'never', ...encrypted, tokenExpiresAt: token.expiresAt };
    const existing = await store.getConnection(connection);
    if (existing) {
      // Re-consent is an intentional replacement. A new revision invalidates an
      // in-flight refresh rather than allowing stale credentials to win.
      // Stores expose insert/update for refresh CAS; replacing through an optional
      // upsert keeps the durable implementation free to use a unique constraint.
      if (store.replaceConnection) await store.replaceConnection(connection, existing.revision);
      else if (store.updateConnection) throw new AccountingError('ACCOUNTING_CONNECTION_CONFLICT', 'Accounting connection replacement is unavailable');
    } else {
      await store.insertConnection(connection);
    }
    return { provider, userId: record.userId, workspaceId: record.workspaceId, providerAccountId: connection.providerAccountId, organization: chosenOrganization, organizations, status: connection.status };
  }

  async function connectionStatus({ userId, workspaceId, provider } = {}) {
    const context = identity({ userId, workspaceId, provider });
    let connection = await store.getConnection(context);
    if (!connection) return { provider, status: 'not_connected', organizationId: null, organizationName: null, organizations: [] };
    try {
      const refreshed = await withProviderRetry(context, ({token}) => typeof providers[provider].fetchOrganizations === 'function'
        ? providers[provider].fetchOrganizations({ token })
        : []);
      connection = refreshed.connection;
      const organizations = refreshed.result;
      let selected = organizations.find(item => item.id === connection.providerAccountId) || null;
      if (!connection.providerAccountId && organizations.length === 1) {
        selected = organizations[0];
        if (store.setOrganization) connection = await store.setOrganization(context, selected) || connection;
        connection.providerAccountId = selected.id;
        connection.organizationName = selected.name;
      }
      const hasOrganization = provider !== 'zoho_books' || Boolean(selected);
      const usable = Boolean(connection.providerAccountId && connection.apiDomain && refreshed.token.refreshToken && hasOrganization);
      const status = connection.status === 'disconnected' ? 'not_connected' : connection.lastSyncStatus === 'failed' ? 'needs_attention' : usable ? 'connected' : !connection.providerAccountId && organizations.length > 1 ? 'needs_organization' : 'needs_attention';
      const problem = connection.lastSyncError || (!connection.apiDomain ? 'Zoho regional API access is unavailable.' : !connection.providerAccountId ? (organizations.length > 1 ? null : 'No Zoho Books organization is available.') : !selected ? 'The selected Zoho Books organization is unavailable.' : null);
      if (status !== 'not_connected' && store.setConnectionStatus) await store.setConnectionStatus(context, status, problem).catch(() => {});
      return {
        provider,
        status,
        organizationId: connection.providerAccountId || null,
        organizationName: selected?.name || connection.organizationName || null,
        organizations: organizations.map(({id, name}) => ({id, name})),
        lastSyncedAt: connection.lastSyncedAt || null,
        syncStatus: connection.lastSyncStatus || 'never',
        problem,
      };
    } catch {
      const problem = 'Zoho authorization needs to be renewed.';
      if (store.setConnectionStatus) await store.setConnectionStatus(context, 'needs_attention', problem).catch(() => {});
      return { provider, status: 'needs_attention', organizationId: connection.providerAccountId || null, organizationName: connection.organizationName || null, organizations: [], lastSyncedAt: connection.lastSyncedAt || null, syncStatus: connection.lastSyncStatus || 'never', problem };
    }
  }

  async function selectOrganization({ userId, workspaceId, provider, organizationId } = {}) {
    const context = identity({ userId, workspaceId, provider });
    if (typeof organizationId !== 'string' || !organizationId.trim() || organizationId.length > 80) throw new AccountingError('ACCOUNTING_ORGANIZATION_REQUIRED', 'Select a valid Zoho Books organization');
    const {result: organizations} = await withProviderRetry(context, ({token}) => providers[provider].fetchOrganizations({ token }));
    const organization = organizations.find(item => item.id === organizationId.trim());
    if (!organization) throw new AccountingError('ACCOUNTING_ORGANIZATION_INVALID', 'Selected Zoho Books organization is unavailable');
    if (!store.setOrganization) throw new AccountingError('ACCOUNTING_STORE_ERROR', 'Organization selection is unavailable');
    await store.setOrganization(context, organization);
    return { provider, status: 'connected', organizationId: organization.id, organizationName: organization.name };
  }

  async function disconnect({ userId, workspaceId, provider } = {}) {
    const context = identity({ userId, workspaceId, provider });
    const connection = await store.getConnection(context);
    if (!connection) return { provider, status: 'not_connected' };
    // Revoke remotely when supported, but always remove local credentials so
    // future requests cannot use the connection. Historical sync records remain.
    if (typeof providers[provider].revokeToken === 'function') {
      try {
        const token = await decryptConnection(connection);
        await providers[provider].revokeToken({ refreshToken: token.refreshToken, region: connection.region });
      } catch { /* Local disconnect must still complete. */ }
    }
    if (!store.deleteConnection) throw new AccountingError('ACCOUNTING_STORE_ERROR', 'Disconnect is unavailable');
    await store.deleteConnection(context);
    return { provider, status: 'not_connected' };
  }

  async function decryptConnection(connection) {
    if (!connection) throw new AccountingError('ACCOUNTING_NOT_CONNECTED', 'Accounting provider is not connected');
    const token = cipher.decrypt({ iv: connection.iv, ciphertext: connection.ciphertext, tag: connection.tag }, connectionAad(connection.provider, connection.workspaceId));
    if (!token?.accessToken || !token?.refreshToken) throw new AccountingError('ACCOUNTING_TOKEN_INVALID', 'Accounting credentials are invalid');
    return token;
  }

  async function accessToken({ userId, workspaceId, provider } = {}, { force = false } = {}) {
    const context = identity({ userId, workspaceId, provider });
    let connection = await store.getConnection(context);
    let token = await decryptConnection(connection);
    if (!force && Number(token.expiresAt || connection.tokenExpiresAt || 0) > now() + EXPIRY_SKEW) return { token, connection };

    const leaseToken = randomUUID();
    const claim = await store.claimRefresh(context, leaseToken, refreshLeaseMs);
    if (!claim?.claimed) {
      // Another process is refreshing the row. Poll durable state briefly and
      // only proceed once the rotated access token is visible.
      const deadline = Date.now() + Math.min(refreshLeaseMs, 5000);
      while (Date.now() < deadline) {
        await sleep(25);
        connection = await store.getConnection(context);
        token = await decryptConnection(connection);
        if (Number(token.expiresAt || connection.tokenExpiresAt || 0) > now() + EXPIRY_SKEW) return { token, connection };
      }
      throw new AccountingError('ACCOUNTING_REFRESH_BUSY', 'Accounting credentials are being refreshed');
    }
    try {
      connection = await store.getConnection(context);
      token = await decryptConnection(connection);
      if (!force && Number(token.expiresAt) > now() + EXPIRY_SKEW) {
        await store.releaseRefresh(context, leaseToken);
        return { token, connection };
      }
      const refreshed = await providers[provider].refreshToken({ refreshToken: token.refreshToken, region: connection.region });
      const merged = { ...token, ...refreshed, refreshToken: refreshed.refreshToken || token.refreshToken };
      const encrypted = tokenEnvelope(cipher, merged, provider, context.workspaceId);
      const updated = await store.updateConnection(context, encrypted, { tokenExpiresAt: merged.expiresAt, apiDomain: merged.apiDomain || connection.apiDomain, providerAccountId: merged.providerAccountId || connection.providerAccountId, region: merged.region || connection.region }, claim.revision, leaseToken);
      return { token: merged, connection: updated };
    } catch (error) {
      await store.releaseRefresh(context, leaseToken).catch(() => {});
      if (error?.code === 'ACCOUNTING_CONNECTION_CONFLICT') {
        const latest = await store.getConnection(context);
        const latestToken = await decryptConnection(latest);
        if (Number(latestToken.expiresAt || latest.tokenExpiresAt || 0) > now() + EXPIRY_SKEW) return { token: latestToken, connection: latest };
      }
      if (store.setConnectionStatus) await store.setConnectionStatus(context, 'needs_attention', 'Zoho authorization needs to be renewed.').catch(() => {});
      if (error?.code?.startsWith?.('ACCOUNTING_')) throw error;
      throw new AccountingError('ACCOUNTING_REFRESH_FAILED', 'Accounting credentials could not be refreshed', redactedError(error));
    }
  }

  async function withProviderRetry(context, operation) {
    let authorization = await accessToken(context);
    try {
      return {...authorization, result: await operation(authorization)};
    } catch (error) {
      if (error?.code !== 'ACCOUNTING_PROVIDER_ERROR' || ![401, 403].includes(error.status)) throw error;
      authorization = await accessToken(context, {force: true});
      return {...authorization, result: await operation(authorization)};
    }
  }

  async function sync({ userId, workspaceId, provider, invoicePage = 1, paymentPage = 1 } = {}) {
    const context = identity({ userId, workspaceId, provider });
    if (![invoicePage,paymentPage].every(p => Number.isInteger(p) && p>0 && p<=10000)) throw new AccountingError('ACCOUNTING_PAGE_INVALID','Invalid sync page');
    const adapter = providers[provider];
    let connection = await store.getConnection(context);
    if (!connection?.providerAccountId || !connection.apiDomain) throw new AccountingError('ACCOUNTING_NOT_CONNECTED', 'A verified Zoho Books organization is required before syncing');
    await store.markSyncResult?.(context, { syncedAt: null, error: null });
    try {
      const fetched = await withProviderRetry(context, ({token, connection: activeConnection}) => Promise.all([
        typeof adapter.fetchContacts === 'function' ? adapter.fetchContacts({ token, accountId: activeConnection.providerAccountId, page: 1 }) : [],
        adapter.fetchInvoices({ token, accountId: activeConnection.providerAccountId, page:invoicePage }),
        adapter.fetchPayments({ token, accountId: activeConnection.providerAccountId, page:paymentPage }),
      ]));
      connection = fetched.connection;
      const [customers, invoices, payments] = fetched.result;
      const persisted = store.upsertSyncSnapshots ? await store.upsertSyncSnapshots({ userId: context.userId, workspaceId: context.workspaceId, provider, customers, invoices, payments }) : null;
      const lastSyncedAt = new Date(now()).toISOString();
      await store.markSyncResult?.(context, { syncedAt: lastSyncedAt, error: null });
      return { provider, userId: context.userId, workspaceId: context.workspaceId, customers, invoices, payments, lastSyncedAt, syncStatus: 'synced', pagination: { customers: { nextPage: customers.nextPage || null }, invoices: { nextPage: invoices.nextPage || null }, payments: { nextPage: payments.nextPage || null } }, persisted };
    } catch (error) {
      await store.markSyncResult?.(context, { syncedAt: null, error: 'Zoho Books synchronization failed.' }).catch(() => {});
      throw new AccountingError('ACCOUNTING_SYNC_FAILED', 'Zoho Books synchronization failed', redactedError(error));
    }
  }

  async function readZohoData({ userId, workspaceId, provider = 'zoho_books', resource, page = 1, perPage = 100 } = {}) {
    const context = identity({ userId, workspaceId, provider });
    if (provider !== 'zoho_books') throw new AccountingError('ACCOUNTING_PROVIDER_UNSUPPORTED', 'This data reader is only available for Zoho Books');
    if (!['invoices', 'contacts', 'payments'].includes(resource)) throw new AccountingError('ACCOUNTING_RESOURCE_UNSUPPORTED', 'Unsupported Zoho Books resource');
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(perPage) || perPage < 1 || perPage > 200) throw new AccountingError('ACCOUNTING_PAGE_INVALID', 'Invalid Zoho Books page');
    const connection = await store.getConnection(context);
    if (!connection?.providerAccountId) throw new AccountingError('ACCOUNTING_ORGANIZATION_REQUIRED', 'Choose a Zoho Books organization before reading its data');
    const method = resource === 'invoices' ? 'fetchInvoices' : resource === 'contacts' ? 'fetchContacts' : 'fetchPayments';
    if (typeof providers[provider][method] !== 'function') throw new AccountingError('ACCOUNTING_NOT_CONFIGURED', 'Zoho Books data reader is unavailable');
    const {result: rows} = await withProviderRetry(context, ({token, connection: activeConnection}) => providers[provider][method]({token, accountId: activeConnection.providerAccountId, page, perPage}));
    return {provider, resource, records: rows.map(({raw, ...record}) => record), nextPage: rows.nextPage || null};
  }

  async function latestInvoiceBalance({ userId, workspaceId, provider, invoiceId } = {}) {
    const context = identity({ userId, workspaceId, provider });
    if (!invoiceId) throw new AccountingError('ACCOUNTING_INVOICE_REQUIRED', 'External invoice ID is required');
    const {result: balance} = await withProviderRetry(context, ({token, connection}) => providers[provider].fetchInvoiceBalance({ token, accountId: connection.providerAccountId, invoiceId }));
    if (!balance || !Number.isSafeInteger(balance.balanceMinor) || balance.balanceMinor < 0 || balance.externalId !== String(invoiceId) || (balance.totalMinor !== null && balance.totalMinor < balance.balanceMinor)) throw new AccountingError('ACCOUNTING_BALANCE_INVALID', 'Accounting provider returned an invalid invoice balance');
    return { provider, invoiceId: String(invoiceId), balanceMinor: balance.balanceMinor, currency: balance.currency || null, amountMinor: balance.totalMinor ?? null };
  }

  async function syncInvoice({ userId, workspaceId, invoice, invoiceId } = {}) {
    if (!invoice || typeof invoice !== 'object' || !invoiceId) throw new AccountingError('ACCOUNTING_INVOICE_REQUIRED', 'A saved invoice is required');
    let connected = null;
    for (const provider of ACCOUNTING_PROVIDERS) {
      const connection = await store.getConnection({userId: String(userId), workspaceId: String(workspaceId), provider});
      if (connection) { connected = provider; break; }
    }
    if (!connected) throw new AccountingError('ACCOUNTING_NOT_CONNECTED', 'Accounting provider is not connected');
    const adapter = providers[connected];
    if (typeof adapter.createInvoice !== 'function') throw new AccountingError('ACCOUNTING_NOT_CONFIGURED', 'Accounting invoice creation is unavailable');
    try {
      const {result} = await withProviderRetry({userId, workspaceId, provider: connected}, ({token, connection}) => adapter.createInvoice({token, accountId: connection.providerAccountId, invoice: {...invoice, localInvoiceId: String(invoiceId)}}));
      if (!result?.externalId) throw new Error('Missing external invoice ID');
      return {provider: connected, externalId: String(result.externalId), duplicate: Boolean(result.duplicate)};
    } catch (error) {
      if (error?.code?.startsWith?.('ACCOUNTING_')) throw error;
      throw new AccountingError('ACCOUNTING_SYNC_FAILED', 'Invoice could not be synced to accounting', redactedError(error));
    }
  }

  async function updateInvoice({ userId, workspaceId, provider = 'zoho_books', invoiceId, invoice } = {}) {
    const context = identity({ userId, workspaceId, provider });
    if (provider !== 'zoho_books' || !invoiceId || !invoice || typeof invoice !== 'object' || Array.isArray(invoice)) throw new AccountingError('ACCOUNTING_INVOICE_REQUIRED', 'A Zoho invoice ID and supported field updates are required');
    const connection = await store.getConnection(context);
    if (!connection.providerAccountId || !connection.apiDomain) throw new AccountingError('ACCOUNTING_ORGANIZATION_REQUIRED', 'Choose a Zoho Books organization before editing invoices');
    const adapter = providers[provider];
    if (typeof adapter.updateInvoice !== 'function') throw new AccountingError('ACCOUNTING_NOT_CONFIGURED', 'Zoho Books invoice editing is unavailable');
    try {
      const {result: updated} = await withProviderRetry(context, ({token, connection: activeConnection}) => adapter.updateInvoice({token, accountId: activeConnection.providerAccountId, invoiceId: String(invoiceId), invoice}));
      if (!updated?.externalId || String(updated.externalId) !== String(invoiceId)) throw new Error('Zoho Books did not confirm the invoice update');
      await store.upsertSyncSnapshots?.({userId: context.userId, workspaceId: context.workspaceId, provider, invoices: [updated]});
      return {provider, externalId: String(updated.externalId), invoice: Object.fromEntries(Object.entries(updated).filter(([key]) => key !== 'raw'))};
    } catch (error) {
      if (error?.code?.startsWith?.('ACCOUNTING_')) throw error;
      throw new AccountingError('ACCOUNTING_SYNC_FAILED', 'Invoice could not be updated in Zoho Books', redactedError(error));
    }
  }

  return Object.freeze({ startOAuth, callback, handleOAuthCallback: callback, accessToken, getAccessToken: accessToken, connectionStatus, selectOrganization, disconnect, readZohoData, sync, syncInvoicesAndPayments: sync, syncInvoice, updateInvoice, latestInvoiceBalance });
}
