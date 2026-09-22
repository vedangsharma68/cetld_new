import { randomUUID } from 'node:crypto';
import { AccountingError } from './errors.mjs';

function keyOf({ provider, userId, workspaceId }) {
  return `${provider}:${userId}:${workspaceId}`;
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

  async upsertSyncSnapshots({ userId, workspaceId, provider, invoices = [], payments = [] }) {
    let count = 0;
    for (const [kind, values] of [['invoice', invoices], ['payment', payments]]) for (const value of values) {
      const key = `${provider}:${workspaceId}:${kind}:${value.externalId}`;
      this.snapshots.set(key, { userId, workspaceId, provider, kind, externalId: value.externalId, payload: structuredClone(value), updatedAt: this.now() });
      count++;
    }
    return { count };
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

  async insertConnection(connection) {
    const row = await this.request(this.table, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(toRow(connection)) });
    return mapConnection(Array.isArray(row) ? row[0] : row);
  }

  async replaceConnection(connection, expectedRevision) {
    const query = new URLSearchParams({ owner_id: `eq.${connection.userId}`, workspace_id: `eq.${connection.workspaceId}`, provider: `eq.${connection.provider}`, revision: `eq.${expectedRevision}` });
    const row = await this.request(`${this.table}?${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ provider_account_id: connection.providerAccountId || null, region: connection.region || null, api_domain: connection.apiDomain || null, token_ciphertext: connection.ciphertext, token_iv: connection.iv, token_tag: connection.tag, token_expires_at: new Date(connection.tokenExpiresAt).toISOString(), revision: Number(expectedRevision) + 1, refresh_lease_token: null, refresh_lease_until: null }) });
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

  async upsertSyncSnapshots({ userId, workspaceId, provider, invoices = [], payments = [] }) {
    const rows = [
      ...invoices.map((payload) => ({ owner_id: userId, workspace_id: workspaceId, provider, record_type: 'invoice', external_id: String(payload.externalId), payload, synced_at: new Date().toISOString() })),
      ...payments.map((payload) => ({ owner_id: userId, workspace_id: workspaceId, provider, record_type: 'payment', external_id: String(payload.externalId), payload, synced_at: new Date().toISOString() })),
    ];
    if (!rows.length) return { count: 0 };
    const result = await this.request(`${this.snapshotTable}?on_conflict=workspace_id,provider,record_type,external_id`, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows) });
    return { count: Array.isArray(result) ? result.length : rows.length };
  }
}

function toRow(connection) {
  return { owner_id: connection.userId, workspace_id: connection.workspaceId, provider: connection.provider, provider_account_id: connection.providerAccountId || null, region: connection.region || null, api_domain: connection.apiDomain || null, token_ciphertext: connection.ciphertext, token_iv: connection.iv, token_tag: connection.tag, token_expires_at: new Date(connection.tokenExpiresAt).toISOString(), revision: 1 };
}

function mapConnection(row) {
  return { userId: row.owner_id, workspaceId: row.workspace_id, provider: row.provider, providerAccountId: row.provider_account_id, region: row.region, apiDomain: row.api_domain, ciphertext: row.token_ciphertext, iv: row.token_iv, tag: row.token_tag, tokenExpiresAt: Date.parse(row.token_expires_at), revision: Number(row.revision || 1), lease: row.refresh_lease_token ? { token: row.refresh_lease_token, expiresAt: Date.parse(row.refresh_lease_until) } : null };
}

export const createSupabaseAccountingStore = (options) => new SupabaseAccountingStore(options);
