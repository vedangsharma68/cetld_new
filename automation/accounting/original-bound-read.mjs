import {AccountingError} from './errors.mjs';
import {abortable,boundedZohoRequest,exactMinor} from './zoho-create-receipt.mjs';

export const ORIGINAL_BOUND_READ_TIMEOUT_MS=5000;
const uuid=x=>typeof x==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(x);
const unavailable=()=>new AccountingError('ACCOUNTING_ORIGINAL_READ_UNAVAILABLE','Protected original-account read unavailable');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const required=['invoice_id','customer_id','currency_code','total','payment_made','balance','status','date','due_date','reference_number','credits_applied','write_off_amount'];

// Deadline-aware JSON for the scoped SQL context and optional Zoho refresh.
// No upstream error body is interpreted or returned.
export async function originalReadJson(response,signal,limit=16384){
 if(!response.ok||response.redirected||!response.body||Number(response.headers.get('content-length'))>limit
  ||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))throw unavailable();
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;size+=value.byteLength;if(size>limit)throw unavailable();chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Server library only: no API/action/model registration. A successful inspection
// is NOT evidence accepted by any reminder RPC and never grants delivery rights.
export async function inspectOriginalBoundInvoice({store,accessToken,fetchImpl=fetch,timeoutMs=ORIGINAL_BOUND_READ_TIMEOUT_MS},input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='invoiceId,userId,workspaceId'
  ||!['invoiceId','userId','workspaceId'].every(k=>uuid(input[k])))throw unavailable();
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>ORIGINAL_BOUND_READ_TIMEOUT_MS)throw unavailable();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),signal=controller.signal;
 const identity={userId:input.userId,workspaceId:input.workspaceId,provider:'zoho_books'};
 const step=async fn=>{signal.throwIfAborted();const r=await abortable(Promise.resolve().then(()=>{signal.throwIfAborted();return fn();}),signal);signal.throwIfAborted();return r;};
 try{
  const before=await step(()=>store.originalBoundReadContext(identity,input.invoiceId,{signal}));
  if(!before||before.reminderAuthority!==false||before.invoiceId!==input.invoiceId||before.workspaceId!==input.workspaceId
   ||!uuid(before.epochId)||!/^[a-f\d]{64}$/.test(before.fingerprint||'')
   ||!['com','eu','in','com.au','jp','ca','com.cn','sa'].includes(before.region)
   ||before.apiDomain!==`https://www.zohoapis.${before.region}`||before.accountsDomain!==`https://accounts.zoho.${before.region}`
   ||!['accountId','externalInvoiceId','externalCustomerId'].every(k=>typeof before[k]==='string'&&/^\d{1,40}$/.test(before[k]))
   ||!['INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF'].includes(before.currency)
   ||exactMinor(before.total)===null||BigInt(exactMinor(before.total))<=0n||exactMinor(before.paid)!=='0'
   ||exactMinor(before.balance)!==exactMinor(before.total)||!['sent','overdue'].includes(before.status)
   ||before.reference!==`cetld:${input.invoiceId}`)throw unavailable();
  const expected=await step(()=>store.getConnection(identity));
  if(expected?.status!=='connected'||expected.userId!==input.userId||expected.workspaceId!==input.workspaceId
   ||expected.provider!=='zoho_books'||expected.providerAccountId!==before.accountId
   ||['region','apiDomain','accountsDomain'].some(k=>expected[k]!==before[k]))throw unavailable();
  if(!same(before,await step(()=>store.originalBoundReadContext(identity,input.invoiceId,{signal}))))throw unavailable();
  const {token,connection}=await step(()=>accessToken(identity,{signal,expectedConnection:expected}));
  if(!token?.accessToken||connection?.status!=='connected'||connection.userId!==input.userId||connection.workspaceId!==input.workspaceId
   ||connection.provider!=='zoho_books'||connection.providerAccountId!==before.accountId
   ||['region','apiDomain','accountsDomain'].some(k=>connection[k]!==before[k]||token[k]!==before[k]))throw unavailable();
  const pinned=await step(()=>store.originalBoundReadContext(identity,input.invoiceId,{signal}));
  if(!same(before,pinned))throw unavailable();
  // Exactly one resource GET, never a list/search/retry/404-to-absence fallback.
  const url=new URL(`/books/v3/invoices/${before.externalInvoiceId}`,before.apiDomain);
  url.searchParams.set('organization_id',before.accountId);
  const body=await step(()=>boundedZohoRequest(fetchImpl,url,{headers:{Authorization:`Zoho-oauthtoken ${token.accessToken}`,Accept:'application/json'}},signal));
  const remote=body.invoice;
  if(!remote||typeof remote!=='object'||Array.isArray(remote)||required.some(k=>!Object.hasOwn(remote,k))
   ||remote.invoice_id!==before.externalInvoiceId||remote.customer_id!==before.externalCustomerId
   ||remote.currency_code!==before.currency||remote.status!==before.status||!['sent','overdue'].includes(remote.status)
   ||remote.date!==before.date||remote.due_date!==before.dueDate||remote.reference_number!==before.reference
   ||remote.organization_id!=null&&remote.organization_id!==before.accountId
   ||exactMinor(remote.total)!==exactMinor(before.total)||exactMinor(remote.payment_made)!==exactMinor(before.paid)
   ||exactMinor(remote.balance)!==exactMinor(before.balance)||exactMinor(remote.credits_applied)!=='0'
   ||exactMinor(remote.write_off_amount)!=='0')throw unavailable();
  const after=await step(()=>store.originalBoundReadContext(identity,input.invoiceId,{signal}));
  if(!same(before,after))throw unavailable();
  return Object.freeze({provider:'zoho_books',workspaceId:input.workspaceId,invoiceId:input.invoiceId,
   originalAccountId:before.accountId,region:before.region,externalInvoiceId:before.externalInvoiceId,
   externalCustomerId:before.externalCustomerId,currency:before.currency,total:before.total,paid:before.paid,balance:before.balance,
   status:before.status,date:before.date,dueDate:before.dueDate,checkedAt:new Date().toISOString(),
   existence:'verified',reminderAuthority:false});
 }catch{throw unavailable();}finally{clearTimeout(timer);controller.abort();}
}
