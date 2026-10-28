import {validateAssistantInvoice} from './invoice-ops.mjs';
import {isSupportedCurrency} from '../currency-contract.mjs';

const keys = {invoiceNumber:'invoiceNumber', customerName:'clientName', invoiceDate:'invoiceDate', dueDate:'dueDate',
  subtotal:'subtotal', tax:'tax', total:'total', outstandingAmount:'outstanding', currency:'currency',
  clientEmail:'clientEmail', clientPhone:'clientPhone', clientPhoneRaw:'clientPhoneRaw', notes:'notes', direction:'direction', lineItems:'lineItems'};
const labels = {invoiceNumber:'invoice number', customerName:'customer', invoiceDate:'invoice date', dueDate:'due date',
  subtotal:'subtotal', tax:'tax', total:'total', outstandingAmount:'balance', currency:'currency', direction:'direction',
  clientEmail:'email', clientPhone:'phone', clientPhoneRaw:'local phone', notes:'notes', lineItems:'line items'};
const mandatory = ['invoiceNumber','customerName','invoiceDate','total','currency','direction'];
export const OFFLINE_CONFIRMATION_REPLY = /^\s*(?:yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve|send it|create it)\s*[.!]?\s*$/i;
export const OFFLINE_CANCEL_REPLY = /^\s*(?:no|cancel|never mind|nevermind|discard|stop)\s*[.!]?\s*$/i;

// Deliberately narrower than conversational inference. A question, negation or
// conditional is never evidence that the business issued this invoice.
export function offlineDirectionEvidence(message) {
  return !/[?'"“”`]|\b(?:not|never|didn't|did not|don't|if|maybe|whether|wasn't|could|would|someone|says|said|quoted|perhaps|might|later|tomorrow|next)\b/i.test(message)
    && /\b(?:(?:we|i|our business|my business)\s+(?:have\s+)?(?:issued|sent|created|made)\s+(?:it|(?:(?:this|that|the)\s+)?invoice)\b|issued by (?:us|me|our business))\b/i.test(message);
}

export function resolveOfflineReview(action) {
  const invoice = action.invoice;
  const missingFields = mandatory.filter(field => {
    const value = invoice[keys[field]];
    return value == null || value === '' || field === 'currency' && !isSupportedCurrency(value)
      || field === 'direction' && value !== 'receivable' || field === 'total' && !(value > 0);
  });
  for (const field of action.conflictingFields || []) if (!action.ownerProvidedFacts?.[field] && !missingFields.includes(field)) missingFields.push(field);
  for (const field of action.unresolvedFields || []) if (!action.ownerProvidedFacts?.[field] && !missingFields.includes(field)) missingFields.push(field);
  const validationIssues = [];
  if (typeof invoice.notes === 'string' && invoice.notes.length > 2000) validationIssues.push('NOTES_TOO_LONG');
  if (action.paymentEvidence && action.paymentEvidence.status !== 'unpaid') validationIssues.push('PAYMENT_RECORD_REQUIRES_REVIEW');
  if (invoice.subtotal != null && invoice.lineItems?.length && invoice.lineItems.every(item=>item.amount != null)
    && Math.abs(Math.round(invoice.lineItems.reduce((sum,item)=>sum+item.amount,0)*100)-Math.round(invoice.subtotal*100)) > 1)
    validationIssues.push('LINE_ITEMS_DO_NOT_MATCH_SUBTOTAL');
  // Validate structural and monetary rules even while direction is unresolved.
  // The candidate itself remains uncertain and cannot enter proposal.
  try { validateAssistantInvoice({...invoice, direction:'receivable'}); }
  catch (error) {
    if (error.status !== 422 && error.status !== 409) throw error;
    const field = {INVOICE_NUMBER_REQUIRED:'invoiceNumber', CLIENT_REQUIRED:'customerName', INVOICE_DATE_REQUIRED:'invoiceDate',
      INVALID_DUE_DATE:'dueDate', CURRENCY_REQUIRED:'currency', UNSUPPORTED_CURRENCY:'currency',
      INVOICE_TOTAL_REQUIRED:'total', INVOICE_TOTAL_MUST_BE_POSITIVE:'total'}[error.code];
    if (field) { if (!missingFields.includes(field)) missingFields.push(field); }
    else validationIssues.push(error.code);
  }
  const next = {...action, stage:missingFields.length || validationIssues.length ? 'incomplete' : 'proposal', missingFields, validationIssues};
  if (offlineReviewClarification(next,{maxLength:Infinity}).length > 3790) {
    next.validationIssues.push('OFFLINE_REVIEW_TOO_LONG'); next.stage='incomplete';
  }
  return next;
}

