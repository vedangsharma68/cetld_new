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
      const error = new Error(receipt?.message || 'The correction was not confirmed. Refresh the invoice and try again.');
      error.code = receipt?.code || 'CORRECTION_UNCONFIRMED';
      throw error;
    }
    return receipt;
  };
}
