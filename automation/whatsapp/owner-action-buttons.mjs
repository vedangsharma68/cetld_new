import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

const PREFIX = 'oab1';
const MAX_BUTTONS = 3;
const MAX_BUTTON_ID_BYTES = 256;
const MAX_BUTTON_TITLE_LENGTH = 20;
const PHONE = /^\+[1-9]\d{6,14}$/;
const BUTTON_ACTION_TYPES = new Set([
  'owner_invoice_delete_proposal', 'owner_workspace_data_change', 'owner_invoice_create',
  'owner_settings_update', 'owner_invoice_update', 'owner_invoice_payment',
  'owner_invoice_reopen',
]);
const TRANSIENT_ACTION_FIELDS = new Set(['createdAt', 'requestedAt', 'sourceMessageId', 'requestMessageId']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort()
      .filter(key => !TRANSIENT_ACTION_FIELDS.has(key))
      .map(key => [key, canonical(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function secretFromEnv(env) {
  const secret = env?.WHATSAPP_APP_SECRET || env?.CRON_SECRET;
  return typeof secret === 'string' && secret.length ? secret : null;
}

function normalizedScope(scope) {
  const workspaceId = typeof scope?.workspaceId === 'string' ? scope.workspaceId : '';
  const phone = typeof scope?.phone === 'string' ? scope.phone : '';
  if (!workspaceId || workspaceId.length > 128 || !PHONE.test(phone)) return null;
  return {workspaceId, phone};
}

function normalizedPendingAction(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const pendingId = record.id;
  const version = Number(record.version);
  const action = record.action && typeof record.action === 'object' && !Array.isArray(record.action)
    ? record.action : null;
  const expiresAt = action?.expiresAt ?? record.expiresAt ?? record.expires_at;
  const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if ((typeof pendingId !== 'string' && typeof pendingId !== 'number') || !String(pendingId).trim()
      || String(pendingId).length > 128 || !Number.isSafeInteger(version) || version < 1
      || !action || !BUTTON_ACTION_TYPES.has(action.type)
      || !Number.isFinite(expiresAtMs)) return null;
  const fingerprintInput = {
    id: String(pendingId),
    version,
    action: canonical(action),
    proposalId: action.proposalId ?? null,
    expectedUpdatedAt: action.expectedUpdatedAt ?? null,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest().subarray(0, 24).toString('base64url');
  return {fingerprint, expiresAtMs};
}

export function isOwnerActionButtonSupported(record) {
  return Boolean(record?.action && BUTTON_ACTION_TYPES.has(record.action.type));
}

function currentTime(clock) {
  try {
    const value = typeof clock === 'function' ? clock() : Date.now();
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : NaN;
  } catch { return NaN; }
}

function title(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (!clean || /[\u0000-\u001f\u007f-\u009f]/u.test(clean) || Array.from(clean).length > MAX_BUTTON_TITLE_LENGTH) return null;
  return clean;
}

export function normalizeOwnerActionButtons(buttons) {
  if (buttons === undefined || buttons === null) return [];
  if (!Array.isArray(buttons) || buttons.length > MAX_BUTTONS) throw new TypeError('owner buttons must contain at most three replies');
  const ids = new Set();
  return buttons.map(button => {
    const id = button?.id;
    const cleanTitle = title(button?.title);
    if (typeof id !== 'string' || !id.trim() || Buffer.byteLength(id, 'utf8') > MAX_BUTTON_ID_BYTES
        || /[\u0000-\u001f\u007f-\u009f]/u.test(id) || ids.has(id) || !cleanTitle) {
      throw new TypeError('invalid owner reply button');
    }
    ids.add(id);
    return {id, title: cleanTitle};
  });
}

function referenceFor({scope, action, decision, env, clock}) {
  const secret = secretFromEnv(env);
  const binding = normalizedScope(scope);
  const current = normalizedPendingAction(action);
  const now = currentTime(clock);
  if (!secret || !binding || !current || !Number.isFinite(now) || current.expiresAtMs <= now) return null;
  const payload = Buffer.from(JSON.stringify({v: 1, f: current.fingerprint, d: decision, e: current.expiresAtMs})).toString('base64url');
  const signed = `${PREFIX}.${payload}`;
  const signature = createHmac('sha256', secret).update(`${PREFIX}\n${binding.workspaceId}\n${binding.phone}\n${signed}`).digest('base64url');
  const id = `${signed}.${signature}`;
  return Buffer.byteLength(id, 'utf8') <= MAX_BUTTON_ID_BYTES ? id : null;
}

export function createOwnerActionButtons({scope, action, env = process.env, clock = () => new Date(),
  confirmTitle = 'Confirm', cancelTitle = 'Cancel'} = {}) {
  const confirm = title(action?.action?.type==='owner_invoice_reopen'?'Reopen invoice':confirmTitle);
  const cancel = title(action?.action?.type==='owner_invoice_reopen'?'Keep payments':cancelTitle);
  if (!confirm || !cancel) return [];
  const confirmId = referenceFor({scope, action, decision: 'confirm', env, clock});
  const cancelId = referenceFor({scope, action, decision: 'cancel', env, clock});
  if (!confirmId || !cancelId) return [];
  try { return normalizeOwnerActionButtons([{id: confirmId, title: confirm}, {id: cancelId, title: cancel}]); }
  catch { return []; }
}

export function verifyOwnerActionButton({id, scope, action, env = process.env, clock = () => new Date()} = {}) {
  const invalid = {decision: null, valid: false};
  const secret = secretFromEnv(env);
  const binding = normalizedScope(scope);
  const current = normalizedPendingAction(action);
  const now = currentTime(clock);
  if (!secret || !binding || !current || !Number.isFinite(now) || current.expiresAtMs <= now
      || typeof id !== 'string' || Buffer.byteLength(id, 'utf8') > MAX_BUTTON_ID_BYTES) return invalid;
  const parts = id.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1])
      || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return invalid;
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(`${PREFIX}\n${binding.workspaceId}\n${binding.phone}\n${signed}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
      || actual.toString('base64url') !== parts[2]) return invalid;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { return invalid; }
  if (payload?.v !== 1 || !['confirm', 'cancel'].includes(payload?.d)
      || payload.f !== current.fingerprint || payload.e !== current.expiresAtMs
      || payload.e <= now) return invalid;
  return {decision: payload.d, valid: true};
}