export function offlineReviewDraft(extracted, sourceMessageId, {ownerMessage} = {}) {
  const invoice = Object.fromEntries(Object.entries(keys).map(([field,key]) => [key, extracted?.[field]?.value ?? null]));
  invoice.lineItems ||= [];
  invoice.alreadyPaid = false;
  // Printed seller names do not establish the owner's relationship to it.
  invoice.direction = offlineDirectionEvidence(ownerMessage || '') ? 'receivable' : 'uncertain';
  const assumptions = [];
  if (invoice.outstanding == null && !extracted?.unresolvedFields?.includes('outstandingAmount')) {
    invoice.outstanding = invoice.total;
    assumptions.push('balance was not shown, so the total is used as outstanding');
  }
  if (invoice.dueDate == null && !extracted?.unresolvedFields?.includes('dueDate')) assumptions.push('due date was not shown; no due date is set');
  if (!invoice.lineItems.length && !extracted?.unresolvedFields?.includes('lineItems')) assumptions.push('no readable line items; the line item list is empty');
  const printedEvidence = Object.fromEntries(Object.entries(keys).filter(([field]) => (extracted?.[field]?.value != null || extracted?.printedEvidence?.[field])
    && field !== 'direction' && (field !== 'lineItems' || extracted[field].value.length || extracted?.printedEvidence?.lineItems)).map(([field]) => [field,
    {value:structuredClone(extracted[field].value), confidence:extracted[field].confidence,
      ...(extracted.printedEvidence?.[field] ? {text:extracted.printedEvidence[field]} : {}),
      ...(extracted.conflictingValues?.[field] ? {candidates:extracted.conflictingValues[field]} : {})}]));
  return resolveOfflineReview({type:'invoice_review_draft', extractionRoute:'offline', sourceMessageId, invoice,
    printedEvidence, confirmationFields:Object.keys(keys).filter(field => (extracted?.[field]?.confidence ?? 0) < .75),
    conflictingFields:extracted?.conflictingFields || [], unresolvedFields:extracted?.unresolvedFields || [],
    ownerProvidedFacts:invoice.direction === 'receivable' ? {direction:{value:'receivable',sourceMessageId}} : {}, assumptions,
    warnings:extracted?.warnings || [], currencySource:isSupportedCurrency(invoice.currency) ? 'photo' : null,
    dueDateSource:invoice.dueDate ? 'printed' : extracted?.unresolvedFields?.includes('dueDate') ? 'unresolved printed' : 'not shown',
    ...(extracted?.paymentStatus?.value ? {paymentEvidence:{status:extracted.paymentStatus.value,
      text:extracted.paymentStatusEvidence?.value ?? null, confidence:extracted.paymentStatus.confidence}} : {})});
}

function display(value) {
  if (Array.isArray(value)) return value.length ? value.map(item => `${item.description}: quantity ${item.quantity ?? '?'}, rate ${item.unitPrice ?? '?'}, amount ${item.amount ?? '?'}`).join('; ') : 'none';
  return value == null ? 'not shown' : String(value);
}

