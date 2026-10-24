import {isTestInvoice} from '../test-invoice.mjs';

export const TEST_TEMPLATE_BLOCK_REASON='test_invoice_template_blocked';
export const TEST_TEMPLATE_BLOCK_MESSAGE='Template delivery is blocked for test invoices: the approved template cannot carry explicit TEST / no-payment-required wording yet. Use a one-off message only within a verified 24-hour service window.';
export const TEST_MARKER_MESSAGE='Test-invoice messages must include a visible standalone TEST marker in the body, outside the invoice number.';

// A reserved invoice number containing TEST is not a visible message label.
export function hasVisibleTestMarker(body){
  return typeof body==='string' && /^[ \t]*TEST(?:[ \t]+|[ \t]*[:–—][ \t]*|$)/m.test(body);
}
export function testReminderBlockReason(invoice,delivery){
  if(!isTestInvoice(invoice))return null;
  if(delivery?.type!=='freeform'||delivery.fallback)return TEST_TEMPLATE_BLOCK_REASON;
  return hasVisibleTestMarker(delivery.body)?null:'test_invoice_marker_required';
}
export function assertTestReminderDelivery(invoice,delivery){
  const reason=testReminderBlockReason(invoice,delivery);
  if(reason)throw Object.assign(Error(reason===TEST_TEMPLATE_BLOCK_REASON?TEST_TEMPLATE_BLOCK_MESSAGE:TEST_MARKER_MESSAGE),{code:reason});
}
export function testInvoiceReminderDraft({invoice,settings,customer}){
  return `TEST — NO PAYMENT REQUIRED\n\nHi ${customer.name||'there'}, this is Cetld, an assistant for ${settings.business_name}. This is a test reminder for invoice ${invoice.invoice_number}. No payment is required. Please disregard any nominal invoice balance or due date.`;
}
