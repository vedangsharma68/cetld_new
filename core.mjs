export function cents(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Enter an amount with up to two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result <= 0 || result > 100000000000) throw new Error('Enter an amount between ₹0.01 and ₹1 billion.');
  return result;
}
export function remaining(invoice) { return Math.max(0, invoice.amount_minor - invoice.paid_minor); }
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function status(invoice, today = localDate()) {
  if (!remaining(invoice)) return 'Paid';
  if (invoice.due_date < today) return 'Overdue';
  if (invoice.due_date === today) return 'Due today';
  return 'Open';
}
export function totals(invoices) {
  return invoices.reduce((t, x) => ({outstanding:t.outstanding+remaining(x), overdue:t.overdue+(status(x)==='Overdue'?remaining(x):0), collected:t.collected+x.paid_minor}), {outstanding:0,overdue:0,collected:0});
}
export function payment(invoice, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining(invoice)) throw new Error('Payment must be positive and cannot exceed the balance.');
  return {...invoice, paid_minor: invoice.paid_minor+amount, followup_state: remaining(invoice)===amount?'cancelled':invoice.followup_state};
}
export function canApprove(invoice) { return remaining(invoice)>0 && ['draft','paused','cancelled'].includes(invoice.followup_state); }
export function csvCell(value) {
  const text=String(value ?? '');
  const safe=/^[\s]*[=+\-@\t\r]/.test(text)?"'"+text:text;
  return '"'+safe.replaceAll('"','""')+'"';
}
