// Current inbound instruction only; history and quoted requests grant no authority.
export function requestedOwnerPayment(message) {
  const text=String(message||'').trim();
  const match=/^(?:please\s+)?(?:record|log)\s+(?:a\s+)?([A-Z]{3})\s+(\d{1,12}(?:\.\d{1,2})?)\s+(?:test\s+)?payment\s+(?:against|for|on)\s+invoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+([^.!?\n]+))?(?:[.!]\s*|$)/i.exec(text);
  if(!match||/["“”`]/.test(match[0])||/\b(?:not|never|don't|do not|undo|reverse|refund|transfer|instead|or)\b/i.test(match[0]))return null;
  const rest=text.slice(match[0].length);
  if(rest&& !/^(?:This is only a dummy bookkeeping entry\.\s*)?(?:Keep customer messages and reminders off\.?|No customer messages or reminders\.?)?$/i.test(rest))return null;
  const amount=Number(match[2]);
  if(!Number.isFinite(amount)||amount<=0)return null;
  return {currency:match[1].toUpperCase(),amount,invoiceNumber:match[3],customerName:match[4]?.trim()||null};
}
