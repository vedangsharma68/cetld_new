import {readJSON} from './http.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_-]{12,120}$/;
const PHONE_RE = /^\+[1-9][0-9]{7,14}$/;
const MESSAGE_ID_RE = /^[^\s\x00-\x1f]{1,256}$/;
const SUCCESS_ACTIONS = new Set(['proposal_created', 'proposal_loaded', 'deleted', 'cancelled', 'restored', 'capabilities']);
const SAFE_CODES = new Set([
  'INVALID_REQUEST', 'OWNER_REQUIRED', 'FEATURE_UNAVAILABLE', 'INVOICE_NOT_FOUND',
  'PROPOSAL_NOT_FOUND', 'ACTION_PENDING', 'ACTION_EXPIRED', 'ACTION_STALE',
  'CONFIRMATION_REQUIRED', 'EXACT_CONFIRMATION_REQUIRED', 'INVALID_CONFIRMATION',
  'ALREADY_DELETED', 'NOT_DELETED', 'UNDO_EXPIRED', 'INVOICE_AMBIGUOUS', 'REPLAYED', 'DATABASE_UNAVAILABLE',
]);

function fail(code) {
  return {ok: false, code: SAFE_CODES.has(code) ? code : 'DATABASE_UNAVAILABLE'};
}

function mapRpcError(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (['PGRST202', 'PGRST204', '42883', '42P01', '42703'].includes(code) || status === 404) return 'FEATURE_UNAVAILABLE';
  if (code === '42501' || status === 401 || status === 403) return 'OWNER_REQUIRED';
  if (code === '23505') return 'ACTION_PENDING';
  if (code === '22023' || code === '23514') return 'INVALID_REQUEST';
  return status >= 500 || !status ? 'DATABASE_UNAVAILABLE' : 'INVALID_REQUEST';
}

