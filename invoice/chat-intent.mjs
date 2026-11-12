import {privateLanguageSyntax} from '../ai/private-language-syntax.mjs';
import {grammarDeterminers} from '../ai/private-value-language.mjs';
// Financial routing resolves the role of ambiguous words. Retained-value
// containment runs separately, including when this resolver returns ordinary.
export function financialChatIntent(message) {
  const original=String(message??'').normalize('NFKC'),text=original.toLowerCase();
  if(/\b(?:invoic\w*|receipts?|payments?|unpaid|overdue|owes?|owed|owing|receivables?|payables?|customers?|clients?|debtors?|creditors?|remind\w*)\b|[₹$€£]|\[cetld:/u.test(text))return true;
  for(const match of original.matchAll(/\bbills?\b/giu)){
    const tokens=privateLanguageSyntax(original),token=tokens.find(t=>t.start===match.index),before=original.slice(0,match.index).match(/[\p{L}\p{M}]+/gu)||[],next=tokens.find(t=>t.start>=match.index+match[0].length);
    const specified=grammarDeterminers.includes(before.at(-1)?.toLowerCase()),proper=/^\p{Lu}/u.test(match[0])&&token?.pos==='NNP';
    const nominalArgument=before.length>0&&!specified,nominalSubject=/^(?:VBD|VBP|VBZ|MD)$/.test(next?.pos||''),compound=next?.pos==='NNP';
    if(!(proper&&!specified&&tokens.length>1))return true;
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

// A determiner names its following nominal head; a pronoun leaves the object
// unresolved. Customer write denial must not treat every occurrence of `this`
// as an invoice reference when a different object is explicitly named.
export function unresolvedChangeReference(message){
 const tokens=privateLanguageSyntax(String(message||''));
 return tokens.some((t,i)=>{const w=t.word.toLowerCase();if(!['it','its','this','that'].includes(w))return false;if(w==='it')return true;for(const next of tokens.slice(i+1)){if(/^(?:NN|NNS|NNP|NNPS)$/.test(next.pos))return false;if(!/^(?:JJ|JJR|JJS|CD|DT|VBN)$/.test(next.pos))break;}return true;});
}
