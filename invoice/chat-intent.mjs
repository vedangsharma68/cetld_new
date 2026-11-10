// Financial routing resolves the role of ambiguous words. Retained-value
// containment runs separately, including when this resolver returns ordinary.
export function financialChatIntent(message) {
  const original=String(message??'').normalize('NFKC'),text=original.toLowerCase();
  if(/\b(?:invoic\w*|receipts?|payments?|unpaid|overdue|owes?|owed|owing|receivables?|payables?|customers?|clients?|debtors?|creditors?|remind\w*)\b|[₹$€£]|\[cetld:/u.test(text))return true;
  for(const match of original.matchAll(/\bbills?\b/giu)){
    const next=original.slice(match.index+match[0].length).match(/^\s+([\p{L}\p{M}]+)/u)?.[1];
    const compoundName=/^\p{Lu}/u.test(match[0])&&/^\p{Lu}/u.test(next||'')&&!/^(?:is|was|are|were|has|had|will|can|the|a|an)$/iu.test(next);
    if(!compoundName)return true;
  }
  const entity=/\b(?:accounts?|money|cash|funds?|bank|ledger|business|amount|currency)\b/u.test(text);
  const relational=/\b(?:balance|total)\s+(?:of|between)\b/u.test(text);
  if(/^(?:(?:my|our|the|your|current|remaining)\s+)?(?:balances?|totals?|outstanding|paid)[.!?\s]*$/u.test(text))return true;
  if(/\b(?:balance|total|paid|outstanding)\b/u.test(text)&&entity)return true;
  if(!relational&&/\b(?:my|our|your|his|her|their|current|remaining|account)\s+(?:(?:paid|outstanding)\s+)?(?:balance|total)\b/u.test(text)&&!text.includes('work-life')&&!text.includes('work life'))return true;
  if(/\b(?:balance|invoices?)\s+for\b/u.test(text))return true;
  // Settlement predicates require their subject; an attributive adjective in
  // an unrelated noun phrase does not identify a financial read.
  if(/\b(?:is|are|was|were|has|have)\s+(?:it|this|that|they|these|those)\s+(?:been\s+)?(?:paid|outstanding)\b/u.test(text)
    ||/\b(?:it|this|that|they|these|those)\s+(?:is|are|was|were|has been|have been)\s+(?:paid|outstanding)\b/u.test(text))return true;
  return /\b(?:set|change|correct|update|edit|fix)\b.{0,60}\b(?:total|tax|notes?|currency|due date|invoice date)\b/u.test(text);
}
