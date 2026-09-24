import { randomUUID } from 'node:crypto';
import { AccountingError } from './errors.mjs';

function keyOf({ provider, userId, workspaceId }) {
  return `${provider}:${userId}:${workspaceId}`;
}
function majorAmount(minor, currency) {
  const code = String(currency || 'INR').toUpperCase();
  const scale = ['BHD','IQD','JOD','KWD','LYD','OMR','TND'].includes(code) ? 1000 : ['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(code) ? 1 : 100;
  return Number(minor) / scale;
}

export class InMemoryAccountingStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.connections = new Map();
    this.states = new Map();
    this.snapshots = new Map();
  }

  async putOAuthState(state) {
    this.states.set(state.stateHash, { ...state });
  }

  async consumeOAuthState(stateHash, now = this.now()) {
    const state = this.states.get(stateHash);
    if (!state || state.usedAt || Number(state.expiresAt) <= now) return null;
    state.usedAt = now;
    this.states.set(stateHash, state);
    return { ...state };
  }

  async getConnection(identity) {
    const value = this.connections.get(keyOf(identity));
    return value ? structuredClone(value) : null;
  }

  async setOrganization(identity, organization) {
    const key = keyOf(identity);
    const row = this.connections.get(key);
    if (!row) throw new AccountingError('ACCOUNTING_NOT_CONNECTED', 'Zoho authorization is not available');
    const updated = { ...row, providerAccountId: String(organization.id), organizationName: String(organization.name || ''), status: 'connected', connectionProblem: null, updatedAt: this.now() };
    this.connections.set(key, updated);
    return this.getConnection(identity);
  }

  async deleteConnection(identity) {
    this.connections.delete(keyOf(identity));
  }

  async setConnectionStatus(identity, status, problem = null) {
    const key = keyOf(identity);
    const row = this.connections.get(key);
    if (!row) return null;
    this.connections.set(key, { ...row, status, connectionProblem: problem, updatedAt: this.now() });
    return this.getConnection(identity);
  }

  async insertConnection(connection) {
    const key = keyOf(connection);
    if (this.connections.has(key)) throw new AccountingError('ACCOUNTING_CONNECTION_EXISTS', 'Accounting connection already exists');
    this.connections.set(key, { ...structuredClone(connection), revision: 1, lease: null });
    return this.getConnection(connection);
  }

  async replaceConnection(connection, expectedRevision) {
    const key = keyOf(connection);
    const existing = this.connections.get(key);
    if (!existing || existing.revision !== expectedRevision) throw new AccountingError('ACCOUNTING_CONNECTION_CONFLICT', 'Accounting connection changed during authorization');
    this.connections.set(key, { ...structuredClone(connection), revision: existing.revision + 1, lease: null, updatedAt: this.now() });
    return this.getConnection(connection);
  }

  async claimRefresh(identity, leaseToken, leaseMs = 30000) {
    const key = keyOf(identity);
    const row = this.connections.get(key);
    if (!row) return null;
    const now = this.now();
    if (row.lease && row.lease.expiresAt > now && row.lease.token !== leaseToken) return { claimed: false, revision: row.revision };
    row.lease = { token: leaseToken, expiresAt: now + leaseMs };
    this.connections.set(key, row);
    return { claimed: true, revision: row.revision };
  }

  async updateConnection(identity, encryptedTokens, metadata, expectedRevision, leaseToken) {
    const key = keyOf(identity);
    const row = this.connections.get(key);
    if (!row || row.revision !== expectedRevision || row.lease?.token !== leaseToken) throw new AccountingError('ACCOUNTING_CONNECTION_CONFLICT', 'Accounting connection changed during refresh');
    const updated = { ...row, ...metadata, ...encryptedTokens, revision: row.revision + 1, lease: null, updatedAt: this.now() };
    this.connections.set(key, updated);
    return this.getConnection(identity);
  }

  async releaseRefresh(identity, leaseToken) {
    const row = this.connections.get(keyOf(identity));
    if (row?.lease?.token === leaseToken) {
      row.lease = null;
      this.connections.set(keyOf(identity), row);
    }
  }

  async upsertSyncSnapshots({ userId, workspaceId, provider, customers = [], invoices = [], payments = [] }) {
    let count = 0;
    for (const [kind, values] of [['customer', customers], ['invoice', invoices], ['payment', payments]]) for (const value of values) {
      const key = `${provider}:${workspaceId}:${kind}:${value.externalId}`;
      this.snapshots.set(key, { userId, workspaceId, provider, kind, externalId: value.externalId, payload: structuredClone(value), updatedAt: this.now() });
      count++;
    }
    return { count };
  }

  async markSyncResult(identity, { syncedAt = null, error = null } = {}) {
    const row = this.connections.get(keyOf(identity));
    if (!row) return null;
    row.lastSyncedAt = syncedAt;
    row.lastSyncError = error;
    row.lastSyncStatus = error ? 'failed' : syncedAt ? 'synced' : 'syncing';
    if (error) row.status = 'needs_attention';
    else if (syncedAt && row.providerAccountId) row.status = 'connected';
    row.updatedAt = this.now();
    this.connections.set(keyOf(identity), row);
    return this.getConnection(identity);
  }
}

