import { isInvoiceDiagnosticRequest, handleInvoiceDiagnostic } from '../automation/accounting-invoice-diagnostic.mjs';

export default async function handler(request, response, dependencies = {}) {
  // Reserve diagnostic envelopes before importing the normal mutation/callback
  // dispatcher. Invalid diagnostic selectors never fall through to it.
  if (isInvoiceDiagnosticRequest(request)) return handleInvoiceDiagnostic(request, response, dependencies);
  const { handleAccountingRequest } = await import('../automation/accounting-routes.mjs');
  return handleAccountingRequest(request, response, dependencies);
};
