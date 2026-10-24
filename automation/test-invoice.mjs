// Reserved server-created fixtures stay non-exportable even if a caller supplies
// only their visible number. The database also protects their durable marker.
export function isTestInvoice(row) {
  const metadata = row?.metadata || {};
  return metadata.test_invoice === true || metadata.test_invoice === 'true'
    || [metadata.source_invoice_number, row?.source_invoice_number, row?.invoice_number, row?.invoiceNumber]
      .some(number => typeof number === 'string' && number.startsWith('CETLD-TEST-'));
}
