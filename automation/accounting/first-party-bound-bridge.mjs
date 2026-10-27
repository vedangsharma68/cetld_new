import {abortable} from './zoho-create-receipt.mjs';
import {hasExternalReminderLedger} from '../external-reminder-verification.mjs';

// Only the first-party runtime constructs this instance. Handles and candidate
// tokens never enter engine input, invoice metadata, a model or an API result.
export function createFirstPartyBoundBridge({supabase,store,accounting,ownerId,workspaceId,fetchImpl=fetch}){
 const attempts=new Map();let candidate;
 const scope=invoiceId=>({userId:ownerId,workspaceId,invoiceId});
 const rpc=async(action,invoiceId,claimId=null,payload={},signal)=>{
  const controller=signal?null:new AbortController(),deadline=signal||controller.signal,timer=controller?setTimeout(()=>controller.abort(),5000):null;
  try{
   deadline.throwIfAborted();
   let query=supabase.rpc('cetld_zoho_bound_reminder',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:invoiceId,p_action:action,p_claim_id:claimId,p_payload:payload});
   if(query.abortSignal)query=query.abortSignal(deadline);
   const r=await abortable(Promise.resolve(query),deadline);if(r.error)throw Error('Bound reminder unavailable');return r.data;
  }finally{if(timer)clearTimeout(timer);controller?.abort();}
 };
 const getCandidate=()=>candidate ||= (typeof accounting==='function'?accounting():accounting).createBoundClaimProtocol(async(action,args,{signal}={})=>{
  const id=args.p_invoice,entry=attempts.get(id);
  if(action==='claim'){
   const r=await rpc('claim',id,null,{},signal);
   if(!r?.ok)throw Error('Bound claim unavailable');
   attempts.set(id,{id:r.claimId,version:r.invoiceVersion,handle:null,final:null,receipt:null});
   return {...r,state:'claimed'};
  }
  if(!entry||entry.id!==args.p_claim)throw Error('Bound claim unavailable');
  let name=action,payload={};
  if(action==='check')payload={nonce:args.p_nonce};
  if(action==='reserve')entry.permitStarted=performance.now();
  if(action==='reserve')payload={nonce:args.p_nonce,attempt:args.p_attempt,facts:args.p_facts};
  if(action==='quarantine'){name='failed';payload={unknown:true};}
  if(action==='begin_post'){
   if(!entry.final)throw Error('Bound final snapshot unavailable');
   const snapshot=entry.final;entry.final=null;
   const r=await rpc('final',id,entry.id,{...snapshot,attempt:args.p_attempt,permit:args.p_permit},AbortSignal.any([signal,entry.finalSignal]));
   if(r?.authorized!==true){entry.reviewNeeded=r?.reason==='needs_re_review';throw Error('Bound final unavailable');}
   entry.finalSignal.throwIfAborted();
   if(performance.now()-entry.permitStarted>=2000)throw Error('Bound permit expired');
   entry.receipt=r;entry.granted=true;
   // Candidate result stays non-authoritative. The ONLY dispatch response used
   // by the sender is the real final policy RPC reservation above, not a flag.
   return {state:'posting',deliveryAuthority:false};
  }
  return rpc(name,id,entry.id,payload,signal);
 },fetchImpl);
 const requireEntry=(invoiceId,claimId)=>{
  const e=attempts.get(invoiceId);if(!e||claimId&&e.id!==claimId)throw Error('Bound claim unavailable');return e;
 };
 const bridge={
  has:invoiceId=>attempts.has(invoiceId),
  async payment(input){
   const e=requireEntry(input.invoiceId),r=await rpc('payment',input.invoiceId,e.id);
   if(r?.ok!==true||Number(r.paidMinor)!==0)throw Error('Bound payment unavailable');return {paidMinor:0};
  },
  async final({invoiceId,claimId,snapshot,hash}){
   const e=requireEntry(invoiceId,claimId);if(!e.handle||e.final||e.receipt)throw Error('Bound attempt already consumed');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);e.finalSignal=controller.signal;e.finalStarted=performance.now();
   try{
    const p=await getCandidate().reserve(e.handle);
    e.final={snapshot,hash};
    await getCandidate().beginDispatch(p);
    const receipt=e.receipt;e.receipt=null;
    controller.signal.throwIfAborted();
    if(receipt?.authorized!==true||performance.now()-e.permitStarted>=2000)throw Error('Bound final unavailable');return {data:receipt,error:null};
   }catch(error){if(e.reviewNeeded)throw Object.assign(Error('Reminder needs re-review'),{code:'DELIVERY_REVIEW_REQUIRED'});throw error;}finally{clearTimeout(timer);controller.abort();}
  },
  consumePost(invoiceId){
   const e=attempts.get(invoiceId);if(!e?.granted||e.posted||performance.now()-e.permitStarted>=2000||performance.now()-e.finalStarted>=5000)return false;
   e.posted=true;return true;
  },
  store:new Proxy(store,{get(target,key){
   if(key==='claimDueFollowups')return async input=>{
    if(input.ownerId!==ownerId||input.workspaceId!==workspaceId||!input.invoiceId||input.limit!==1)return target.claimDueFollowups(input);
    const invoice=await target.getInvoice(input);
    if(!invoice||!hasExternalReminderLedger(invoice))return target.claimDueFollowups(input);
    // Legacy/unsupported/current-account diagnostics fail here, before creating
    // an accounting client, token preparation or provider requests.
    const admitted=await rpc('eligible',input.invoiceId);if(admitted?.ok!==true)return [];
    const h=await getCandidate().claim(scope(input.invoiceId)),e=requireEntry(input.invoiceId);e.handle=h;
    return [{id:e.id,invoiceId:input.invoiceId,invoiceVersion:Number(e.version)}];
   };
   if(key==='authorizeDelivery')return async input=>{
    if(!attempts.has(input.invoiceId))return target.authorizeDelivery(input);
    const e=requireEntry(input.invoiceId,input.claimId);
    return rpc('authorize',input.invoiceId,e.id,{preferencesVersion:input.preferencesVersion});
   };
   if(key==='markDeliveryFailed')return async input=>{
    if(!attempts.has(input.invoiceId))return target.markDeliveryFailed(input);
    const e=requireEntry(input.invoiceId,input.claimId);
    return rpc('failed',input.invoiceId,e.id,{unknown:Boolean(input.unknown),token:input.token??null,error:String(input.error||'unavailable').slice(0,250)});
   };
   if(key==='markDeliverySent')return async input=>{
    if(attempts.has(input.invoiceId))throw Error('Bound delivery requires its reserved receipt');
    return target.markDeliverySent(input);
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }}),
 };
 return Object.freeze(bridge);
}
