import {invoiceBusinessFields} from './business-fields.mjs';

export function correctionLineItemRow(item = {}, escape = String, locked = false) {
  const disabled = locked ? 'disabled' : '';
  return `<tr data-correction-item${item.confidence == null?'':` data-confidence="${escape(item.confidence)}"`}><td><input aria-label="Item description" data-item-field="description" maxlength="500" value="${escape(item.description || '')}" ${disabled}></td><td><input aria-label="Item quantity" data-item-field="quantity" inputmode="decimal" value="${escape(item.quantity ?? '')}" ${disabled}></td><td><input aria-label="Item unit price" data-item-field="unitPrice" inputmode="decimal" value="${escape(item.unitPrice ?? '')}" ${disabled}></td><td><input aria-label="Item amount" data-item-field="amount" inputmode="decimal" value="${escape(item.amount ?? '')}" ${disabled}></td><td>${locked?'':'<button type="button" class="btn small" data-remove-item>Remove</button>'}</td></tr>`;
}

export function invoiceCorrectionFormView(invoice, customers, escape) {
  const fields = invoiceBusinessFields(invoice);
  const locked = Number(invoice.paid_minor || 0) > 0 || invoice.has_payment_history === true || invoice.status==='paid' || Boolean(invoice.deleted_at) || ['void','cancelled'].includes(invoice.status);
  const disabled = locked ? 'disabled' : '';
  const input = (label,name,value,type='text',financial=false) => `<label class="field">${label}<input name="${name}" type="${type}" value="${escape(value ?? '')}" ${financial?disabled:''}></label>`;
  const customersHtml = `<option value="" ${customers.some(customer=>customer.id===invoice.customer_id)?'':'selected'} disabled>Choose customer</option>` + customers.map(customer=>`<option value="${escape(customer.id)}" ${customer.id===invoice.customer_id?'selected':''}>${escape(customer.name || customer.company_name || 'Customer')}</option>`).join('');
  return `<form id="invoice-correction-form"><div class="dialog-body"><p class="muted">Corrections retain the original document and an audit history. Customer selection changes this invoice only.</p>${locked?'<p class="notice">This invoice has payment history. Amounts, itemization, currency, direction and customer cannot be changed here.</p>':''}${input('Invoice number','invoice_number',invoice.invoice_number || invoice.number,'text',true)}<label class="field">Customer<select name="customer_id" required ${disabled}>${customersHtml}</select></label><div class="two-cols">${input('Invoice total','total_amount',invoice.total_amount ?? invoice.amount_minor/100,'text',true)}${input('Currency','currency',invoice.currency,'text',true)}</div><div class="two-cols">${input('Subtotal','subtotal',fields.subtotal,'text',true)}${input('Tax','tax',fields.tax,'text',true)}${input('Discount','discount',fields.discount,'text',true)}</div><div class="two-cols">${input('Invoice date','issue_date',invoice.issue_date || invoice.invoice_date,'date')}${input('Due date','due_date',invoice.due_date,'date')}</div><label class="field">Direction<select name="invoice_direction" ${disabled}><option value="" ${fields.invoice_direction?'':'selected'} disabled>Choose direction</option><option value="receivable" ${fields.invoice_direction==='receivable'?'selected':''}>We issued it · customer owes us</option><option value="payable" ${fields.invoice_direction==='payable'?'selected':''}>We received it · we owe the supplier</option></select><small>Payables do not receive collection reminders.</small></label>${input('Seller name','seller_name',fields.seller_name)}${input('Buyer name','buyer_name',fields.buyer_name)}<label class="field">Payment instructions<textarea name="payment_information" maxlength="2000">${escape(fields.payment_information)}</textarea></label><section aria-label="Edit invoice line items"><h3>Line items</h3><div class="table-wrap"><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Amount</th><th></th></tr></thead><tbody data-correction-items>${fields.line_items.map(item=>correctionLineItemRow(item,escape,locked)).join('')}</tbody></table></div>${locked?'':'<button type="button" class="btn small" data-add-item>Add item</button>'}<p class="muted">Item amounts must reconcile with subtotal. Subtotal plus tax minus discount must equal the total.</p></section><label class="field">Notes<textarea name="notes" maxlength="4000">${escape(invoice.notes || '')}</textarea></label>${fields.printed_invoice_number?`<p class="muted">Original document number: ${escape(fields.printed_invoice_number)}</p>`:''}<div class="error hidden" data-error role="alert"></div></div><div class="dialog-foot"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary">Save corrections</button></div></form>`;
}

