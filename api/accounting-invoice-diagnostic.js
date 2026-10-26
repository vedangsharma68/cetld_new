export default async function handler(request, response) {
  const { handleInvoiceDiagnostic } = await import('../automation/accounting-invoice-diagnostic.mjs');
  return handleInvoiceDiagnostic(request, response);
}
