const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS = {
  OWNER_REQUIRED: 'Only the business owner can create a test invoice.',
  TEST_RECIPIENT_REQUIRED: 'Add Pappa with phone +919818685252 before creating this test invoice.',
  TEST_RECIPIENT_AMBIGUOUS: 'More than one Pappa contact matches +919818685252. Resolve the duplicate before creating this test invoice.',
  FEATURE_UNAVAILABLE: 'Test invoices are waiting for the database update.',
};

export function createTestInvoiceClient({accessToken, fetchImpl = globalThis.fetch} = {}) {
  return async ({workspaceId, idempotencyKey}) => {
    if (!UUID.test(workspaceId) || !UUID.test(idempotencyKey)) throw Error('The test invoice request is invalid.');
    const token = await accessToken();
    if (!token) throw Error('Sign in again to create this test invoice.');
    const response = await fetchImpl('/api/invoice-lifecycle', {
      method: 'POST', credentials: 'same-origin',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'createTestInvoice', workspaceId, idempotencyKey}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw Error(ERRORS[result.code] || 'The test invoice could not be created. Try again.');
    if (!UUID.test(result.invoiceId) || typeof result.invoiceNumber !== 'string' || !result.invoiceNumber.startsWith('CETLD-TEST-')) {
      throw Error('The server could not confirm the test invoice. Try again.');
    }
    return result;
  };
}

export function createTestInvoiceUI({state, request, openDialog, dialog, loadData, detail, button, toast, showError, requestId = () => crypto.randomUUID()} = {}) {
  let pending = null, saving = false;
  const canCreate = () => !state.demo && !!state.user?.id && state.workspace?.owner_id === state.user.id;
  return Object.freeze({
    canCreate,
    entry() {
      return canCreate() ? `<section class="form-section"><h3>Test a reminder</h3><p>Create a clearly marked ₹1 test invoice for Pappa. No payment is required.</p>${button('new-test-invoice','Create test invoice','small')}</section>` : '';
    },
    review() {
      if (!canCreate() || saving) return false;
      pending = {workspaceId: state.workspace.id, idempotencyKey: requestId()};
      openDialog('Create test invoice', `<div class="dialog-body"><p><strong>TEST · No payment required</strong></p><dl class="detail-facts"><div><dt>Recipient</dt><dd>Pappa · +919818685252</dd></div><div><dt>Amount</dt><dd>INR 1</dd></div></dl><p>The invoice is permanently excluded from accounting exports. The reminder will visibly include TEST and NO PAYMENT REQUIRED.</p><p>Creation does not send a message. Open the usual reminder preview and approve it before delivery. Existing consent and delivery requirements still apply.</p><div class="error hidden" data-error role="alert"></div></div><div class="dialog-foot">${button('close','Cancel')}${button('create-test-invoice','Create test invoice','primary')}</div>`);
      return true;
    },
    async create(control) {
      if (!canCreate() || !pending || pending.workspaceId !== state.workspace.id || saving) return false;
      saving = true;
      if (control) control.disabled = true;
      const current = pending;
      try {
        const result = await request(current);
        pending = null;
        if (!canCreate() || state.workspace.id !== current.workspaceId) return true;
        dialog().close();
        const loaded = await loadData();
        if (loaded && state.invoices.some(invoice => invoice.id === result.invoiceId)) detail(result.invoiceId);
        toast(loaded ? 'Test invoice created. Review and approve its reminder before delivery.' : `Test invoice ${result.invoiceNumber} was created. Refresh the ledger to open it.`);
        return true;
      } catch (error) {
        showError(dialog(), error);
        return false;
      } finally {
        saving = false;
        if (control) control.disabled = false;
      }
    },
  });
}