function moneyValue(value, nullable = false) {
  const text = String(value ?? '').trim();
  if (!text && nullable) return null;
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) throw new Error('Amounts must be non-negative, use at most twelve whole digits and two decimal places.');
  const [whole,fraction='']=text.split('.');
  const minor=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if (minor>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is invalid.');
  return Number(minor)/100;
}

export function readCorrectionLineItems(rows) {
  return Array.from(rows).map(row => {
    const get = field => String(row.querySelector(`[data-item-field="${field}"]`)?.value ?? '').trim();
    const description = get('description');
    if (!description) throw new Error('Each line item needs a description.');
    const quantity = get('quantity');
    if (quantity && (!/^\d+(?:\.\d{1,4})?$/.test(quantity) || Number(quantity)<=0 || Number(quantity)>1000000)) throw new Error('Item quantity must be positive, at most 1000000, and use at most four decimal places.');
    const unitPrice = get('unitPrice');
    return {description,quantity:quantity?Number(quantity):null,unitPrice:unitPrice?moneyValue(unitPrice):null,amount:moneyValue(get('amount')),
      ...(row.dataset.confidence == null?{}:{confidence:Number(row.dataset.confidence)})};
  });
}

export function correctionValues(form, invoice, formData = new FormData(form)) {
  const fields = invoiceBusinessFields(invoice), values = {};
  const original = {...fields,invoice_number:invoice.invoice_number || invoice.number,customer_id:invoice.customer_id,total_amount:invoice.total_amount ?? invoice.amount_minor/100,currency:invoice.currency,
    issue_date:invoice.issue_date || invoice.invoice_date,due_date:invoice.due_date,notes:invoice.notes || ''};
  for (const name of ['invoice_number','customer_id','total_amount','currency','subtotal','tax','discount','issue_date','due_date','notes','invoice_direction','seller_name','buyer_name','payment_information']) {
    if (!formData.has(name)) continue;
    const rawValue = String(formData.get(name) ?? '');
    // Preserve the exact existing displayed value, including old incomplete
    // extraction or amounts outside today's input limits. Only changed fields
    // belong in a correction; benign edits must not repair unrelated history.
    if (rawValue === String(original[name] ?? '')) continue;
    let value = rawValue.trim();
    if (['total_amount','subtotal','tax','discount'].includes(name)) {
      value = moneyValue(value,name!=='total_amount');
      const before = original[name] == null ? null : Number(original[name]);
      if (value===null && before!==null) throw new Error('Use 0 to remove a monetary component and ensure the totals still reconcile.');
      if (value !== before) values[name] = value;
    } else {
      if (name==='currency') value=value.toUpperCase();
      if (String(original[name] ?? '') !== value) values[name] = ['due_date','notes','seller_name','buyer_name','payment_information'].includes(name)&&!value?null:value;
    }
  }
  const rows = form.querySelectorAll('[data-correction-item]');
  if (!form.querySelector('[data-add-item]')) return values;
  const rawItems = Array.from(rows).map(row => ({
    ...Object.fromEntries(['description','quantity','unitPrice','amount'].map(field => [field,String(row.querySelector(`[data-item-field="${field}"]`)?.value ?? '')])),
    ...(row.dataset.confidence == null ? {} : {confidence:String(row.dataset.confidence)}),
  }));
  const displayedItems = fields.line_items.map(item => ({description:String(item.description || ''),quantity:String(item.quantity ?? ''),unitPrice:String(item.unitPrice ?? ''),amount:String(item.amount ?? ''),
    ...(item.confidence == null ? {} : {confidence:String(item.confidence)}),
  }));
  if (JSON.stringify(rawItems) === JSON.stringify(displayedItems)) return values;
  const items = readCorrectionLineItems(rows);
  const normalized = fields.line_items.map(item=>({description:item.description,quantity:item.quantity == null?null:Number(item.quantity),unitPrice:item.unitPrice == null?null:Number(item.unitPrice),amount:Number(item.amount),...(item.confidence == null?{}:{confidence:item.confidence})}));
  if (JSON.stringify(items)!==JSON.stringify(normalized)) values.line_items=items;
  return values;
}
