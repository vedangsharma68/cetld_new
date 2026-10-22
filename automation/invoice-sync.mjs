import {providerDiagnostics} from './accounting/errors.mjs';
import {APIError} from '../ai/http.mjs';
export function deadlineFetch(fetchImpl, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return (url, options={}) => fetchImpl(url,{...options,signal:options.signal?AbortSignal.any([deadline,options.signal]):deadline});
}
// One retry policy for assistant saves, dashboard retries and the scheduled sweep.
export const MAX_SYNC_ATTEMPTS = 5;
export const SYNC_LEASE_MS = 10 * 60_000;
export function syncRetryDelay(attempt) { return Math.min(6 * 3600_000, 5 * 60_000 * 2 ** Math.max(0, attempt - 1)); }
function attemptCount(metadata) {
  const value=Number(metadata?.bookkeeping_sync_attempts || 0);
  return Number.isSafeInteger(value) && value>=0 ? value : MAX_SYNC_ATTEMPTS;
}
export function assertInvoiceSyncScope(store, row) {
  if (!store.workspaceId || row?.workspace_id !== store.workspaceId) throw new APIError(502,'WORKSPACE_SCOPE_VIOLATION');
}
export function syncEligibility(row, now = Date.now()) {
  const m = row.metadata || {};
  if (row.deleted_at || ['void','cancelled'].includes(row.status) || m.invoice_direction === 'payable') return 'excluded';
  if (row.external_invoice_id || m.bookkeeping_record_id || m.bookkeeping_sync_status === 'synced') return 'synced';
  if (Date.parse(m.bookkeeping_sync_next_at) > now) return 'waiting';
  if (attemptCount(m) >= MAX_SYNC_ATTEMPTS) return 'exhausted';
  return 'ready';
}
export async function syncInvoiceRow({store, row, invoice, accounting, clock = () => new Date(), manualRetry = false}) {
  assertInvoiceSyncScope(store,row);
  const now = clock().getTime();
  let eligibility = invoice.direction==='payable' ? 'excluded' : syncEligibility(row, now);
  if (eligibility === 'exhausted' && manualRetry) eligibility = 'ready';
  const result = (saved, status, retryable = false) => ({row:saved, sync:{status,provider:saved.metadata?.bookkeeping_provider || null,retryable}});
  if (eligibility === 'synced') return {row,sync:{status:'synced',provider:row.external_provider || row.metadata?.bookkeeping_provider || null,externalId:row.external_invoice_id || row.metadata?.bookkeeping_record_id,retryable:false}};
  if (eligibility === 'waiting') return result(row, row.metadata?.bookkeeping_sync_status || 'pending', true);
  async function updateState(metadata, fields={}) {
    if (store.claimInvoiceSync) return await store.claimInvoiceSync(row,metadata,fields) || row;
    return store.updateAssistantInvoiceMetadata(row.id,metadata,fields);
  }
  if (eligibility === 'excluded' && invoice.direction !== 'payable') return result(row,row.metadata?.bookkeeping_sync_status || 'not_configured');
  if (eligibility === 'exhausted') {
    const saved = await updateState({...row.metadata,bookkeeping_sync_status:'failed',bookkeeping_sync_exhausted:true,bookkeeping_sync_error:row.metadata?.bookkeeping_sync_error || 'SYNC_ATTEMPTS_EXHAUSTED'}, {sync_status:'failed',last_sync_error:row.metadata?.bookkeeping_sync_error || 'SYNC_ATTEMPTS_EXHAUSTED'});
    return result(saved,saved.metadata?.bookkeeping_sync_status || 'failed');
  }
  if (eligibility === 'excluded' || !accounting?.syncInvoice) {
    const saved = await updateState({...row.metadata,bookkeeping_sync_status:'not_configured'});
    return result(saved,saved.metadata?.bookkeeping_sync_status || 'not_configured');
  }
  const previousAttempts = attemptCount(row.metadata);
  const attempts = (manualRetry && previousAttempts >= MAX_SYNC_ATTEMPTS ? 0 : previousAttempts) + 1;
  // Reserve the lease without spending an attempt on validation or credentials.
  const reserved = {...row.metadata,bookkeeping_sync_status:'pending',bookkeeping_sync_attempts:previousAttempts,bookkeeping_sync_attempted_at:new Date(now).toISOString(),bookkeeping_sync_next_at:new Date(now + SYNC_LEASE_MS).toISOString(),bookkeeping_sync_error:null,bookkeeping_sync_http_status:null,bookkeeping_sync_provider_code:null,bookkeeping_sync_provider_message:null,bookkeeping_sync_provider_operation:null};
  // Compare-and-swap prevents browser, bot and cron retries racing each other.
  let claimed = store.claimInvoiceSync ? await store.claimInvoiceSync(row,reserved) : await store.updateAssistantInvoiceMetadata(row.id,reserved);
  if (!claimed) return result(row,row.metadata?.bookkeeping_sync_status || 'pending',true);
  async function finish(metadata, fields) {
    if (metadata.bookkeeping_sync_status==='synced' && accounting.finishInvoiceSync) return accounting.finishInvoiceSync(claimed,metadata,fields);
    if (store.finishInvoiceSync) return await store.finishInvoiceSync(claimed,metadata,fields);
    return store.updateAssistantInvoiceMetadata(row.id,{...claimed.metadata,...metadata},fields);
  }
  // Recheck the reservation immediately before external work. A vanished row
  // is a deletion, not an accounting failure, and must never be recreated.
  async function readReservation() {
    const current=store.getAssistantInvoice ? await store.getAssistantInvoice(row.id) : claimed;
    if (!current || current.deleted_at) throw new APIError(404,'INVOICE_NOT_FOUND');
    assertInvoiceSyncScope(store,current);
    if (current.id!==row.id || current.metadata?.bookkeeping_sync_attempted_at!==reserved.bookkeeping_sync_attempted_at || current.metadata?.bookkeeping_sync_attempts!==claimed.metadata.bookkeeping_sync_attempts) throw new APIError(409,'INVOICE_SYNC_LEASE_CHANGED');
    return current;
  }
  function validateCurrent(current) {
    if (!invoice.clientName?.trim()) throw new APIError(422,'INVOICE_CUSTOMER_REQUIRED');
    if (['void','cancelled'].includes(current.status) || current.metadata?.invoice_direction==='payable') throw new APIError(409,'INVOICE_NOT_EXPORTABLE');
    if (['customer_id','invoice_number','issue_date','due_date','currency'].some(key=>String(current[key]??'')!==String(claimed[key]??'')) || Number(current.total_amount)!==Number(claimed.total_amount)) throw new APIError(409,'INVOICE_CHANGED_DURING_SYNC');
  }
  const current=await readReservation();
  let dispatched=false;
  let response;
  try {
    validateCurrent(current);
    const input={userId:store.userId,workspaceId:store.workspaceId,provider:'zoho_books',invoice,invoiceId:row.id};
    const dispatch=accounting.prepareInvoiceSync ? await accounting.prepareInvoiceSync(input) : () => accounting.syncInvoice(input);
    // Preparation can wait on connection reads/token refresh. Recheck saved
    // facts and atomically record the attempt immediately before dispatch.
    const ready=await readReservation();
    validateCurrent(ready);
    const dispatchMetadata={...ready.metadata,bookkeeping_sync_attempts:attempts,bookkeeping_sync_exhausted:false};
    const started=store.claimInvoiceSync ? await store.claimInvoiceSync(ready,dispatchMetadata) : await store.updateAssistantInvoiceMetadata(row.id,dispatchMetadata);
    if (!started) throw new APIError(409,'INVOICE_SYNC_LEASE_CHANGED');
    claimed=started;
    dispatched=true;
    response = await dispatch();
  } catch (error) {
    if (['INVOICE_NOT_FOUND','WORKSPACE_SCOPE_VIOLATION','INVOICE_SYNC_LEASE_CHANGED'].includes(error?.code)) throw error;
    const disconnected = ['ACCOUNTING_NOT_CONNECTED','ACCOUNTING_NOT_CONFIGURED'].includes(error?.code);
    const status = disconnected ? 'not_configured' : 'failed';
    const errorCode = String(error?.code || 'SYNC_FAILED').slice(0,80);
    const exhausted = (dispatched ? attempts : previousAttempts) >= MAX_SYNC_ATTEMPTS;
    const diagnostics=providerDiagnostics(error);
    const saved = await finish({bookkeeping_sync_status:exhausted?'failed':status,bookkeeping_sync_error:errorCode,bookkeeping_sync_http_status:Number.isInteger(error?.status)?error.status:null,bookkeeping_sync_provider_code:diagnostics.providerCode,bookkeeping_sync_provider_message:diagnostics.providerMessage,bookkeeping_sync_provider_operation:diagnostics.providerOperation,bookkeeping_sync_exhausted:exhausted,bookkeeping_sync_next_at:new Date(now + syncRetryDelay(dispatched ? attempts : previousAttempts)).toISOString()}, {sync_status:exhausted || !disconnected?'failed':'local',last_sync_error:errorCode});
    return result(saved,exhausted?'failed':status,!exhausted && !disconnected);
  }
  // A persistence failure must not be mistaken for a provider failure. The lease
  // expires and Zoho's existing invoice-number deduplication recovers the link.
  const at = clock().toISOString();
  const saved = await finish({bookkeeping_provider:response.provider,bookkeeping_record_id:response.externalId,bookkeeping_sync_status:'synced',bookkeeping_sync_error:null,bookkeeping_sync_http_status:null,bookkeeping_sync_provider_code:null,bookkeeping_sync_provider_message:null,bookkeeping_sync_provider_operation:null,bookkeeping_sync_next_at:null,bookkeeping_synced_at:at}, {external_provider:response.provider,external_invoice_id:response.externalId,last_synced_at:at,sync_status:'synced',last_sync_error:null});
  return {row:saved,sync:{status:'synced',provider:response.provider,externalId:response.externalId,retryable:false}};
}
