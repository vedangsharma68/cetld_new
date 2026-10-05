import {createDirectOwnerWriteAdapter} from './direct-owner-write.mjs';

const SAFE_CODES=new Set(['DENIED','INVALID','NOT_FOUND','STALE','EXPIRED','NO_PENDING_ACTION','PENDING','PAYMENT_GUARD','EXTERNAL_LEDGER','LEDGER_MISMATCH','IN_USE','REPLAY_MISMATCH','UNAVAILABLE']);
const MESSAGES={EXTERNAL_LEDGER:'This invoice is linked to an external accounting ledger. Reopening it from chat is unavailable; no financial change was made.',
  LEDGER_MISMATCH:'The invoice balance does not reconcile with its recorded local payments. Review the ledger before reopening; no financial change was made.',
  IN_USE:'A reminder is currently being delivered. Wait for delivery to finish and review this invoice again.',
  UNAVAILABLE:'Invoice reopening is temporarily unavailable. No confirmed financial change can be reported.',
  STALE:'The invoice or payment history changed after the preview. Start a fresh reopening request.',
  EXPIRED:'The reopening preview expired. Start a fresh request.',PENDING:'Another owner action is pending. Confirm or cancel it first.'};
const fail=code=>{const safe=SAFE_CODES.has(code)?code:'UNAVAILABLE';return {ok:false,completed:false,code:safe,
  ...(safe!=='UNAVAILABLE'?{businessChangeApplied:false}:{}),...(MESSAGES[safe]?{message:MESSAGES[safe]}:{})};};
// Private server adapter: identity, message, amounts and payment IDs never
// come from the model. Native decisions must already pass the HMAC verifier.
export function createInvoiceReopeningRuntime({supabase,scope,message,messageId,authorize}={}){
  const receipts=createDirectOwnerWriteAdapter({supabase});
  const check=async ctx=>{ctx?.assertLive?.();if(!await authorize(scope))throw Error('owner required');await ctx?.assertAuthorized?.();ctx?.assertLive?.();};
  const invoke=async (args,ctx)=>{
    await check(ctx);
    const result=await supabase.rpc('whatsapp_invoice_reopening',{
      p_workspace_id:scope.workspaceId,p_owner_id:scope.ownerId,p_phone:scope.phone,
      p_message_id:messageId,p_user_message:String(message||''),p_invoice_id:null,p_proposal_id:null,
      p_pending_id:null,p_pending_version:null,p_interaction_id:null,...args,
    });
    await check(ctx);
    if(result?.error)return fail('UNAVAILABLE');
    const outcome=Array.isArray(result?.data)?result.data[0]:result?.data;
    return outcome?.ok===true?outcome:fail(outcome?.code);
  };
  return {
    async prepare({invoiceId},ctx){
      try{
        const outcome=await invoke({p_action:'prepare',p_invoice_id:invoiceId},ctx);
        if(!outcome.ok||outcome.alreadyUnpaid)return outcome;
        if(!outcome.requiresConfirmation||typeof outcome.proposalId!=='string')return fail('UNAVAILABLE');
        await check(ctx);
        const stored=await supabase.from('invoice_reopening_proposals').select('id,workspace_id,owner_id,phone,invoice_id,state,expires_at,amount,invoice_number,currency')
          .eq('workspace_id',scope.workspaceId).eq('owner_id',scope.ownerId).eq('phone',scope.phone).eq('id',outcome.proposalId).maybeSingle();
        await check(ctx);const q=stored?.data;
        if(stored?.error||!q||q.workspace_id!==scope.workspaceId||q.owner_id!==scope.ownerId||q.phone!==scope.phone
          ||q.invoice_id!==invoiceId||q.state!=='pending'||Number(q.amount)!==Number(outcome.reversalAmount))return fail('UNAVAILABLE');
        return {...outcome,paymentHistoryPreserved:true,remindersPausedOnConfirmation:true,confirmationText:'yes'};
      }catch{return fail('UNAVAILABLE');}
    },
    async decide({pending,decision,interactionId=null},ctx){
      if(!['confirm','cancel'].includes(decision)||pending?.action?.type!=='owner_invoice_reopen')return fail('INVALID');
      try{
        const outcome=await invoke({p_action:decision,p_proposal_id:pending.action.proposalId,p_pending_id:pending.id,
          p_pending_version:pending.version,p_interaction_id:interactionId},ctx);
        if(!outcome.ok)return outcome;
        await check(ctx);
        const verified=await receipts.lookupCompleted({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,providerMessageId:messageId});
        await check(ctx);
        if(!verified.ok||verified.action!==outcome.action)return fail('UNAVAILABLE');
        return {...outcome,record:verified.record,completed:true};
      }catch{return fail('UNAVAILABLE');}
    },
  };
}