/**
 * Supabase Data API store. It intentionally uses a service-role key only on the
 * server and delegates state consumption/token refresh races to Postgres RPCs.
 */
export class SupabaseAccountingStore {
  constructor({ url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl = globalThis.fetch, table = 'cetld_accounting_connections', stateTable = 'cetld_accounting_oauth_states', snapshotTable = 'cetld_accounting_sync_records' } = {}) {
    if (!url || !serviceRoleKey) throw new Error('Supabase accounting store requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    this.base = String(url).replace(/\/$/, '');
    this.key = serviceRoleKey;
    this.fetch = fetchImpl;
    this.table = table;
    this.stateTable = stateTable;
    this.snapshotTable = snapshotTable;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.base}/rest/v1/${path}`, {
      ...options,
      signal: AbortSignal.timeout(10000),
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, Accept: 'application/json', ...(options.headers || {}) },
    });
    if (!response.ok) throw new AccountingError('ACCOUNTING_STORE_ERROR', 'Accounting storage request failed');
    if (response.status === 204) return null;
    try { return await response.json(); } catch { return null; }
  }

  async rpc(name, body) {
    return this.request(`rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async putOAuthState(state) {
    await this.request(this.stateTable, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ state_hash: state.stateHash, owner_id: state.userId, workspace_id: state.workspaceId, provider: state.provider, redirect_uri: state.redirectUri, region: state.region || null, provider_account_id: state.providerAccountId || null, browser_nonce_hash: state.browserNonceHash || null, expires_at: new Date(state.expiresAt).toISOString() }) });
  }

  async consumeOAuthState(stateHash, now = Date.now()) {
    const rows = await this.rpc('cetld_consume_accounting_oauth_state', { p_state_hash: stateHash, p_now: new Date(now).toISOString() });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row ? { stateHash: row.state_hash, userId: row.owner_id, workspaceId: row.workspace_id, provider: row.provider, redirectUri: row.redirect_uri, region: row.region, providerAccountId: row.provider_account_id, browserNonceHash: row.browser_nonce_hash, expiresAt: Date.parse(row.expires_at), usedAt: Date.parse(row.used_at) } : null;
  }

  async getConnection(identity) {
    const query = new URLSearchParams({ select: '*', owner_id: `eq.${identity.userId}`, workspace_id: `eq.${identity.workspaceId}`, provider: `eq.${identity.provider}`, limit: '1' });
    const rows = await this.request(`${this.table}?${query}`);
    return Array.isArray(rows) && rows[0] ? mapConnection(rows[0]) : null;
  }

  async setOrganization(identity, organization) {
    const query = new URLSearchParams({ owner_id: `eq.${identity.userId}`, workspace_id: `eq.${identity.workspaceId}`, provider: `eq.${identity.provider}`, select: '*' });
    const rows = await this.request(`${this.table}?${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ provider_account_id: organization.id, organization_name: organization.name || null, connection_problem: null, status: 'connected' }) });
    return Array.isArray(rows) && rows[0] ? mapConnection(rows[0]) : null;
  }

  async setConnectionStatus(identity, status, problem = null) {
    const query = new URLSearchParams({ owner_id: `eq.${identity.userId}`, workspace_id: `eq.${identity.workspaceId}`, provider: `eq.${identity.provider}`, select: '*' });
    const rows = await this.request(`${this.table}?${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ status, connection_problem: problem }) });
    return Array.isArray(rows) && rows[0] ? mapConnection(rows[0]) : null;
  }

  async deleteConnection(identity) {
    const query = new URLSearchParams({ owner_id: `eq.${identity.userId}`, workspace_id: `eq.${identity.workspaceId}`, provider: `eq.${identity.provider}` });
    await this.request(`${this.table}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }

  async insertConnection(connection) {
    const row = await this.request(this.table, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(toRow(connection)) });
    return mapConnection(Array.isArray(row) ? row[0] : row);
  }

  async replaceConnection(connection, expectedRevision) {
    const query = new URLSearchParams({ owner_id: `eq.${connection.userId}`, workspace_id: `eq.${connection.workspaceId}`, provider: `eq.${connection.provider}`, revision: `eq.${expectedRevision}` });
    const row = await this.request(`${this.table}?${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ provider_account_id: connection.providerAccountId || null, organization_name: connection.organizationName || null, connection_problem: connection.connectionProblem || null, status: connection.status || (connection.providerAccountId ? 'connected' : 'needs_organization'), region: connection.region || null, accounts_domain: connection.accountsDomain || null, api_domain: connection.apiDomain || null, last_sync_status: connection.lastSyncStatus || 'never', token_ciphertext: connection.ciphertext, token_iv: connection.iv, token_tag: connection.tag, token_expires_at: new Date(connection.tokenExpiresAt).toISOString(), revision: Number(expectedRevision) + 1, refresh_lease_token: null, refresh_lease_until: null }) });
    if (!Array.isArray(row) || !row[0]) throw new AccountingError('ACCOUNTING_CONNECTION_CONFLICT', 'Accounting connection changed during authorization');
    return mapConnection(row[0]);
  }

  async claimRefresh(identity, leaseToken, leaseMs = 30000) {
    const rows = await this.rpc('cetld_claim_accounting_connection_refresh', { p_owner_id: identity.userId, p_workspace_id: identity.workspaceId, p_provider: identity.provider, p_lease_token: leaseToken, p_lease_ms: leaseMs });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row ? { claimed: Boolean(row.claimed), revision: Number(row.revision) } : null;
  }

  async updateConnection(identity, encryptedTokens, metadata, expectedRevision, leaseToken) {
    const rows = await this.rpc('cetld_update_accounting_connection_tokens', { p_owner_id: identity.userId, p_workspace_id: identity.workspaceId, p_provider: identity.provider, p_expected_revision: expectedRevision, p_lease_token: leaseToken, p_token_ciphertext: encryptedTokens.ciphertext, p_token_iv: encryptedTokens.iv, p_token_tag: encryptedTokens.tag, p_token_expires_at: metadata.tokenExpiresAt ? new Date(metadata.tokenExpiresAt).toISOString() : null, p_api_domain: metadata.apiDomain || null, p_provider_account_id: metadata.providerAccountId || null, p_region: metadata.region || null });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new AccountingError('ACCOUNTING_CONNECTION_CONFLICT', 'Accounting connection changed during refresh');
    return mapConnection(row);
  }

  async releaseRefresh(identity, leaseToken) {
    await this.rpc('cetld_release_accounting_connection_refresh', { p_owner_id: identity.userId, p_workspace_id: identity.workspaceId, p_provider: identity.provider, p_lease_token: leaseToken });
  }

  async markSyncResult(identity, { syncedAt = null, error = null } = {}) {
    const query = new URLSearchParams({ owner_id: `eq.${identity.userId}`, workspace_id: `eq.${identity.workspaceId}`, provider: `eq.${identity.provider}`, select: '*' });
    const rows = await this.request(`${this.table}?${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ last_synced_at: syncedAt, last_sync_status: error ? 'failed' : syncedAt ? 'synced' : 'syncing', last_sync_error: error, ...(error ? { status: 'needs_attention' } : syncedAt ? { status: 'connected' } : {}) }) });
    return Array.isArray(rows) && rows[0] ? mapConnection(rows[0]) : null;
  }

  async upsertSyncSnapshots({ userId, workspaceId, provider, customers = [], invoices = [], payments = [] }) {
    const rows = [
      ...customers.map((payload) => ({ owner_id: userId, workspace_id: workspaceId, provider, record_type: 'customer', external_id: String(payload.externalId), payload, synced_at: new Date().toISOString() })),
      ...invoices.map((payload) => ({ owner_id: userId, workspace_id: workspaceId, provider, record_type: 'invoice', external_id: String(payload.externalId), payload, synced_at: new Date().toISOString() })),
      ...payments.map((payload) => ({ owner_id: userId, workspace_id: workspaceId, provider, record_type: 'payment', external_id: String(payload.externalId), payload, synced_at: new Date().toISOString() })),
    ];
    let snapshotCount = 0;
    if (rows.length) {
      const result = await this.request(`${this.snapshotTable}?on_conflict=workspace_id,provider,record_type,external_id`, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows) });
      snapshotCount = Array.isArray(result) ? result.length : rows.length;
    }
    const syncedAt = new Date().toISOString();
    const customersByExternal = new Map();
    for (const customer of customers) {
      if (!customer.externalId || !customer.name) continue;
      const values = { workspace_id: workspaceId, name: customer.name.slice(0, 200), company_name: customer.companyName || null, email: customer.email || null, phone: customer.phone || null, external_provider: provider, external_customer_id: String(customer.externalId), last_synced_at: syncedAt, sync_status: 'synced', last_sync_error: null, metadata: { accounting_provider: provider } };
      let saved;
      if (customer.email) {
        const match = await this.request(`customers?${new URLSearchParams({ select: 'id,name,company_name,external_provider,external_customer_id', workspace_id: `eq.${workspaceId}`, email: `ilike.${String(customer.email).replace(/([%_])/g, '\\$1')}`, limit: '2' })}`);
        if (Array.isArray(match) && match.length === 1) {
          const row = match[0];
          const sameIdentity = String(row.name || '').toLowerCase() === String(customer.name).toLowerCase() || String(row.company_name || '').toLowerCase() === String(customer.companyName || customer.name).toLowerCase();
          if (sameIdentity && (!row.external_provider || (row.external_provider === provider && row.external_customer_id === String(customer.externalId)))) {
            saved = await this.request(`customers?id=eq.${row.id}&workspace_id=eq.${workspaceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(values) });
          } else if (row.external_provider !== provider || row.external_customer_id !== String(customer.externalId)) continue;
        }
      }
      if (!saved) saved = await this.request(`customers?on_conflict=workspace_id,external_provider,external_customer_id`, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([values]) });
      if (Array.isArray(saved) && saved[0]?.id) customersByExternal.set(String(customer.externalId), saved[0].id);
    }
    let invoiceCount = 0;
    for (const invoice of invoices) {
      const externalCustomerId = String(invoice.raw?.customer_id || '');
      let customerId = customersByExternal.get(externalCustomerId);
      if (!customerId && externalCustomerId) {
        const linkedCustomer = await this.request(`customers?${new URLSearchParams({ select: 'id', workspace_id: `eq.${workspaceId}`, external_provider: `eq.${provider}`, external_customer_id: `eq.${externalCustomerId}`, limit: '1' })}`);
        customerId = Array.isArray(linkedCustomer) ? linkedCustomer[0]?.id : null;
      }
      if (!customerId || !invoice.number || !invoice.invoiceDate) continue;
      const total = majorAmount(invoice.amountMinor, invoice.currency);
      const paid = Math.min(total, Math.max(0, majorAmount(invoice.paidMinor, invoice.currency)));
      const normalizedStatus = Number(invoice.balanceMinor) === 0 ? 'paid' : invoice.status === 'void' || invoice.status === 'voided' ? 'void' : invoice.status === 'overdue' ? 'overdue' : invoice.status === 'draft' ? 'draft' : 'sent';
      const values = { workspace_id: workspaceId, customer_id: customerId, invoice_number: String(invoice.number).slice(0, 100), issue_date: invoice.invoiceDate, due_date: invoice.dueDate || null, currency: invoice.currency || 'INR', total_amount: total, amount_paid: paid, status: normalizedStatus, notes: invoice.raw?.notes || null, external_provider: provider, external_invoice_id: String(invoice.externalId), last_synced_at: syncedAt, sync_status: 'synced', last_sync_error: null, metadata: { accounting_provider: provider, external_customer_id: externalCustomerId } };
      const existing = await this.request(`invoices?${new URLSearchParams({ select: 'id,external_invoice_id,invoice_number', workspace_id: `eq.${workspaceId}`, external_provider: `eq.${provider}`, external_invoice_id: `eq.${invoice.externalId}`, limit: '1' })}`);
      if (Array.isArray(existing) && existing[0]) {
        await this.request(`invoices?id=eq.${existing[0].id}&workspace_id=eq.${workspaceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(values) });
        invoiceCount++;
        continue;
      }
      const sameNumber = await this.request(`invoices?${new URLSearchParams({ select: 'id,external_provider,external_invoice_id,total_amount,customer_id', workspace_id: `eq.${workspaceId}`, invoice_number: `eq.${invoice.number}`, limit: '1' })}`);
      if (Array.isArray(sameNumber) && sameNumber[0]) {
        if (sameNumber[0].external_provider && (sameNumber[0].external_provider !== provider || sameNumber[0].external_invoice_id !== String(invoice.externalId))) continue;
        if (Number(sameNumber[0].total_amount) !== Number(values.total_amount) || String(sameNumber[0].customer_id) !== String(customerId)) continue;
        await this.request(`invoices?id=eq.${sameNumber[0].id}&workspace_id=eq.${workspaceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(values) });
        invoiceCount++;
      } else {
        const saved = await this.request('invoices?on_conflict=workspace_id,external_provider,external_invoice_id', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([values]) });
        if (Array.isArray(saved) && saved[0]?.id) invoiceCount++;
      }
    }
    let paymentCount = 0;
    for (const payment of payments) {
      const externalInvoiceIds = payment.invoiceIds || [];
      for (const externalInvoiceId of externalInvoiceIds) {
        const linkedInvoices = await this.request(`invoices?${new URLSearchParams({ select: 'id', workspace_id: `eq.${workspaceId}`, external_provider: `eq.${provider}`, external_invoice_id: `eq.${externalInvoiceId}`, limit: '1' })}`);
        const invoiceId = Array.isArray(linkedInvoices) ? linkedInvoices[0]?.id : null;
        if (!invoiceId) continue;
        const appliedAmount = payment.raw?.invoices?.find((item) => String(item.invoice_id) === String(externalInvoiceId))?.amount_applied;
        const amount = Number.isFinite(Number(appliedAmount)) ? Number(appliedAmount) : externalInvoiceIds.length === 1 ? majorAmount(payment.amountMinor, payment.currency) : null;
        if (!amount || amount <= 0) continue;
        const values = { workspace_id: workspaceId, invoice_id: invoiceId, amount, paid_at: payment.paymentDate || syncedAt, reference: payment.reference || null, external_provider: provider, external_payment_id: externalInvoiceIds.length > 1 ? `${payment.externalId}:${externalInvoiceId}` : String(payment.externalId), last_synced_at: syncedAt, sync_status: 'synced', last_sync_error: null, metadata: { accounting_provider: provider, external_payment_id: String(payment.externalId), external_invoice_id: String(externalInvoiceId) } };
        await this.request(`payments?on_conflict=workspace_id,external_provider,external_payment_id`, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([values]) });
        paymentCount++;
      }
    }
    return { count: snapshotCount, customers: customersByExternal.size, invoices: invoiceCount, payments: paymentCount };
  }
}

