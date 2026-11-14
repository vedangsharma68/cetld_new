import { isInvoiceDiagnosticRequest, handleInvoiceDiagnostic } from '../automation/accounting-invoice-diagnostic.mjs';
import { isInvoiceCleanupRequest, handleInvoiceCleanup } from '../automation/accounting-invoice-cleanup.mjs';

export default async function handler(request, response, dependencies = {}) {
  // Both isolated routes reserve local invoice selectors. Preserve the explicit
  // diagnostic action; all other cleanup envelopes are validated in isolation.
  if (isInvoiceCleanupRequest(request)) {
    let body = request.body;
    if (typeof body === 'string' && Buffer.byteLength(body) <= 32768) {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (body?.action === 'invoice-diagnostic') return handleInvoiceDiagnostic(request, response, dependencies);
    return handleInvoiceCleanup(request, response, dependencies);
  }
  // Reserve diagnostic envelopes before importing the normal mutation/callback
  // dispatcher. Invalid diagnostic selectors never fall through to it.
  if (isInvoiceDiagnosticRequest(request)) return handleInvoiceDiagnostic(request, response, dependencies);
  const { handleAccountingRequest } = await import('../automation/accounting-routes.mjs');
  return handleAccountingRequest(request, response, dependencies);
};
