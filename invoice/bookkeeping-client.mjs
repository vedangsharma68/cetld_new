import {isTestInvoice} from '../automation/test-invoice.mjs';

export function canRetryInvoiceSync(invoice, connected) {
  if (isTestInvoice(invoice)) return false;
  const status=invoice.bookkeeping_sync_status || invoice.metadata?.bookkeeping_sync_status || 'not_configured';
  return !invoice.external_invoice_id && !invoice.bookkeeping_record_id && !invoice.metadata?.bookkeeping_record_id && (invoice.invoice_direction || invoice.metadata?.invoice_direction) !== 'payable' && !invoice.deleted_at && !['void','cancelled'].includes(invoice.status)
    && (['pending','failed'].includes(status) || status==='not_configured' && connected);
}
export function invoiceSyncMessage(sync, metadata={}) {
  if (isTestInvoice({metadata})) return 'Test invoice. Permanently excluded from accounting exports.';
  if(sync?.status==='synced')return 'Bookkeeping sync completed.';
  if(metadata.bookkeeping_sync_exhausted)return 'Automatic sync stopped after five attempts. Check the connection, then retry after the waiting period.';
  if(sync?.status==='not_configured')return 'Zoho Books is not connected or invoice export is unavailable.';
  return 'Invoice saved. Bookkeeping sync is waiting for retry.';
}
export async function retryInvoiceBookkeeping({request,workspaceId,invoiceId,idempotencyKey=crypto.randomUUID()}) {
  return request('retry-invoice-sync',{body:{workspaceId,invoiceId,idempotencyKey}});
}
// Saving and syncing are separate: a sync outage must never report an invoice
// insert as failed (which could lead the owner to create a duplicate).
export async function syncCreatedInvoice(options) {
  try { return await retryInvoiceBookkeeping(options); }
  catch { return {sync:{status:'pending',retryable:true}}; }
}
