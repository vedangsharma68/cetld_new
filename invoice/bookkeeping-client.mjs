import {isTestInvoice} from '../automation/test-invoice.mjs';

export function isUnconfiguredBookkeeping(invoice){
 const m=invoice.metadata||invoice;
 const error=invoice.bookkeeping_sync_error??m.bookkeeping_sync_error;
 return (invoice.bookkeeping_sync_status||m.bookkeeping_sync_status||'not_configured')==='not_configured'
  && (!error||error==='ACCOUNTING_NOT_CONNECTED')
  && !invoice.external_invoice_id&&!invoice.bookkeeping_record_id&&!m.bookkeeping_record_id
  && !invoice.bookkeeping_provider&&!m.bookkeeping_provider&&!Number(m.bookkeeping_sync_attempts||0);
}
export function bookkeepingSyncLabel(invoice){
 const status=invoice.bookkeeping_sync_status||invoice.metadata?.bookkeeping_sync_status||'not_configured';
 return ({not_configured:'Not connected',pending:'Sync pending',failed:'Sync failed',synced:'Synced'})[status]||'Sync unavailable';
}
export function showBookkeepingSyncError(invoice){return Boolean(invoice.bookkeeping_sync_error||invoice.metadata?.bookkeeping_sync_error)&&!isUnconfiguredBookkeeping(invoice);}

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
  if(sync?.status==='not_configured')return 'Invoice saved. Bookkeeping is not connected. Connect it in Connections when you are ready.';
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
