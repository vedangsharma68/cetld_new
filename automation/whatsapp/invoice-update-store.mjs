import {createDeletedAtCompatibility} from '../../invoice/deleted-at-compat.mjs';

/** Service-role backing for test-only, at-most-once invoice update sends. */
export function createWhatsAppInvoiceUpdateStore({supabase} = {}) {
  if (!supabase?.from || !supabase?.rpc) throw new TypeError('A server-side Supabase client is required');
  const deletedAtCompatibility=createDeletedAtCompatibility();
  async function readCurrentInvoice({workspaceId,invoiceId},includeDeletedAt){
    const select=includeDeletedAt?'id,workspace_id,customer_id,invoice_number,status,updated_at,deleted_at':'id,workspace_id,customer_id,invoice_number,status,updated_at';
    let query=supabase.from('invoices').select(select).eq('workspace_id',workspaceId).eq('id',invoiceId);
    if(includeDeletedAt)query=query.is('deleted_at',null);
    const {data,error}=await query.maybeSingle();
    if(error)throw error;
    return data?[data]:[];
  }
  const invoiceStore={
    async getCurrentInvoice(input) {
      const [data]=await deletedAtCompatibility.read({withDeletedAt:()=>readCurrentInvoice(input,true),legacy:()=>readCurrentInvoice(input,false)});
      return data&&!data.deleted_at?{workspaceId:data.workspace_id,customerId:data.customer_id,
        invoiceNumber:data.invoice_number,status:data.status,updatedAt:data.updated_at}:null;
    },
  };
  return Object.freeze({
    invoiceStore,
    async claimInvoiceUpdate({workspaceId, invoiceId, customerId, phone, idempotencyKey, expectedUpdatedAt}) {
      // Re-read the scoped row directly before the claim RPC. A deleted invoice
      // cannot turn a stale preview into a test-template send.
      const current=await invoiceStore.getCurrentInvoice({workspaceId,invoiceId});
      if(!current||current.workspaceId!==workspaceId||current.customerId!==customerId||current.updatedAt!==expectedUpdatedAt)return {claimed:false};
      const {data, error} = await supabase.rpc('whatsapp_claim_logged_invoice_update', {
        p_workspace_id: workspaceId, p_invoice_id: invoiceId,
        p_customer_id: customerId, p_phone: phone,
        p_idempotency_key: idempotencyKey, p_expected_updated_at: expectedUpdatedAt,
      });
      if (error) throw error;
      return {claimed: data === true};
    },
  });
}
