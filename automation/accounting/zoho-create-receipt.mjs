import {AccountingProviderError} from './errors.mjs';

const currencies=new Set(['INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF']);
const id=value=>typeof value==='string'&&/^\d{1,40}$/.test(value);
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value).toISOString().slice(0,10)===value;
export function exactMinor(value){
 if(!['string','number'].includes(typeof value)||!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(String(value)))return null;
 const [major,fraction='']=String(value).split('.');return (BigInt(major)*100n+BigInt(fraction.padEnd(2,'0'))).toString();
}
export const majorFromMinor=value=>`${BigInt(value)/100n}.${String(BigInt(value)%100n).padStart(2,'0')}`;

export function abortable(promise,signal){
 return new Promise((resolve,reject)=>{
  const aborted=()=>reject(new AccountingProviderError('zoho_books',504,'timeout'));
  if(signal.aborted){aborted();return;}
  signal.addEventListener('abort',aborted,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
 });
}
export async function boundedZohoRequest(fetchImpl,url,options,signal){
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
 const response=await abortable(fetchImpl(url,{...options,redirect:'error',signal:deadline}),deadline);
 if(response.redirected||response.url&&response.url!==String(url)||!response.body||Number(response.headers.get('content-length'))>262144)
  throw new AccountingProviderError('zoho_books',502,'invalid_response');
 if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||'')||response.ok&&![200,201].includes(response.status))
  throw new AccountingProviderError('zoho_books',502,'invalid_response');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await abortable(reader.read(),deadline);if(done)break;size+=value.byteLength;
   if(size>262144)throw new Error('body_limit');chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!response.ok)throw new AccountingProviderError('zoho_books',response.status,/^-?\d{1,8}$/.test(String(body?.code))?String(body.code):'provider_error');
  if(!body||typeof body!=='object'||Array.isArray(body)||body.code!==0)throw new AccountingProviderError('zoho_books',502,'invalid_response');
  return body;
 }catch(error){if(error instanceof AccountingProviderError)throw error;throw new AccountingProviderError('zoho_books',502,'invalid_response');}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Called only at the actual adapter POST boundary. No exported function can
// turn caller metadata/JSON or an ID-only result into a usable capability.
export function validateFreshZohoPost(result,{capture,token,accountId,invoice,body,contact,contactBody,exactContacts,contactLookupComplete,freshSearches,postCount}){
 try{
  if(!capture||capture.canCapture===false||!freshSearches||!contactLookupComplete||exactContacts>1||postCount!==1||!id(accountId)||!id(contact?.contact_id)||!id(body?.invoice?.invoice_id)||body.code!==0)return;
  if(!['com','eu','in','com.au','jp','ca','com.cn','sa'].includes(token.region)
   ||token.apiDomain!==`https://www.zohoapis.${token.region}`||token.accountsDomain!==`https://accounts.zoho.${token.region}`)return;
  const clean=value=>typeof value==='string'?value.trim():'';
  if(clean(contact.contact_name)!==capture.name||capture.email&&clean(contact.email||contact.contact_persons?.find(p=>p.is_primary_contact)?.email)!==capture.email
   ||capture.phone&&clean(contact.phone||contact.contact_persons?.find(p=>p.is_primary_contact)?.phone)!==capture.phone)return;
  // Reuse requires protected same-account customer provenance. Otherwise only
  // a positively confirmed fresh contact creation can resolve local identity.
  if(contactBody){if(contactBody.code!==0||exactContacts!==0||capture.expectedExternalCustomerId)return;}
  else if(exactContacts!==1||!capture.expectedExternalCustomerId||capture.expectedExternalCustomerId!==contact.contact_id)return;
  const r=body.invoice,total=exactMinor(r.total),balance=exactMinor(r.balance),paid=exactMinor(r.payment_made),expected=exactMinor(capture.total);
  if(exactMinor(invoice.total)!==expected||invoice.currency!==capture.currency||invoice.invoiceDate!==capture.invoiceDate||(invoice.dueDate||null)!==capture.dueDate
   ||r.invoice_id!==result.externalId||r.customer_id!==contact.contact_id||r.organization_id!=null&&r.organization_id!==accountId
   ||r.customer_name!==capture.name||!currencies.has(r.currency_code)||r.currency_code!==capture.currency
   ||total===null||total!==expected||total==='0'||balance!==total||paid!=='0'
   ||!['draft','sent','overdue'].includes(r.status)||r.status!==capture.status||!date(r.date)||r.date!==capture.invoiceDate
   ||!Object.hasOwn(r,'due_date')||(r.due_date!==null&&!date(r.due_date))||r.due_date!==capture.dueDate
   ||r.reference_number!==`cetld:${invoice.localInvoiceId}`||typeof r.invoice_number!=='string'||!r.invoice_number.trim()||r.invoice_number.length>100||/[\x00-\x1f\x7f]/.test(r.invoice_number)
   ||r.invoice_number!==invoice.invoiceNumber)return;
  return Object.freeze({provider:'zoho_books',accountId,region:token.region,localInvoiceId:invoice.localInvoiceId,
   localCustomerId:capture.localCustomerId,externalId:r.invoice_id,externalCustomerId:r.customer_id,currency:r.currency_code,
   total:majorFromMinor(total),paid:'0.00',balance:majorFromMinor(balance),status:r.status,date:r.date,dueDate:r.due_date,
   reference:r.reference_number,number:r.invoice_number});
 }catch{ /* Missing/malformed facts are unverified, never synthesized proof. */ }
}
