// Resolving a false printed PAID stamp changes the review audit only. The
// extracted stamp, total and balance remain intact; no payment is inferred.
export function invoiceReviewUnpaidResolution({action,message,messageId}) {
  const invoice=action?.invoice,issues=action?.validationIssues;
  if(action?.stage!=='incomplete'||!Array.isArray(issues)||issues.length!==1||issues[0]!=='PAYMENT_STATUS_CONFLICT'
    ||!['paid','conflicting'].includes(action.paymentEvidence?.status)||! /\bPAID\b/i.test(action.paymentEvidence?.text||'')
    ||invoice?.alreadyPaid!==false||typeof invoice.total!=='number'||invoice.total<=0
    ||invoice.outstanding!==invoice.total||!messageId||typeof message!=='string')return null;
  const text=message.normalize('NFKC').replace(/[’‘]/g,"'");
  if(/[?"“”`]|(?:^|\s)'|\b(?:not|never|isn't|wasn't|aren't|don't|didn't|cannot|can't|maybe|perhaps|might|could|would|if|whether|later|tomorrow|next|someone|says|said|quoted)\b/i.test(text))return null;
  if(!/\b(?:my business|our business|we|i)\s+(?:have\s+)?issued\b/i.test(text)
    ||! /\b(?:it|this(?: invoice)?|the invoice)\s+is\s+unpaid\b/i.test(text)
    ||! /\b(?:the\s+)?PAID\s+(?:stamp|marking|watermark)\s+is\s+(?:incorrect|wrong|false)\b/i.test(text))return null;
  if(/\b(?:it|this(?: invoice)?|the invoice)\s+is\s+(?:already\s+)?paid\b|\bPAID\s+(?:stamp|marking|watermark)\s+is\s+(?:correct|right|true)\b/i.test(text))return null;
  if([...text.matchAll(/\bfull\s+[A-Z]{3}\s+\d+(?:\.\d{1,2})?\s+(?:is\s+)?still\s+due\b/gi)].length!==1)return null;
  const balance=text.match(/\b(?:the\s+)?full\s+([A-Z]{3})\s+(\d+(?:\.\d{1,2})?)\s+(?:is\s+)?still\s+due\b/i);
  if(!balance||Number(balance[2])!==invoice.total||invoice.currency&&balance[1].toUpperCase()!==invoice.currency)return null;
  return {status:'unpaid',outstanding:invoice.total,currency:balance[1].toUpperCase(),sourceMessageId:messageId,ownerInstruction:message};
}
