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
  if (invoice.status === 'void') return 'Void';
  if (invoice.status === 'cancelled') return 'Cancelled';
  if (invoice.status === 'paid') return 'Paid';
  if (!remaining(invoice)) return 'Paid';
  if (invoice.due_date < today) return 'Overdue';
  if (invoice.due_date === today) return 'Due today';
  return 'Open';
}
export function totals(invoices) {
  return invoices.reduce((t, x) => ({outstanding:t.outstanding+remaining(x), overdue:t.overdue+(status(x)==='Overdue'?remaining(x):0), collected:t.collected+x.paid_minor}), {outstanding:0,overdue:0,collected:0});
}
export function payment(invoice, amount) {
  if (['void','cancelled'].includes(invoice.status)) throw new Error('Terminal invoices cannot accept payments.');
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining(invoice)) throw new Error('Payment must be positive and cannot exceed the balance.');
  const settled = remaining(invoice) === amount;
  return {...invoice, paid_minor: invoice.paid_minor+amount, followup_state: settled?'cancelled':invoice.followup_state, ...(settled ? {next_follow_up_at:null} : {})};
}
export function settleInvoice(invoiceOrPayload) {
  const invoice = invoiceOrPayload?.invoice ?? invoiceOrPayload;
  const alreadyPaid = invoiceOrPayload?.alreadyPaid === true || invoice?.alreadyPaid === true;
  if (!alreadyPaid) return invoice;
  const hasMinorTotal = invoice?.amount_minor !== undefined && invoice?.amount_minor !== null;
  const total = Number(hasMinorTotal ? invoice.amount_minor : invoice?.total_amount);
  const totalMinor = hasMinorTotal ? total : Math.round(total * 100);
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) throw new Error('A valid invoice total is required before marking an invoice paid.');
  if (hasMinorTotal) return {...invoice, paid_minor:totalMinor, followup_state:'cancelled', next_follow_up_at:null, status:'paid'};
  return {...invoice, amount_paid:Number(Number(invoice.total_amount).toFixed(2)), status:'paid', metadata:{...(invoice.metadata ?? {}),followup_state:'cancelled',next_follow_up_at:null}};
}
export async function saveAndSettleInvoice({state,saveInvoice,recordPayment}) {
  if(!state.invoiceId){
    const invoice=await saveInvoice();
    if(!invoice?.id)throw new Error('Invoice save did not return an invoice id.');
    state.invoiceId=invoice.id;
    state.invoiceUpdatedAt=invoice.updated_at??'';
  }
  const idempotencyKey=state.idempotencyKey||(state.idempotencyKey=crypto.randomUUID());
  return recordPayment({invoiceId:state.invoiceId,invoiceUpdatedAt:state.invoiceUpdatedAt,idempotencyKey});
}
export function paymentRequestKey(state,{amount,reference}={}) {
  if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('Enter a valid payment amount before recording payment.');
  const normalizedReference=String(reference??'').trim()||null;
  const fingerprint=JSON.stringify({amount,reference:normalizedReference});
  if(state.paymentRequestFingerprint){
    if(state.paymentRequestFingerprint!==fingerprint)throw new Error('A payment request is pending; retry with the same amount and reference or close and reopen the form.');
    return state.paymentRequestKey;
  }
  state.paymentRequestFingerprint=fingerprint;
  state.paymentRequestKey=crypto.randomUUID();
  return state.paymentRequestKey;
}
export function canApprove(invoice) { return !['paid','void','cancelled'].includes(invoice.status) && remaining(invoice)>0 && ['draft','paused','cancelled'].includes(invoice.followup_state); }
export function csvCell(value) {
  const text=String(value ?? '');
  const safe=/^[\s]*[=+\-@\t\r]/.test(text)?"'"+text:text;
  return '"'+safe.replaceAll('"','""')+'"';
}

