// These are inquiries only. Document corrections and negative delivery clauses
// do not authorize a save, payment, or other mutation.
export function ownerInvoiceReadIntent(message) {
  const text=String(message||'').normalize('NFKC').replace(/[’‘]/g,"'").trim().toLowerCase();
  if(!text||text.length>1200||! /^(?:please\s+)?(?:show|view|display|list|read|check|tell|explain|how|what|which|has|have|did|does|is|are|was|were|can\s+you|could\s+you)\b/u.test(text))return null;
  const clauses=text.split(/[.!?;]+/u).map(value=>value.trim()).filter(Boolean);
  const affirmative=clauses.filter(value=>! /^(?:please\s+)?(?:do not|don't|never)\s+(?:change|modify|update|save|record|send|delete|create)\s+(?:(?:any|the|this|customer|invoice)\s+)*(?:data|anything|messages?|reminders?|invoices?|payments?)(?:\s+(?:now|yet))?$/u.test(value)).join('. ');
  if(/\b(?:log|save|add|create|record|enter|update|change|modify|delete|remove|restore|reopen|reverse|refund|send|pay|mark|set)\b/u.test(affirmative))return null;
  const paymentHistory=/\bpayments?\s+(?:history|records?)\b|\bhistory\s+of\s+payments?\b|\b(?:what|which|any|all)\s+payments?\b|\bpayments?\b[^.!?]{0,45}\b(?:recorded|received|made)\b/u.test(affirmative);
  const balance=/\b(?:owes?|owing|owed|outstanding|balance|remaining|still\s+due)\b|\bhow\s+much\b/u.test(affirmative);
  const attachmentLookup=/\b(?:already|previously)\b[^.!?]{0,45}\b(?:logged|saved|recorded|added|exists?)\b|\b(?:logged|saved|recorded)\b[^.!?]{0,35}\b(?:already|before)\b|\b(?:invoice|bill)\b[^.!?]{0,45}\b(?:exists?|in\s+(?:my|our|the)\s+records?)\b/u.test(affirmative);
  return paymentHistory||balance||attachmentLookup?{paymentHistory,balance,attachmentLookup}:null;
}
