/** The same customer-facing notice is used on every invoice output. */
export function invoiceWhatsAppDisclosure(businessName) {
  const name = String(businessName ?? '').trim();
  if (!name) throw new TypeError('A workspace business name is required');
  return `Invoice updates from ${name} on WhatsApp. Reply STOP anytime.`;
}
