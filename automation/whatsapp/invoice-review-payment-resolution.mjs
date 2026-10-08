import {isSupportedCurrency} from '../../currency-contract.mjs';

// Keep the printed stamp and all source facts. A zero-balance extraction needs
// an explicit correction audit before currency and balance can be corrected.
export function invoiceReviewUnpaidResolution({action,message,messageId}) {
  const invoice=action?.invoice,issues=action?.validationIssues;
  const zeroBalanceCorrection=Array.isArray(issues)&&issues.length===2
    &&issues.includes('PAYMENT_RECORD_REQUIRES_REVIEW')&&issues.includes('PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD')
    &&invoice?.outstanding===0&&invoice.direction==='uncertain'&&isSupportedCurrency(invoice.currency)
    &&Array.isArray(action.missingFields)&&action.missingFields.length===1&&action.missingFields[0]==='direction'
    &&[null,undefined,'photo'].includes(action.currencySource)&&!Object.hasOwn(action.ownerProvidedFacts||{},'currency')
    &&action.paymentEvidence?.status==='paid';
  const existingConflict=Array.isArray(issues)&&issues.length===1&&issues[0]==='PAYMENT_STATUS_CONFLICT'
    &&invoice?.outstanding===invoice?.total;
  if(action?.stage!=='incomplete'||Object.hasOwn(action,'paymentStatusResolution')||(!existingConflict&&!zeroBalanceCorrection)
    ||!['paid','conflicting'].includes(action.paymentEvidence?.status)||! /\bPAID\b/i.test(action.paymentEvidence?.text||'')
    ||invoice?.alreadyPaid!==false||typeof invoice.total!=='number'||!Number.isFinite(invoice.total)||invoice.total<=0
    ||!messageId||typeof message!=='string'||messageId===action.sourceMessageId||message.length>4000)return null;
  const text=message.normalize('NFKC').replace(/[’‘]/g,"'");
  if(/[?"“”`]|(?:^|\s)'|\b(?:not|never|isn't|wasn't|aren't|don't|didn't|cannot|can't|maybe|perhaps|might|could|would|if|whether|later|tomorrow|next|someone|says|said|quoted)\b/i.test(text))return null;
  const explicitUnpaid=/\b(?:it|this(?: invoice)?|the invoice)\s+is\s+unpaid\b/i.test(text)
    ||/\bno payment has been received\b/i.test(text)&&/\bsave (?:it|this(?: invoice)?|the invoice) as an unpaid draft\b/i.test(text);
  const affirmative=text.replace(/\bno payment has been received\b/gi,'');
  if(/\bpayment (?:has been|was|is) received\b|\breceived (?:a |the )?payment\b/i.test(affirmative))return null;
  if(!/\b(?:my business|our business|we|i)\s+(?:have\s+)?issued\b/i.test(text)
    ||!explicitUnpaid
    ||! /\b(?:the\s+)?PAID\s+(?:stamp|marking|watermark)\s+is\s+(?:incorrect|wrong|false)\b/i.test(text))return null;
  if(/\b(?:it|this(?: invoice)?|the invoice)\s+is\s+(?:already\s+)?paid\b|\bPAID\s+(?:stamp|marking|watermark)\s+is\s+(?:correct|right|true)\b/i.test(text))return null;
  if([...text.matchAll(/\bfull\s+[A-Z]{3}\s+\d+(?:\.\d{1,2})?\s+(?:is\s+)?still\s+due\b/gi)].length!==1)return null;
  const balance=text.match(/\b(?:the\s+)?full\s+([A-Z]{3})\s+(\d+(?:\.\d{1,2})?)\s+(?:is\s+)?still\s+due\b/i);
  if(!balance||Number(balance[2])!==invoice.total||!isSupportedCurrency(balance[1].toUpperCase()))return null;
  const currency=balance[1].toUpperCase();
  if(zeroBalanceCorrection){
    // This correction has a closed instruction grammar: additional payment or
    // editing claims must never be interpreted as a harmless trailing clause.
    const correctionInstruction=new RegExp('^\\s*(?:my business|our business|we|i)\\s+(?:have\\s+)?issued\\s+this\\s+invoice\\.\\s+(?:the\\s+)?currency\\s+is\\s+'
      +currency+'\\.\\s+(?:the\\s+)?PAID\\s+(?:stamp|marking|watermark)\\s+is\\s+(?:incorrect|wrong|false):\\s+no payment has been received,\\s+and\\s+(?:the\\s+)?full\\s+'
      +currency+'\\s+\\d+(?:\\.\\d{1,2})?\\s+is\\s+still\\s+due\\.\\s+save it as an unpaid draft with no customer messages or reminders\\.?\\s*$','i');
    if(!correctionInstruction.test(text)
      ||invoice.subtotal!=null&&invoice.tax!=null
        &&(!Number.isFinite(invoice.subtotal)||!Number.isFinite(invoice.tax)
          ||Math.round(invoice.subtotal*100)+Math.round(invoice.tax*100)!==Math.round(invoice.total*100)))return null;
  }else if(invoice.currency&&currency!==invoice.currency)return null;
  return {status:'unpaid',outstanding:invoice.total,currency,sourceMessageId:messageId,ownerInstruction:message,
    ...(zeroBalanceCorrection?{extractedFacts:{currency:invoice.currency,outstanding:invoice.outstanding}}:{})};
}
