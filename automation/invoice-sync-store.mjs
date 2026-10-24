import {APIError} from '../ai/http.mjs';
import {isTestInvoice} from './test-invoice.mjs';

// All writes are scoped by workspace and use updated_at as the optimistic lock.
export function invoiceSyncPersistence({read, patch}) {
  return {
    claimInvoiceSync(row, metadata, fields={}) {
      if (isTestInvoice(row)) throw new APIError(409,'INVOICE_NOT_EXPORTABLE');
      return patch(row,{metadata,...fields});
    },
    async finishInvoiceSync(claimed, changes, fields) {
      for (let attempt=0; attempt<3; attempt++) {
        const current = await read(claimed.id);
        if (isTestInvoice(current) || isTestInvoice(claimed)) throw new APIError(409,'INVOICE_NOT_EXPORTABLE');
        if (!current || current.deleted_at || current.id!==claimed.id || current.workspace_id!==claimed.workspace_id || current.metadata?.bookkeeping_sync_attempted_at !== claimed.metadata.bookkeeping_sync_attempted_at || current.metadata?.bookkeeping_sync_attempts !== claimed.metadata.bookkeeping_sync_attempts) throw Error('Invoice sync lease changed');
        const saved = await patch(current,{metadata:{...current.metadata,...changes},...fields});
        if (saved) return saved;
      }
      throw Error('Invoice changed while saving sync state');
    }
  };
}
