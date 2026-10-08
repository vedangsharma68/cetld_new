// Current inbound instruction only; history and quoted requests grant no authority.
export function requestedOwnerPayment(message) {
  const text=String(message||'').trim();
  let match=/^(?:please\s+)?(?:record|log)\s+(?:a\s+)?([A-Z]{3})\s+(\d{1,12}(?:\.\d{1,2})?)\s+(?:(?:test|partial)\s+)?payment\s+(?:against|for|on)\s+(?:the\s+)?(?:dummy\s+)?invoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^.!?\n]+))?(?:[.!]\s*|$)/i.exec(text);
  if(!match){
    const leading=/^(?:please\s+)?for\s+(?:test\s+)?invoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^,.!?\n]+))?,\s*(?:please\s+)?(?:record|log)\s+(?:a\s+)?(?:partial\s+)?payment\s+of\s+([A-Z]{3})\s+(\d{1,12}(?:\.\d{1,2})?)(?:[.!]\s*|$)/i.exec(text);
    if(leading)match=[leading[0],leading[3],leading[4],leading[1],leading[2]];
  }
  if(!match||/["“”`]/.test(match[0])||/\b(?:not|never|don't|do not|undo|reverse|refund|transfer|instead|or)\b/i.test(match[0]))return null;
  const rest=text.slice(match[0].length);
  if(rest&& !/^(?:(?:This is only a dummy bookkeeping entry\.\s*)?(?:Keep customer messages and reminders off\.?|No customer messages or reminders\.?)?|This is a dummy bookkeeping entry only;\s*keep messages and reminders off\.?)$/i.test(rest))return null;
  const amount=Number(match[2]);
  if(!Number.isFinite(amount)||amount<=0)return null;
  return {currency:match[1].toUpperCase(),amount,invoiceNumber:match[3],customerName:match[4]?.trim()||null};
}

// This guard only denies full settlement; it never authorizes or infers a payment.
// Ambiguous or unsupported amount wording must not become a paid-status action.
export function ownerPaymentAmountMentioned(message) {
  return /\bpartial\s+payment\b|\bpayment\s+(?:of\s+)?(?:[A-Z]{3}\s+)?\d|\b(?:[A-Z]{3}\s+)?\d+(?:\.\d+)?\s+(?:(?:partial|test)\s+)?payment\b/i.test(String(message||''));
}