function safeSuccess(value) {
  const row = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  if (typeof row === 'string') {
    try { return safeSuccess(JSON.parse(row)); } catch { return fail('DATABASE_UNAVAILABLE'); }
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('DATABASE_UNAVAILABLE');
  if (row.ok !== true) return fail(typeof row.code === 'string' ? row.code : row.reason);
  if (!SUCCESS_ACTIONS.has(row.action)) return fail('DATABASE_UNAVAILABLE');
  const result = {ok: true, action: row.action};
  for (const key of ['proposalId', 'invoiceId']) {
    if (typeof row[key] === 'string' && UUID_RE.test(row[key])) result[key] = row[key].toLowerCase();
  }
  for (const key of ['invoiceNumber', 'customerName', 'currency', 'status']) {
    if (typeof row[key] === 'string' && row[key].length <= 255) result[key] = row[key];
  }
  if ((typeof row.totalAmount === 'string' && /^\d{1,16}(?:\.\d{1,2})?$/.test(row.totalAmount))
    || (typeof row.totalAmount === 'number' && Number.isFinite(row.totalAmount) && row.totalAmount >= 0)) {
    result.totalAmount = row.totalAmount;
  }
  if (typeof row.expiresAt === 'string' && Number.isFinite(Date.parse(row.expiresAt))) result.expiresAt = row.expiresAt;
  if (typeof row.expectedUpdatedAt === 'string' && Number.isFinite(Date.parse(row.expectedUpdatedAt))) result.expectedUpdatedAt = row.expectedUpdatedAt;
  if (typeof row.requiresExactConfirmation === 'boolean') result.requiresExactConfirmation = row.requiresExactConfirmation;
  if (row.action === 'capabilities') result.available = row.available === true;
  if (typeof row.pending === 'boolean') result.pending = row.pending;
  if (row.replayed === true) result.replayed = true;
  return result;
}

function normalizeActor(actor) {
  if (actor?.kind === 'verified_owner_phone' && typeof actor.phone === 'string' && PHONE_RE.test(actor.phone)) {
    return {kind: actor.kind, phone: actor.phone};
  }
  if (actor?.kind === 'authenticated_owner' && typeof actor.userId === 'string' && UUID_RE.test(actor.userId)) {
    return {kind: actor.kind, userId: actor.userId.toLowerCase()};
  }
  return null;
}

function validMessage(value, {optional = false} = {}) {
  if (value == null && optional) return null;
  return typeof value === 'string' && value.length <= 4000 ? value : undefined;
}

function validMessageId(value, {optional = false} = {}) {
  if (value == null && optional) return null;
  return typeof value === 'string' && MESSAGE_ID_RE.test(value) ? value : undefined;
}

/**
 * Build the shared invoice lifecycle API. The supplied RPC must execute in the
 * caller's authority context: authenticated-owner calls use that owner's JWT;
 * verified-owner calls use service_role plus the verified sender phone. Never
 * pass a model-generated owner id as authorization context.
 */
export function createInvoiceLifecycleService({rpc} = {}) {
  if (typeof rpc !== 'function') throw new TypeError('rpc must be a function');

  async function invoke({action, workspaceId, actor, invoiceId, invoiceNumber, proposalId, idempotencyKey, userMessage, requestMessageId, confirmationMessageId}) {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) return fail('INVALID_REQUEST');
    const normalizedActor = normalizeActor(actor);
    if (!normalizedActor) return fail('OWNER_REQUIRED');
    const message = validMessage(userMessage, {optional: true});
    if (message === undefined) return fail('INVALID_REQUEST');
    const reqMessageId = validMessageId(requestMessageId, {optional: true});
    if (reqMessageId === undefined) return fail('INVALID_REQUEST');
    const confirmMessageId = validMessageId(confirmationMessageId, {optional: true});
    if (confirmMessageId === undefined) return fail('INVALID_REQUEST');

    if (invoiceId != null && (typeof invoiceId !== 'string' || !UUID_RE.test(invoiceId))) return fail('INVALID_REQUEST');
    if (invoiceNumber != null && (typeof invoiceNumber !== 'string' || invoiceNumber.length < 1 || invoiceNumber.length > 100 || /[\x00-\x1f]/.test(invoiceNumber))) return fail('INVALID_REQUEST');
    if (proposalId != null && (typeof proposalId !== 'string' || !UUID_RE.test(proposalId))) return fail('INVALID_REQUEST');
    if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !KEY_RE.test(idempotencyKey))) return fail('INVALID_REQUEST');

    if (action === 'prepare' && (!invoiceId || !idempotencyKey)) return fail('INVALID_REQUEST');
    if (action === 'confirm' && (!proposalId || !message || !confirmMessageId)) return fail('INVALID_REQUEST');
    if (action === 'cancel' && !proposalId) return fail('INVALID_REQUEST');
    if (action === 'undo' && ((!invoiceId && !invoiceNumber) || (invoiceId && invoiceNumber) || !idempotencyKey)) return fail('INVALID_REQUEST');

    const params = {
      p_action: action,
      p_workspace_id: workspaceId.toLowerCase(),
      p_invoice_id: invoiceId?.toLowerCase() || null,
      p_invoice_number: invoiceNumber || null,
      p_proposal_id: proposalId?.toLowerCase() || null,
      p_phone: normalizedActor.kind === 'verified_owner_phone' ? normalizedActor.phone : null,
      p_idempotency_key: idempotencyKey || null,
      p_user_message: message,
      p_request_message_id: reqMessageId,
      p_confirmation_message_id: confirmMessageId,
    };
    try {
      const response = await rpc('invoice_lifecycle_action', params);
      if (response?.error) return fail(mapRpcError(response.error));
      return safeSuccess(response?.data ?? response);
    } catch (error) {
      return fail(mapRpcError(error));
    }
  }

  return Object.freeze({
    capabilities: ({workspaceId, actor}) => invoke({action: 'capabilities', workspaceId, actor}),
    loadPendingDelete: ({workspaceId, actor}) => invoke({action: 'pending', workspaceId, actor}),
    prepareDelete: ({workspaceId, invoiceId, actor, userMessage, requestMessageId, idempotencyKey}) => invoke({action: 'prepare', workspaceId, invoiceId, actor, userMessage, requestMessageId, idempotencyKey}),
    confirmDelete: ({workspaceId, proposalId, actor, userMessage, confirmationMessageId}) => invoke({action: 'confirm', workspaceId, proposalId, actor, userMessage, confirmationMessageId}),
    cancelDelete: ({workspaceId, proposalId, actor, userMessage, requestMessageId, confirmationMessageId}) => invoke({action: 'cancel', workspaceId, proposalId, actor, userMessage, requestMessageId, confirmationMessageId}),
    undoDelete: ({workspaceId, invoiceId, invoiceNumber, actor, userMessage, requestMessageId, idempotencyKey}) => invoke({action: 'undo', workspaceId, invoiceId, invoiceNumber, actor, userMessage, requestMessageId, idempotencyKey}),
  });
}

/** REST RPC adapter shared by the authenticated dashboard and verified WhatsApp owner flows. */
export function createRestRpcAdapter({url, apiKey, authorization, fetchImpl = fetch} = {}) {
  let base;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) throw new Error();
    base = parsed.origin;
  } catch {
    return async () => { throw {code: 'INVALID_CONFIGURATION', status: 503}; };
  }
  if (typeof apiKey !== 'string' || !apiKey || typeof authorization !== 'string' || !/^Bearer [^\s]{10,16384}$/.test(authorization)) {
    return async () => { throw {code: 'INVALID_CONFIGURATION', status: 503}; };
  }

  return async (functionName, args) => {
    if (functionName !== 'invoice_lifecycle_action') throw {code: 'INVALID_REQUEST', status: 400};
    let response;
    try {
      response = await fetchImpl(`${base}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        redirect: 'error',
        headers: {apikey: apiKey, Authorization: authorization, 'Content-Type': 'application/json'},
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw {code: 'DATABASE_UNAVAILABLE', status: 503};
    }
    if (!response.ok) {
      let error = {};
      try { error = await readJSON(response); } catch {}
      throw {code: error.code || (response.status === 404 ? 'PGRST202' : 'HTTP_ERROR'), status: response.status};
    }
    try { return await readJSON(response); }
    catch { throw {code: 'INVALID_RESPONSE', status: 502}; }
  };
}
