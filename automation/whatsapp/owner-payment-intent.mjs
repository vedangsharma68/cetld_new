// Current inbound instruction only; history and quoted requests grant no authority.
// Compose bounded payment/reference/factual clauses, never extract an amount from
// arbitrary prose. The private SQL parser implements the same grammar.
const MONEY=String.raw`([A-Z]{3})\s+(\d{1,12}(?:\.\d{1,2})?)`;
const COMMAND=String.raw`(?:please\s+)?(?:record|log|register)\s+(?:a\s+)?`;
const QUALIFIER=String.raw`(?:(?:test|partial)\s+)?(?:bookkeeping\s+)?`;
const NAME=String.raw`([^.!?;\n]{1,255}?)`;
const REFERENCE=String.raw`(?:the\s+)?(?:(?:dummy|test|disposable\s+QA)\s+)?(?:${NAME}\s+)?invoice(?:\s+(?:number|no\.?|ref(?:erence)?))?\s+(?:#\s*)?([A-Za-z0-9][A-Za-z0-9_/-]{0,99})(?:\s+for\s+${NAME})?`;
const END=String.raw`(?:[.!;]\s*|$)`;
const matchPrefix=(text,pattern)=>new RegExp('^'+pattern,'i').exec(text);
function paymentPrefix(text,end){
  return matchPrefix(text,COMMAND+MONEY+String.raw`\s+`+QUALIFIER+String.raw`payment`+end)
    ||matchPrefix(text,COMMAND+QUALIFIER+String.raw`payment\s+of\s+`+MONEY+end);
}
function referencePrefix(text,end){
  const match=matchPrefix(text,REFERENCE+end);
  if(!match||match[1]&&match[3])return null;
  return {match,invoiceNumber:match[2],customerName:(match[1]||match[3])?.trim()||null};
}
export function requestedOwnerPayment(message) {
  const text=String(message||'').trim().replace(/,\s*please[.!]?\s*$/i,'.');
  if(!text||text.length>2400||/["“”`?]/.test(text))return null;
  let payment,reference,rest;
  const leading=matchPrefix(text,String.raw`(?:please\s+)?for\s+`);
  if(leading){
    const afterLeading=text.slice(leading[0].length);
    reference=referencePrefix(afterLeading,String.raw`\s*,\s*`);
    if(!reference)return null;
    payment=paymentPrefix(afterLeading.slice(reference.match[0].length),END);
    if(!payment)return null;
    rest=afterLeading.slice(reference.match[0].length+payment[0].length);
  }else{
    payment=paymentPrefix(text,String.raw`\s+(?:against|for|on)\s+`);
    if(!payment)return null;
    reference=referencePrefix(text.slice(payment[0].length),END);
    if(!reference)return null;
    rest=text.slice(payment[0].length+reference.match[0].length);
  }
  if(/\b(?:not|never|don't|do not|undo|reverse|refund|transfer|instead|or)\b/i.test(payment[0]+' '+reference.match[0]))return null;
  const amount=Number(payment[2]),currency=payment[1].toUpperCase();
  if(!Number.isFinite(amount)||amount<=0)return null;
  const facts={currency,amount,invoiceNumber:reference.invoiceNumber,customerName:reference.customerName};
  const seen=new Set();
  while(rest){
    const remaining=matchPrefix(rest,String.raw`(?:leave|keep)\s+`+MONEY+String.raw`\s+(?:outstanding|remaining)`+END);
    const bookkeeping=matchPrefix(rest,String.raw`this\s+is\s+(?:only\s+)?a\s+(?:dummy|test)\s+bookkeeping\s+entry(?:\s+only)?`+END);
    const quiet=matchPrefix(rest,String.raw`(?:keep\s+reminders\s+paused(?:\s+and\s+do\s+not\s+contact\s+anyone)?|do\s+not\s+contact\s+anyone|keep\s+(?:customer\s+)?messages\s+and\s+reminders\s+off|no\s+(?:customer\s+)?messages\s+or\s+reminders|do\s+not\s+send\s+(?:any\s+)?(?:customer\s+)?messages\s+or\s+reminders)`+END);
    const polite=matchPrefix(rest,String.raw`please`+END);
    const kind=remaining?'remaining':bookkeeping?'bookkeeping':quiet?'quiet':polite?'polite':null;
    const clause=remaining||bookkeeping||quiet||polite;
    if(!clause||seen.has(kind))return null;
    seen.add(kind);
    if(remaining){
      if(remaining[1].toUpperCase()!==currency)return null;
      facts.expectedOutstanding=Number(remaining[2]);
    }
    rest=rest.slice(clause[0].length);
  }
  if(/\bbookkeeping\s+payment\b|\bdisposable\s+QA\b|\bkeep\s+reminders\s+paused\b|\bdo\s+not\s+contact\s+anyone\b/i.test(text))facts.instructionVersion=5;
  return facts;
}

// This guard only denies full settlement; it never authorizes or infers a payment.
// Ambiguous or unsupported amount wording must not become a paid-status action.
export function ownerPaymentAmountMentioned(message) {
  return /\bpartial\s+(?:bookkeeping\s+)?payment\b|\b(?:bookkeeping\s+)?payment\s+(?:of\s+)?(?:[A-Z]{3}\s+)?\d|\b(?:[A-Z]{3}\s+)?\d+(?:\.\d+)?\s+(?:(?:partial|test)\s+)?(?:bookkeeping\s+)?payment\b/i.test(String(message||''));
}
