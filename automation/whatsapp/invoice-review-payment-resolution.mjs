import {isSupportedCurrency} from '../../currency-contract.mjs';

// Match complete factual clauses, never keyword fragments. This bounded grammar
// is mirrored in the retained SQL transition; extra claims fail closed.
function retainedUnpaidEvidence(message,total) {
  const normalized=message.toLowerCase().replace(/[ \t\r\n]+/g,' ');
  if(!/^[\x20-\x7e]+$/.test(normalized))return null;
  const text=normalized.trim();
  if(!/^[\x20-\x7e]+$/.test(text)||/[?"'`]/.test(text))return null;
  const clauses=text.split(/[,:;]+|(?<![0-9])[.]|[.](?![0-9])|\band\b/).map(clause=>clause.trim()).filter(Boolean);
  if(clauses.length<4||clauses.length>12)return null;
  const seen=new Set();let currency=null,declaredCurrency=null,amount=null;
  for(const clause of clauses){
    let kind,match;
    if(/^(?:my business|our business|we|i) (?:have )?issued (?:it|this(?: invoice)?|the invoice)$/.test(clause))kind='issuer';
    else if(/^(?:(?:the|that|this) )?paid (?:stamp|marking|watermark) is (?:incorrect|wrong|false)$/.test(clause))kind='stamp';
    else if(/^(?:no payment has been received|nothing has been paid|(?:it|this(?: invoice)?|the invoice) is unpaid)$/.test(clause))kind='unpaid';
    else if((match=clause.match(/^(?:the )?currency is ([a-z]{3})$/))){kind='currency';declaredCurrency=match[1].toUpperCase();}
    else if((match=clause.match(/^(?:the )?full ([a-z]{3}) ?([0-9]+(?:[.][0-9]{1,2})?) (?:is )?still due$/))
      ||(match=clause.match(/^(?:it|this(?: invoice)?|the invoice|(?:the )?(?:total|amount|full balance)) is ([a-z]{3}) ?([0-9]+(?:[.][0-9]{1,2})?)$/))){
      kind='balance';currency=match[1].toUpperCase();amount=Number(match[2]);
    }else if((match=clause.match(/^(?:the )?full balance (?:of )?([0-9]+(?:[.][0-9]{1,2})?) (?:is )?still due$/))){kind='balance';amount=Number(match[1]);}
    else if(/^(?:please )?save (?:it|this(?: invoice)?|the invoice) as an unpaid draft(?: with no customer messages or reminders)?$/.test(clause))kind='save';
    else if(/^(?:please )?keep (?:customer messages or )?reminders off$|^no customer messages or reminders$/.test(clause))kind='quiet';
    else return null;
    if(seen.has(kind))return null;
    seen.add(kind);
  }
  if(!['issuer','stamp','unpaid','balance'].every(kind=>seen.has(kind))||amount!==total
    ||currency&&declaredCurrency&&currency!==declaredCurrency)return null;
  currency=currency||declaredCurrency;
  return isSupportedCurrency(currency)?{currency}:null;
}

// A photo marker alone does not establish inference: printed currencies also
// use it. Recognize only the retained Australian inference evidence we know.
function retainedAustralianCurrencyInference(action) {
  if(action?.invoice?.currency!=='AUD'||![null,undefined,'photo'].includes(action.currencySource)
    ||Object.hasOwn(action.ownerProvidedFacts||{},'currency')||typeof action.currencyEvidence!=='string')return false;
  const evidence=action.currencyEvidence.toLowerCase().replace(/[ \t\r\n]+/g,' ').trim();
  return ['australian details','inferred aud based on australian address'].includes(evidence)
    ||/^melbourne,? (?:vic|victoria) 3000$/.test(evidence);
}

function retainedExtractionAudit(action) {
  return Object.fromEntries(['invoice','paymentEvidence','sourceMessageId','currencySource','currencyEvidence']
    .filter(key=>Object.hasOwn(action,key)).map(key=>[key,action[key]]));
}

// Keep the printed stamp and all source facts. The bounded inferred-currency
// exception audits the original extraction before changing only its currency.
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
  const inferredCurrencyShape=existingConflict&&invoice.direction==='uncertain'
    &&Array.isArray(action.missingFields)&&action.missingFields.length===1&&action.missingFields[0]==='direction'
    &&typeof action.sourceMessageId==='string'&&!!action.sourceMessageId&&retainedAustralianCurrencyInference(action);
  const inferredEvidence=inferredCurrencyShape?retainedUnpaidEvidence(message,invoice.total):null;
  const inferredCurrencyCorrection=!!inferredEvidence&&inferredEvidence.currency!==invoice.currency;
  let currency;
  if(zeroBalanceCorrection||inferredCurrencyCorrection){
    const evidence=inferredCurrencyCorrection?inferredEvidence:retainedUnpaidEvidence(message,invoice.total);
    if(!evidence||invoice.subtotal!=null&&invoice.tax!=null
      &&(!Number.isFinite(invoice.subtotal)||!Number.isFinite(invoice.tax)
        ||Math.round(invoice.subtotal*100)+Math.round(invoice.tax*100)!==Math.round(invoice.total*100)))return null;
    currency=evidence.currency;
  }else{
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
    currency=balance[1].toUpperCase();
    if(invoice.currency&&currency!==invoice.currency)return null;
  }
  return {status:'unpaid',outstanding:invoice.total,currency,sourceMessageId:messageId,ownerInstruction:message,
    ...(zeroBalanceCorrection?{extractedFacts:{currency:invoice.currency,outstanding:invoice.outstanding}}:{}),
    ...(inferredCurrencyCorrection?{extractedFacts:retainedExtractionAudit(action)}:{})};
}
