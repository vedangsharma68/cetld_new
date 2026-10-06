export function createInvoiceCorrectionClient(db) {
  if (typeof db?.rpc !== 'function') throw new TypeError('Authenticated database client is required');
  return async ({workspaceId,invoiceId,expectedUpdatedAt,requestId,values}) => {
    const result = await db.rpc('owner_correct_invoice', {
      p_workspace_id:workspaceId,p_invoice_id:invoiceId,p_expected_updated_at:expectedUpdatedAt,
      p_request_id:requestId,p_values:values,
    });
    if (result.error) throw result.error;
    const receipt = result.data;
    if (receipt?.ok !== true || receipt.completed !== true || !receipt.record?.id || receipt.record.id !== invoiceId) {
      const messages = {
        INVALID_TOTAL:'The subtotal, tax, discount and item amounts must agree with the corrected total.',
        LEDGER_MISMATCH:'Recorded payments and reversals do not match this invoice balance. Reconcile them before correcting amounts.',
        PAYMENT_GUARD:'Payment history keeps the invoice currency, customer, number and direction fixed.',
        EXTERNAL_ACCOUNTING:'Correct financial details in the connected accounting ledger, then sync this invoice.',
        STALE:'This invoice changed. Refresh it and review the current values before trying again.',
        DELIVERY_IN_FLIGHT:'A reminder is sending or its delivery is uncertain. Resolve that delivery before correcting this invoice.',
        TERMINAL:'A deleted, void or cancelled invoice cannot be corrected.',
      };
      const error = new Error(receipt?.message || messages[receipt?.code] || 'The correction was not confirmed. Refresh the invoice and try again.');
      error.code = receipt?.code || 'CORRECTION_UNCONFIRMED';
      throw error;
    }
    return receipt;
  };
}
