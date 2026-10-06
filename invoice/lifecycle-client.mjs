const SUCCESS_ACTIONS = new Set(['capabilities', 'prepareDelete', 'confirmDelete', 'cancelDelete', 'undoDelete']);

const ERROR_MESSAGES = Object.freeze({
  SIGN_IN_REQUIRED: 'Sign in again before changing this invoice.',
  OWNER_REQUIRED: 'Only the workspace owner can delete or restore invoices.',
  INVOICE_NOT_FOUND: 'This invoice is no longer available. Refresh the ledger and try again.',
  ACTION_STALE: 'This invoice changed while you were reviewing it. Refresh the ledger and try again.',
  ACTION_EXPIRED: 'This confirmation expired. Open the invoice again to start over.',
  ACTION_PENDING: 'Another invoice change is waiting for confirmation. Finish or cancel it first.',
  FEATURE_UNAVAILABLE: 'Invoice deletion is temporarily unavailable. Refresh and try again.',
  CONFIRMATION_REQUIRED: 'Confirm the invoice change to continue.',
  EXACT_CONFIRMATION_REQUIRED: 'Type the exact confirmation shown to continue.',
  INVALID_CONFIRMATION: 'The typed confirmation does not match this invoice.',
  UNDO_EXPIRED: 'The 30-day recovery period has ended.',
  PROPOSAL_NOT_FOUND: 'This confirmation is no longer available. Open the invoice and start again.',
  ALREADY_DELETED: 'This invoice has already been deleted.',
  NOT_DELETED: 'This invoice is already active.',
  REPLAYED: 'This confirmation was already used. Refresh the ledger before trying again.',
  INVALID_REQUEST: 'The invoice change request was not valid. Refresh the ledger and try again.',
  INVOICE_AMBIGUOUS: 'More than one invoice matches that number. Open the exact invoice and try again.',
  DATABASE_UNAVAILABLE: 'Invoice recovery is temporarily unavailable. Refresh the ledger and try again.',
  DUPLICATE_INVOICE: 'This customer already has an active copy of this invoice. Review it before restoring another copy.',
});

export function createInvoiceLifecycleClient({
  accessToken,
  fetchImpl = globalThis.fetch,
  origin = globalThis.location?.origin || '',
  now = () => Date.now(),
  capabilityTtlMs = 10000,
} = {}) {
  if (typeof accessToken !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('accessToken and fetchImpl are required');
  const capabilities = new Map();

  async function request(action, payload = {}) {
    if (!SUCCESS_ACTIONS.has(action)) throw new TypeError('unsupported invoice lifecycle action');
    const workspaceId = String(payload.workspaceId || '');
    if (!workspaceId) throw new TypeError('workspaceId is required');
    const token = await accessToken();
    if (!token) throw new Error(ERROR_MESSAGES.SIGN_IN_REQUIRED);
    const body = {action, workspaceId};
    for (const key of ['invoiceId', 'proposalId', 'idempotencyKey', 'requestMessageId', 'confirmationMessageId', 'userMessage']) {
      if (payload[key] !== undefined) body[key] = payload[key];
    }
    const response = await fetchImpl(new URL('/api/invoice-lifecycle', origin || 'http://localhost').toString(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok !== true) {
      const code = String(result?.code || 'INVOICE_LIFECYCLE_FAILED');
      const error = new Error(ERROR_MESSAGES[code] || 'The invoice change could not be completed. Refresh the ledger and try again.');
      error.code = code;
      throw error;
    }
    return result;
  }

  return Object.freeze({
    request,
    async getCapabilities(workspaceId, {force = false} = {}) {
      const key = String(workspaceId || '');
      if (!key) return {available: false};
      const cached = capabilities.get(key);
      if (!force && cached && now() - cached.at < capabilityTtlMs) return cached.value;
      let value;
      try {
        const result = await request('capabilities', {workspaceId: key});
        value = {available: result.available === true};
      } catch {
        value = {available: false};
      }
      capabilities.set(key, {at: now(), value});
      return value;
    },
    clearCapabilities(workspaceId) {
      if (workspaceId) capabilities.delete(String(workspaceId));
      else capabilities.clear();
    },
  });
}
