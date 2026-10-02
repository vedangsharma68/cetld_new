import {APIError, requestBody} from '../ai/http.mjs';
import {authorizeAIWorkspace} from '../ai/store.mjs';
import {createInvoiceLifecycleService, createRestRpcAdapter} from '../ai/invoice-lifecycle.mjs';
import {config} from '../config.js';

const ACTION_FIELDS = ['action', 'workspaceId', 'invoiceId', 'invoiceNumber', 'proposalId', 'idempotencyKey', 'requestMessageId', 'confirmationMessageId', 'userMessage'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_STATUS = {
  INVALID_REQUEST: 400,
  OWNER_REQUIRED: 403,
  FEATURE_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
  INVOICE_NOT_FOUND: 404,
  INVOICE_AMBIGUOUS: 409,
  PROPOSAL_NOT_FOUND: 404,
  ACTION_PENDING: 409,
  ACTION_EXPIRED: 410,
  ACTION_STALE: 409,
  CONFIRMATION_REQUIRED: 400,
  EXACT_CONFIRMATION_REQUIRED: 400,
  INVALID_CONFIRMATION: 400,
  ALREADY_DELETED: 409,
  NOT_DELETED: 409,
  UNDO_EXPIRED: 410,
  REPLAYED: 409,
};

function send(res, body, status = body.ok ? 200 : (HTTP_STATUS[body.code] || 503)) {
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, {ok: false, code: 'INVALID_REQUEST'}, 405);
  let body;
  try { body = requestBody(req, ACTION_FIELDS, 8192); }
  catch (error) {
    return send(res, {ok: false, code: error instanceof APIError ? 'INVALID_REQUEST' : 'INVALID_REQUEST'}, error?.status || 400);
  }
  if (!['capabilities', 'pendingDelete', 'prepareDelete', 'confirmDelete', 'cancelDelete', 'undoDelete'].includes(body.action)
    || typeof body.workspaceId !== 'string' || !UUID_RE.test(body.workspaceId)) {
    return send(res, {ok: false, code: 'INVALID_REQUEST'}, 400);
  }

  try {
    const env = {
      ...process.env,
      SUPABASE_URL: process.env.SUPABASE_URL || config.url,
      SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || config.key,
    };
    const store = await authorizeAIWorkspace(req, body.workspaceId, {env});
    if (store.role !== 'owner') return send(res, {ok: false, code: 'OWNER_REQUIRED'}, 403);
    const rpc = createRestRpcAdapter({
      url: env.SUPABASE_URL,
      apiKey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: req.headers?.authorization,
    });
    const lifecycle = createInvoiceLifecycleService({rpc});
    const actor = {kind: 'authenticated_owner', userId: store.userId};
    let result;
    switch (body.action) {
      case 'capabilities':
        result = await lifecycle.capabilities({workspaceId: body.workspaceId, actor});
        if (result.code === 'FEATURE_UNAVAILABLE') return send(res, {ok: true, action: 'capabilities', available: false});
        if (result.ok) result = {...result, available: true};
        break;
      case 'pendingDelete':
        result = await lifecycle.loadPendingDelete({workspaceId: body.workspaceId, actor});
        break;
      case 'prepareDelete':
        result = await lifecycle.prepareDelete({workspaceId: body.workspaceId, invoiceId: body.invoiceId, actor,
          userMessage: body.userMessage, requestMessageId: body.requestMessageId, idempotencyKey: body.idempotencyKey});
        break;
      case 'confirmDelete':
        result = await lifecycle.confirmDelete({workspaceId: body.workspaceId, proposalId: body.proposalId, actor,
          userMessage: body.userMessage, confirmationMessageId: body.confirmationMessageId});
        break;
      case 'cancelDelete':
        result = await lifecycle.cancelDelete({workspaceId: body.workspaceId, proposalId: body.proposalId, actor,
          userMessage: body.userMessage, requestMessageId: body.requestMessageId, confirmationMessageId: body.confirmationMessageId});
        break;
      case 'undoDelete':
        result = await lifecycle.undoDelete({workspaceId: body.workspaceId, invoiceId: body.invoiceId, invoiceNumber: body.invoiceNumber, actor,
          userMessage: body.userMessage, requestMessageId: body.requestMessageId, idempotencyKey: body.idempotencyKey});
        break;
    }
    return send(res, result);
  } catch (error) {
    if (error instanceof APIError) {
      const status = error.status === 401 || error.status === 403 ? 403 : error.status === 400 ? 400 : 503;
      return send(res, {ok: false, code: status === 403 ? 'OWNER_REQUIRED' : status === 400 ? 'INVALID_REQUEST' : 'DATABASE_UNAVAILABLE'}, status);
    }
    return send(res, {ok: false, code: 'DATABASE_UNAVAILABLE'}, 503);
  }
}
