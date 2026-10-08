import {isSupportedCurrency} from '../../currency-contract.mjs';
import {validateCustomFields} from './workspace-records.mjs';
import {invoiceBusinessFields as displayInvoiceBusinessFields} from '../../invoice/business-fields.mjs';

export const INVOICE_CORRECTION_FIELDS=Object.freeze(['invoice_number','customer_id','customer_name','issue_date','due_date','currency','total_amount','notes','custom_fields',
  'subtotal','tax','discount','line_items','invoice_direction','seller_name','buyer_name','payment_information']);
export const INVOICE_BUSINESS_METADATA_FIELDS=Object.freeze(['subtotal','tax','discount','line_items','invoice_direction','seller_name','buyer_name','payment_information']);
export const INVOICE_EXTENDED_CORRECTION_FIELDS=Object.freeze(['customer_id','customer_name',...INVOICE_BUSINESS_METADATA_FIELDS]);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const invalid=()=>{throw new TypeError('invalid invoice correction');};
// A single explicit date in the current instruction is evidence, not a model
// inference. Ambiguous dates and mixed due/issue references require planning.
export function requestedInvoiceDateChange(message){
  const text=String(message||''),dates=[...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match=>match[0]);
  if(dates.length!==1||!/\b(?:change|update|set|move|extend)\b/i.test(text))return null;
  const due=/\bdue\s+date\b/i.test(text),issue=/\bissue\s+date\b/i.test(text);
  if(due===issue)return null;
  const clause=text.split(/[.;!?\n]+/).find(part=>part.includes(dates[0])&&(due?/\bdue\s+date\b/i:/\bissue\s+date\b/i).test(part));
  if(!clause||!/^\s*(?:(?:please|only)\s+)*(?:change|update|set|move|extend)\b/i.test(clause)||/["'“”]/.test(clause)
    ||/\b(?:do not|don't|never|cannot|can't|not to|avoid)\b/i.test(clause)
    ||!new RegExp(`\\b(?:change|update|set|move|extend)\\b[^.;!?\\n]{0,120}\\b${due?'due':'issue'}\\s+date\\b`,'i').test(clause))return null;
  try{date(dates[0]);}catch{return null;}
  return {field:due?'due_date':'issue_date',value:dates[0],only:/^\s*(?:please\s+)?only\s+(?:change|update|set)\s+(?:the\s+)?(?:due|issue)\s+date\b/i.test(text)};
}
// Explicit current instructions constrain completeness before dispatch; they
// neither authorize ledger currency changes nor synthesize financial writes.
export function requestedInvoiceMoneyChange(message){
  const requests=[],ambiguous=()=>({ambiguous:true});
  for(const clause of String(message||'').split(/(?:[;!?\n]|\.(?=\s|$))+/)){
    if(!/^\s*(?:please\s+)?(?:set|change|update)\b/i.test(clause)||/["'“”]/.test(clause)
      ||/\b(?:not|never|avoid|if|unless|maybe|previously|earlier)\b/i.test(clause))continue;
    const labels=[...clause.matchAll(/\b(subtotal|total(?:_amount)?|tax|discount)\b/gi)].filter(label=>{
      const verb=[...clause.slice(0,label.index).matchAll(/\b(set|change|update|keep|leave|preserve)\b/gi)].at(-1)?.[1];
      return !/^(?:keep|leave|preserve)$/i.test(verb||'');
    });
    if(!labels.length||/\b(?:notes?|description|payment\s+(?:information|instructions?))\b/i.test(clause.slice(0,labels[0].index)))continue;
    const amounts=[...clause.matchAll(/\b([A-Z]{3})\s+(\d[\d,]*(?:\.\d+)?)\b|\b(\d[\d,]*(?:\.\d+)?)\s+([A-Z]{3})\b/gi)]
      .filter(match=>isSupportedCurrency((match[1]||match[4]).toUpperCase()));
    if(!amounts.length)continue;
    if(/\b(?:either|or)\b/i.test(clause))return ambiguous();
    const currencies=[...new Set([...clause.matchAll(/\b[A-Z]{3}\b/gi)].map(match=>match[0].toUpperCase()).filter(isSupportedCurrency))];
    if(currencies.length!==1)return ambiguous();
    const values={},pending=[];
    for(let index=0;index<labels.length;index++){
      const label=labels[index],field=/^total/i.test(label[1])?'total_amount':label[1].toLowerCase();pending.push(field);
      const segment=clause.slice(label.index+label[0].length,labels[index+1]?.index??clause.length)
        .replace(/\b[A-Z]+(?:[-/][A-Z0-9]+)+\b/gi,'');
      const assignment=segment.split(/\b(?:due|issue)\s+date\b|\b(?:quantity|keep|leave|preserve)\b/i)[0];
      const numbers=[...assignment.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)];
      const zeros=[...assignment.matchAll(/\bzero\b/gi)];
      if(!numbers.length&&!zeros.length)continue;
      if(numbers.length+zeros.length!==1)return ambiguous();
      const raw=numbers[0]?.[0]||'0';if(!/^(?:\d{1,12}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw))return ambiguous();
      let amount;try{amount=money(raw.replaceAll(',','')).value;}catch{return ambiguous();}
      for(const item of pending){if(Object.hasOwn(values,item)&&values[item]!==amount)return ambiguous();values[item]=amount;}
      pending.length=0;
    }
    if(pending.length)return ambiguous();
    requests.push({currency:currencies[0],values});
  }
  if(!requests.length)return null;
  const currency=requests[0].currency,values={};
  for(const request of requests){
    if(request.currency!==currency)return ambiguous();
    for(const [field,value] of Object.entries(request.values)){
      if(Object.hasOwn(values,field)&&values[field]!==value)return ambiguous();
      values[field]=value;
    }
  }
  return {currency,values};
}
function money(value){
  if(!['string','number'].includes(typeof value)||!/^\d{1,12}(?:\.\d{1,2})?$/.test(String(value)))return invalid();
  const [whole,fraction='']=String(value).split('.');const minor=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(minor>BigInt(Number.MAX_SAFE_INTEGER))return invalid();
  return {value:Number(minor)/100,minor};
}
function text(value,max,{nullable=false,multiline=false}={}){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!value.trim()||value.trim().length>max||(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/:/[\x00-\x1f\x7f]/).test(value))return invalid();
  return value.trim();
}
function date(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return invalid();
  const parsed=new Date(value+'T00:00:00Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)return invalid();
  return value;
}
export function validateInvoiceCorrection(values){
  if(!object(values)||!Object.keys(values).length||Object.keys(values).some(key=>!INVOICE_CORRECTION_FIELDS.includes(key)))return invalid();
  if(Buffer.byteLength(JSON.stringify(values),'utf8')>32768)return invalid();
  const clean={};
  for(const [key,value] of Object.entries(values)){
    if(['total_amount','subtotal','tax','discount'].includes(key)){
      clean[key]=money(value).value;if(key==='total_amount'&&clean[key]<=0)return invalid();
    }else if(key==='line_items'){
      if(!Array.isArray(value)||value.length>100)return invalid();
      clean[key]=value.map(item=>{
        if(!object(item)||Object.keys(item).some(field=>!['description','quantity','unitPrice','amount','confidence'].includes(field)))return invalid();
        const line={description:text(item.description,500),amount:money(item.amount).value};
        if(item.quantity!==undefined){
          if(item.quantity===null)line.quantity=null;
          else if(typeof item.quantity!=='number'||!/^\d+(?:\.\d{1,4})?$/.test(String(item.quantity))||item.quantity<=0||item.quantity>1000000)return invalid();
          else line.quantity=item.quantity;
        }
        if(item.unitPrice!==undefined)line.unitPrice=item.unitPrice===null?null:money(item.unitPrice).value;
        if(line.quantity!=null&&line.unitPrice!=null){
          const quantity=BigInt(Math.round(line.quantity*10000));
          if((quantity*money(line.unitPrice).minor+5000n)/10000n!==money(line.amount).minor)return invalid();
        }
        if(item.confidence!==undefined){if(item.confidence!==null&&(typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1))return invalid();line.confidence=item.confidence;}
        return line;
      });
    }else if(key==='custom_fields')clean[key]=validateCustomFields(value);
    else if(key==='currency'){clean[key]=text(value,3).toUpperCase();if(!isSupportedCurrency(clean[key]))return invalid();}
    else if(key==='issue_date'||key==='due_date')clean[key]=key==='due_date'&&value===null?null:date(value);
    else if(key==='invoice_direction'){if(!['receivable','payable'].includes(value))return invalid();clean[key]=value;}
    else if(key==='customer_id'){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))return invalid();clean[key]=value;}
    else clean[key]=text(value,{invoice_number:100,customer_name:255,notes:4000,seller_name:255,buyer_name:255,payment_information:2000}[key],{nullable:['notes','seller_name','buyer_name','payment_information'].includes(key),multiline:['notes','payment_information'].includes(key)});
  }
  if(clean.customer_id!==undefined&&clean.customer_name!==undefined)return invalid();
  if(clean.issue_date&&clean.due_date&&clean.due_date<clean.issue_date)return invalid();
  return clean;
}

// Only a bounded business projection is visible to the model; metadata itself,
// source/audit controls, credentials and reminder/security fields stay private.
export function invoiceBusinessFields(row){
  const fields=displayInvoiceBusinessFields(row);
  return Object.fromEntries(INVOICE_BUSINESS_METADATA_FIELDS.map(key=>[key,fields[key]]));
}