export function offlineReviewClarification(action, {buttonsAvailable=false,maxLength=3790} = {}) {
  if (action.stage === 'saved') return `Invoice ${action.invoice?.invoiceNumber} was already saved. Send a new photo to start another review.`;
  if (action.stage === 'canceled') return 'That review was canceled. Send a new photo to start again.';
  const lines = ['Local invoice review. Check every value against the original:'];
  for (const [field,key] of Object.entries(keys)) {
    if (action.invoice?.[key] == null && !action.printedEvidence?.[field] && !mandatory.includes(field) && field !== 'dueDate') continue;
    const printed = action.printedEvidence?.[field];
    const corrected = action.ownerProvidedFacts?.[field];
    let provenance = printed ? JSON.stringify(printed.value) === JSON.stringify(action.invoice?.[key])
      ? printed.value == null && printed.text ? ` (printed: ${printed.text.replace(/\n/g,'; ')})` : ' (printed)'
      : ` (printed: ${printed.value == null && printed.text ? printed.text.replace(/\n/g,'; ') : display(printed.value)})` : '';
    if (corrected) provenance += ' (owner supplied)';
    if (printed?.candidates?.length > 1) provenance += `; conflicting printed values: ${printed.candidates.join(', ')}`;
    if (field === 'currency' && printed?.value == null && printed?.text) provenance += `; printed evidence: ${printed.text.replace(/\n/g,'; ')}`;
    lines.push(`${labels[field]}: ${display(action.invoice?.[key])}${provenance}.`);
  }
  if (action.paymentEvidence) lines.push(`Printed payment evidence: ${action.paymentEvidence.text || action.paymentEvidence.status}. No payment is recorded.`);
  lines.push(`Assumptions: ${action.assumptions?.join('; ') || 'none'}.`);
  if (action.missingFields?.includes('direction')) lines.push('Tell me explicitly that your business issued this invoice, for example "We issued this invoice".');
  if (action.missingFields?.includes('lineItems')) lines.push('Some printed line items could not be read. Send a clearer photo or corrected invoice.');
  const missing = (action.missingFields || []).filter(field => !['direction','lineItems'].includes(field));
  if (missing.length) lines.push(`Send the missing or ambiguous ${missing.map(field => labels[field] || field).join(', ')} using a correction, for example "set invoice date to 2026-10-20".`);
  if (action.validationIssues?.length) {
    const explanations = {PAYMENT_RECORD_REQUIRES_REVIEW:'printed payment status needs review; no payment can be inferred',
      PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD:'printed balance differs from the total and needs payment review',
      INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX:'subtotal plus tax does not match the total',
      LINE_ITEMS_DO_NOT_MATCH_SUBTOTAL:'line items do not match the subtotal'};
    lines.push(`Check the original: ${action.validationIssues.map(code=>explanations[code] || code.replaceAll('_',' ').toLowerCase()).join('; ')}. Send a corrected invoice or clearer photo.`);
  }
  lines.push(action.stage === 'proposal'
    ? `Confirm accepts exactly all the values shown above. ${buttonsAvailable ? 'Tap Confirm or Cancel.' : 'Reply yes to confirm, or cancel.'}`
    : 'Confirmation is unavailable until the missing or ambiguous details are resolved. Reply cancel to discard.');
  lines.push('Nothing was saved.');
  const rendered = lines.join('\n');
  return rendered.length > maxLength ? 'This invoice has too much printed detail for one WhatsApp review. Nothing was saved. Send an invoice with fewer line items or review it in cetld.' : rendered;
}

// parseCorrection is the established closed grammar, passed in to avoid a
// dependency cycle with the handler. No model or inferred edit is accepted.
export function correctOfflineReview(action, message, {parseCorrection, clock, messageId} = {}) {
  if (!['incomplete','proposal'].includes(action.stage) || /\b(?:sql|run|execute|select|delete|drop|table|script)\b/i.test(message)) return null;
  let changes = parseCorrection(message, clock)?.changes;
  const currency = String(message).trim().toUpperCase().replace(/[.!]$/, '');
  if (!changes && isSupportedCurrency(currency)) changes = {currency};
  if (!changes && /^\s*(?:set|change)\s+invoice\s+number\s+(?:to\s+)?[A-Za-z0-9][A-Za-z0-9/_.-]{0,99}\s*$/i.test(message))
    changes = {invoiceNumber:message.trim().split(/\s+/).at(-1)};
  if (offlineDirectionEvidence(message)) changes = {...changes, direction:'receivable'};
  if (!changes || Object.keys(changes).some(key => !Object.values(keys).includes(key))
    || Object.values(changes).some(value => value == null || value === '')) return null;
  const invoice = {...action.invoice, ...changes};
  const ownerProvidedFacts = {...action.ownerProvidedFacts};

  for (const [key,value] of Object.entries(changes)) {
    const field = Object.keys(keys).find(field => keys[field] === key);
    ownerProvidedFacts[field] = {value, sourceMessageId:messageId};
  }
  if (changes.total != null && !action.printedEvidence?.outstandingAmount && !ownerProvidedFacts.outstandingAmount) invoice.outstanding = changes.total;
  return resolveOfflineReview({...action, invoice, ownerProvidedFacts,
    currencySource:changes.currency ? 'user' : action.currencySource});
}
