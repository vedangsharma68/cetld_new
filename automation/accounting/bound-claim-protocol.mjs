import {randomUUID} from 'node:crypto';
import {AccountingError} from './errors.mjs';
import {abortable,boundedZohoRequest,exactMinor} from './zoho-create-receipt.mjs';

const uuid=x=>typeof x==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(x);
const fail=()=>new AccountingError('BOUND_CLAIM_UNAVAILABLE','Protected claim protocol unavailable');
// Standalone candidate protocol: these opaque handles are never delivery
// authority. The first-party bridge composes them with the real final policy
// transaction; no caller flag, informational read or candidate result can send.
export function createDisabledZohoClaimProtocol({executor,store,accessToken,fetchImpl=fetch}={}){
 if(typeof executor!=='function'||!store?.getConnection||typeof accessToken!=='function')throw fail();
 const claims=new WeakMap(),permits=new WeakMap(),receipts=new WeakMap();
 const call=async(scope,action,extra={},options={})=>{
  const controller=options.signal?null:new AbortController(),signal=options.signal||controller.signal;
  const timer=controller?setTimeout(()=>controller.abort(),5000):null;
  try{signal.throwIfAborted();return await abortable(Promise.resolve().then(()=>{signal.throwIfAborted();return executor(action,{p_owner:scope.userId,p_workspace:scope.workspaceId,p_invoice:scope.invoiceId,...extra},{signal});}),signal);}
  catch{throw fail();}finally{if(timer)clearTimeout(timer);controller?.abort();}
 };
 const valid=r=>r&&r.deliveryAuthority===false;
 const recover=async c=>{
  try{const r=await call(c.scope,'recover',{p_claim:c.id});return valid(r)?{state:r.state,attemptId:r.attemptId||null,deliveryAuthority:false}:null;}catch{return null;}
 };
 return Object.freeze({
  async claim(scope){
   if(!scope||typeof scope!=='object'||Array.isArray(scope)||Object.keys(scope).sort().join(',')!=='invoiceId,userId,workspaceId'||!Object.values(scope).every(uuid))throw fail();
   const saved=Object.freeze({...scope}),r=await call(saved,'claim');
   if(!valid(r)||r.state!=='claimed'||!uuid(r.claimId))throw fail();
   const handle=Object.freeze({});claims.set(handle,{scope:saved,id:r.claimId,readStarted:false});return handle;
  },
  async reserve(handle){
   const c=claims.get(handle);if(!c||c.readStarted)throw fail();c.readStarted=true;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000),signal=controller.signal;
   const step=async fn=>{signal.throwIfAborted();const r=await abortable(Promise.resolve().then(()=>{signal.throwIfAborted();return fn();}),signal);signal.throwIfAborted();return r;};
   try{
    const challenge=await step(()=>call(c.scope,'challenge',{p_claim:c.id},{signal})),x=challenge?.context,nonce=challenge?.nonce;
    if(!valid(challenge)||challenge.state!=='challenged'||!uuid(nonce)||!x||x.reminderAuthority!==false
     ||x.invoiceId!==c.scope.invoiceId||x.workspaceId!==c.scope.workspaceId||!uuid(x.epochId)
     ||!['com','eu','in','com.au','jp','ca','com.cn','sa'].includes(x.region)
     ||x.apiDomain!==`https://www.zohoapis.${x.region}`||x.accountsDomain!==`https://accounts.zoho.${x.region}`
     ||!['accountId','externalInvoiceId','externalCustomerId'].every(k=>typeof x[k]==='string'&&/^\d{1,40}$/.test(x[k])))throw fail();
    const identity={userId:c.scope.userId,workspaceId:c.scope.workspaceId,provider:'zoho_books'};
    const expected=await step(()=>store.getConnection(identity));
    const matches=connection=>connection?.status==='connected'&&connection.userId===identity.userId&&connection.workspaceId===identity.workspaceId
     &&connection.provider==='zoho_books'&&connection.providerAccountId===x.accountId&&['region','apiDomain','accountsDomain'].every(k=>connection[k]===x[k]);
    if(!matches(expected))throw fail();
    const {connection,token}=await step(()=>accessToken(identity,{signal,expectedConnection:expected}));
    if(!matches(connection)||!token?.accessToken||['region','apiDomain','accountsDomain'].some(k=>token[k]!==x[k]))throw fail();
    const checked=await step(()=>call(c.scope,'check',{p_claim:c.id,p_nonce:nonce},{signal}));
    if(!valid(checked)||JSON.stringify(checked.context)!==JSON.stringify(x))throw fail();
    const url=new URL(`/books/v3/invoices/${x.externalInvoiceId}`,x.apiDomain);url.searchParams.set('organization_id',x.accountId);
    const r=(await step(()=>boundedZohoRequest(fetchImpl,url,{headers:{Authorization:`Zoho-oauthtoken ${token.accessToken}`,Accept:'application/json'}},signal))).invoice;
    if(!r||r.invoice_id!==x.externalInvoiceId||r.customer_id!==x.externalCustomerId||r.currency_code!==x.currency
     ||!['sent','overdue'].includes(r.status)||r.status!==x.status||r.date!==x.date||r.due_date!==x.dueDate||r.reference_number!==x.reference
     ||r.organization_id!=null&&r.organization_id!==x.accountId||exactMinor(r.total)===null||exactMinor(r.total)!==exactMinor(x.total)
     ||exactMinor(r.payment_made)!=='0'||exactMinor(r.payment_made)!==exactMinor(x.paid)||exactMinor(r.balance)!==exactMinor(x.balance)
     ||exactMinor(r.credits_applied)!=='0'||exactMinor(r.write_off_amount)!=='0')throw fail();
    const facts={...x};for(const key of ['fingerprint','epochId','apiDomain','accountsDomain','reminderAuthority','workspaceId','invoiceId'])delete facts[key];
    facts.creditsApplied='0';facts.writeOff='0';
    const attempt=randomUUID(),reserved=await step(()=>call(c.scope,'reserve',{p_claim:c.id,p_attempt:attempt,p_nonce:nonce,p_facts:facts},{signal}));
    if(!valid(reserved)||reserved.state!=='reserved'||reserved.attemptId!==attempt||!/^[a-f\d]{64}$/.test(reserved.permit||''))throw fail();
    const permit=Object.freeze({});permits.set(permit,{...c,attempt,token:reserved.permit});return permit;
   }catch{
    // No invoice GET retry and no recovered permit after an uncertain commit.
    try{await call(c.scope,'quarantine',{p_claim:c.id},{signal});}catch{}
    throw fail();
   }finally{clearTimeout(timer);controller.abort();}
  },
  async beginDispatch(permit){
   const p=permits.get(permit);if(!p)throw fail();permits.delete(permit);
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000),signal=controller.signal;
   try{
    const r=await call(p.scope,'begin_post',{p_claim:p.id,p_attempt:p.attempt,p_permit:p.token},{signal});
    if(!valid(r)||r.state!=='posting')throw fail();
    const receipt=Object.freeze({});receipts.set(receipt,p);return Object.freeze({receipt,deliveryAuthority:false});
   }catch{try{await call(p.scope,'quarantine',{p_claim:p.id},{signal});}catch{}throw fail();}
   finally{clearTimeout(timer);controller.abort();}
  },
  async recordReceipt(receipt,{messageId,status}={}){
   const p=receipts.get(receipt);if(!p||typeof messageId!=='string'||messageId.length<1||messageId.length>256||!['accepted','sent','delivered','read','failed'].includes(status))throw fail();
   const r=await call(p.scope,'receipt',{p_claim:p.id,p_attempt:p.attempt,p_permit:p.token,p_message_id:messageId,p_status:status});
   if(!valid(r))throw fail();return Object.freeze({state:r.state,deliveryAuthority:false});
  },
  async quarantine(receipt){
   const p=receipts.get(receipt);if(!p)throw fail();await call(p.scope,'quarantine',{p_claim:p.id});return {deliveryAuthority:false};
  },
  async recover(handle){const c=claims.get(handle);if(!c)throw fail();return recover(c);}
 });
}
