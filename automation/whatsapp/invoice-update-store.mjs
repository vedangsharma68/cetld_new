/** Service-role backing for test-only, at-most-once invoice update sends. */
export function createWhatsAppInvoiceUpdateStore({supabase} = {}) {
  if (!supabase?.from || !supabase?.rpc) throw new TypeError('A server-side Supabase client is required');
  return Object.freeze({
    invoiceStore: {
      async getCurrentInvoice({workspaceId, invoiceId}) {
        const {data, error} = await supabase.from('invoices')
          .select('id,workspace_id,customer_id,invoice_number,status,updated_at')
          .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle();
        if (error) throw error;
        return data ? {workspaceId: data.workspace_id, customerId: data.customer_id,
          invoiceNumber: data.invoice_number, status: data.status, updatedAt: data.updated_at} : null;
      },
    },
    async claimInvoiceUpdate({workspaceId, invoiceId, customerId, phone, idempotencyKey, expectedUpdatedAt}) {
      const {data, error} = await supabase.rpc('whatsapp_claim_invoice_update', {
        p_workspace_id: workspaceId, p_invoice_id: invoiceId,
        p_customer_id: customerId, p_phone: phone,
        p_idempotency_key: idempotencyKey, p_expected_updated_at: expectedUpdatedAt,
      });
      if (error) throw error;
      return {claimed: data === true};
    },
  });
}
