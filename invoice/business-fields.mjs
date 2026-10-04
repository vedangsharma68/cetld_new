// Display only: never calculate or replace persisted ledger balances.
export function isExternallyManagedInvoice(invoice = {}) {
  const metadata = invoice.metadata || {};
  return [invoice.external_provider,invoice.external_invoice_id,metadata.accounting_provider,metadata.bookkeeping_record_id,
    invoice.accounting_provider,invoice.bookkeeping_record_id].some(value => value != null && String(value).trim() !== '');
}

export function invoiceBusinessFields(invoice = {}) {
  const meta = invoice.metadata || {};
  const amount = key => {
    const value = meta[key];
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) return String(value);
    const minor = meta[`${key}_minor`];
    return minor !== null && minor !== undefined && Number.isSafeInteger(Number(minor)) ? (Number(minor) / 100).toFixed(2) : null;
  };
  const items = Array.isArray(meta.line_items) ? meta.line_items : Array.isArray(invoice.line_items) ? invoice.line_items : [];
  return {
    subtotal: amount('subtotal'), tax: amount('tax'), discount: amount('discount'),
    line_items: items.map(item => Object.fromEntries(['description','quantity','unitPrice','amount','confidence'].filter(key => Object.hasOwn(item || {}, key)).map(key => [key,item[key]]))),
    invoice_direction: meta.invoice_direction || invoice.invoice_direction || null,
    seller_name: meta.seller_name || '', buyer_name: meta.buyer_name || '', payment_information: meta.payment_information || '',
    printed_invoice_number: meta.printed_invoice_number || meta.source_invoice_number || null,
  };
}

export function invoiceBusinessDetails(invoice, escape, money) {
  const fields = invoiceBusinessFields(invoice);
  const facts = [['Subtotal',fields.subtotal],['Tax',fields.tax],['Discount',fields.discount]].filter(([,value]) => value !== null)
    .map(([label,value]) => `<div><dt>${label}</dt><dd>${money(Math.round(Number(value)*100),invoice.currency)}</dd></div>`).join('');
  const names = [['Direction',fields.invoice_direction],['Seller',fields.seller_name],['Buyer',fields.buyer_name],['Payment instructions',fields.payment_information]]
    .filter(([,value])=>value).map(([label,value])=>`<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('');
  const rows = fields.line_items.map(item=>`<tr><td>${escape(item.description)}</td><td>${escape(item.quantity ?? '')}</td><td>${escape(item.unitPrice ?? '')}</td><td>${escape(item.amount ?? '')}</td></tr>`).join('');
  return `<dl class="detail-facts">${facts}${names}</dl>${rows?`<section aria-label="Invoice line items"><h3>Line items</h3><div class="table-wrap"><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Amount (${escape(invoice.currency)})</th></tr></thead><tbody>${rows}</tbody></table></div></section>`:''}${fields.printed_invoice_number?`<p class="muted">Original document number: ${escape(fields.printed_invoice_number)}. Corrections retain the original document and an audit history.</p>`:''}`;
}
