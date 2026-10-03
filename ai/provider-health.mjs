import {createHash} from 'node:crypto';

const TABLE = 'ai_provider_health';
const ALLOWED_PROVIDERS = new Set(['cloudflare', 'google', 'openrouter', 'opencode-zen']);
const DEFAULT_TIMEOUT_MS = 250;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_LOCAL_ENTRIES = 256;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeIdentity({provider, model, accountFingerprint, credentialFingerprint} = {}) {
  if (!ALLOWED_PROVIDERS.has(provider)
    || typeof model !== 'string' || !model || model.length > 200
    || !/^[a-f0-9]{64}$/.test(accountFingerprint || '')
    || !/^[a-f0-9]{64}$/.test(credentialFingerprint || '')) return null;
  return {provider, model, accountFingerprint, credentialFingerprint};
}

function cacheKey(identity) {
  return `${identity.provider}:${identity.model}:${identity.accountFingerprint}:${identity.credentialFingerprint}`;
}

function epoch(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return typeof value === 'number' && parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function keepBounded(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_LOCAL_ENTRIES) map.delete(map.keys().next().value);
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error('response too large');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock?.(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
  const text = await response.text();
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('response too large');
  return text;
}

/** Build a provider/model identity without retaining any raw account or credential value. */
export function providerHealthIdentity({provider, model, accountId = '', credential = ''} = {}) {
  if (!ALLOWED_PROVIDERS.has(provider) || typeof model !== 'string' || !model || model.length > 200) return null;
  return {
    provider,
    model,
    accountFingerprint: sha256(`${provider}\0${accountId || 'default-account'}`),
    credentialFingerprint: sha256(`${provider}\0${credential || 'missing-credential'}`),
  };
}

/**
 * A bounded, fail-open Supabase REST store for provider quota cooldowns.
 * The table is intentionally accessible only with the service role. Database
 * outages never block provider execution; a short local breaker suppresses
 * repeated failed storage round trips.
 */
export function createProviderHealthStore({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  const rawUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let baseUrl = null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || (env.NODE_ENV === 'test' && parsed.hostname === 'localhost')) baseUrl = parsed.origin;
  } catch {}
  const enabled = Boolean(baseUrl && typeof serviceKey === 'string' && serviceKey && typeof fetchImpl === 'function');
  const entries = new Map();
  let storageUnavailableUntil = 0;

  function logStorageFailure(operation) {
    try { logger?.warn?.('AI provider health storage unavailable:', {operation, table: TABLE}); } catch {}
  }

  async function request(url, init = {}) {
    if (!enabled || now() < storageUnavailableUntil) return null;
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: 'error',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))),
      });
      if (!response?.ok) throw new Error('storage request failed');
      return response;
    } catch {
      storageUnavailableUntil = now() + 5000;
      logStorageFailure(init.method || 'GET');
      return null;
    }
  }

  return Object.freeze({
    enabled,
    async getUnavailableUntil(rawIdentity) {
      const identity = safeIdentity(rawIdentity);
      if (!identity) return null;
      const key = cacheKey(identity);
      const timestamp = now();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > timestamp) return cached.until > timestamp ? cached.until : null;
      if (cached) entries.delete(key);
      if (!enabled || timestamp < storageUnavailableUntil) return null;

      const query = new URLSearchParams({
        provider: `eq.${identity.provider}`,
        model: `eq.${identity.model}`,
        account_fingerprint: `eq.${identity.accountFingerprint}`,
        credential_fingerprint: `eq.${identity.credentialFingerprint}`,
        select: 'disabled_until',
        limit: '1',
      });
      const response = await request(`${baseUrl}/rest/v1/${TABLE}?${query}`);
      if (!response) return null;
      let text;
      try {
        text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      } catch {
        storageUnavailableUntil = now() + 5000;
        logStorageFailure('GET');
        return null;
      }
      let rows;
      try { rows = JSON.parse(text); } catch {
        storageUnavailableUntil = now() + 5000;
        logStorageFailure('GET');
        return null;
      }
      const until = Array.isArray(rows) ? epoch(rows[0]?.disabled_until) : null;
      if (until && until > now()) {
        keepBounded(entries, key, {until, expiresAt: until});
        return until;
      }
      keepBounded(entries, key, {until: 0, expiresAt: now() + 1000});
      return null;
    },

    async markUnavailable(rawIdentity, {disabledUntil, reason = 'quota_exceeded'} = {}) {
      const identity = safeIdentity(rawIdentity);
      const until = epoch(disabledUntil);
      if (!identity || reason !== 'quota_exceeded' || !until || until <= now()) return false;
      const key = cacheKey(identity);
      keepBounded(entries, key, {until, expiresAt: until});
      if (!enabled || now() < storageUnavailableUntil) return false;
      const query = new URLSearchParams({on_conflict: 'provider,model,account_fingerprint,credential_fingerprint'});
      const row = {
        provider: identity.provider,
        model: identity.model,
        account_fingerprint: identity.accountFingerprint,
        credential_fingerprint: identity.credentialFingerprint,
        disabled_until: new Date(until).toISOString(),
        updated_at: new Date(now()).toISOString(),
      };
      const response = await request(`${baseUrl}/rest/v1/${TABLE}?${query}`, {
        method: 'POST',
        headers: {Prefer: 'resolution=merge-duplicates,return=minimal'},
        body: JSON.stringify(row),
      });
      return Boolean(response);
    },
  });
}