function toRow(connection) {
  return { owner_id: connection.userId, workspace_id: connection.workspaceId, provider: connection.provider, provider_account_id: connection.providerAccountId || null, organization_name: connection.organizationName || null, connection_problem: connection.connectionProblem || null, region: connection.region || null, accounts_domain: connection.accountsDomain || null, api_domain: connection.apiDomain || null, token_ciphertext: connection.ciphertext, token_iv: connection.iv, token_tag: connection.tag, token_expires_at: new Date(connection.tokenExpiresAt).toISOString(), revision: 1, status: connection.status || (connection.providerAccountId ? 'connected' : 'needs_organization'), last_sync_status: connection.lastSyncStatus || 'never' };
}

function mapConnection(row) {
  return { userId: row.owner_id, workspaceId: row.workspace_id, provider: row.provider, providerAccountId: row.provider_account_id, organizationName: row.organization_name || null, status: row.status || (row.provider_account_id ? 'connected' : 'needs_organization'), connectionProblem: row.connection_problem || null, region: row.region, accountsDomain: row.accounts_domain, apiDomain: row.api_domain, lastSyncedAt: row.last_synced_at || null, lastSyncStatus: row.last_sync_status || 'never', lastSyncError: row.last_sync_error || null, ciphertext: row.token_ciphertext, iv: row.token_iv, tag: row.token_tag, tokenExpiresAt: Date.parse(row.token_expires_at), revision: Number(row.revision || 1), lease: row.refresh_lease_token ? { token: row.refresh_lease_token, expiresAt: Date.parse(row.refresh_lease_until) } : null };
}

export const createSupabaseAccountingStore = (options) => new SupabaseAccountingStore(options);
