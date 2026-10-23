import {APIError,uuid} from './http.mjs';
import {verifyAccountingActionToken} from './accounting-actions.mjs';
import {saveAssistantInvoice,updateAssistantInvoice} from './invoice-ops.mjs';
import {ownerActionFailure} from './owner-actions.mjs';

// Shared by explicit buttons and a later, standalone chat confirmation. The
// caller supplies the freshly authenticated store; no browser payload is trusted.
export async function confirmAssistantAction({store,confirmationToken,confirmed,env,clock=()=>new Date(),accounting=null}) {
 if(typeof confirmed!=='boolean')throw new APIError(409,'CONFIRMATION_REQUIRED');
 const conversation=store.role==='owner'?store.ownerConversation:null;
 if(conversation)await conversation.read();
 const secret=env.AI_ACCOUNTING_CONFIRMATION_SECRET||env.ACCOUNTING_TOKEN_ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY;
 const action=verifyAccountingActionToken(confirmationToken,{userId:store.userId,workspaceId:store.workspaceId,secret,now:clock().getTime()});
 if(store.role!=='owner'&&(action.payload.changes?.status==='paid'||action.payload.invoice?.alreadyPaid===true))throw new APIError(403,'OWNER_REQUIRED');
 if(action.action.startsWith('owner_')){
  if(!conversation)throw new APIError(403,'OWNER_REQUIRED');
  const result=await conversation.decide(uuid(action.payload.proposalId),confirmed);
  if(result?.ok!==true)throw new APIError(409,result?.code||'OWNER_ACTION_UNAVAILABLE');
  await conversation.append({key:`decision:${action.payload.proposalId}:${confirmed}`,role:'assistant',content:ownerActionFailure(result)});
  return result;
 }
 if(conversation){
  const receipt=await store.ownerAssistantRPC('owner_assistant_claim_token',{p_token:confirmationToken,p_confirmed:confirmed});
  if(receipt?.ok!==true)throw new APIError(409,'ACTION_ALREADY_DECIDED');
  if(receipt.replayed&&receipt.result)return {...receipt.result,replayed:true};
 }
 if(!confirmed){if(conversation)await store.ownerAssistantRPC('owner_assistant_resolve_token',{p_token:confirmationToken,p_status:'cancelled'});return {completed:true,answer:'Canceled. No change was made.'};}
 const result=action.action==='create_invoice'
  ?await saveAssistantInvoice({store,invoice:action.payload.invoice,confirmed:true,idempotencyKey:action.payload.idempotencyKey,accounting})
  :await updateAssistantInvoice({store,...action.payload,confirmed:true});
 if(result.needsInput)return result;
 if(conversation)await store.ownerAssistantRPC('owner_assistant_resolve_token',{p_token:confirmationToken,p_status:'confirmed',p_result:result});
 return result;
}

export function invoiceConfirmationAnswer(result) {
 if(result.answer)return result.answer;
 const number=result.invoice?.invoiceNumber||'';
 return result.saved?`Saved invoice ${number}.`:result.updated?`Updated invoice ${number}.`:'The action could not be confirmed. Check its current status.';
}
