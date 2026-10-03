import {createConversationStore} from './conversation-store.mjs';
import {createOwnerActionButtons} from './owner-action-buttons.mjs';

const data=result=>{if(result?.error)throw result.error;return result?.data;};
const epoch=clock=>{const value=clock();return value instanceof Date?value.getTime():Number(value);};
export const OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY='I couldn’t restore those approval choices. Please send the change again and I’ll check the current details.';
export function normalizeOwnerActionRef(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['pendingId','pendingVersion'].includes(key)))return null;
  const pendingId=Number(value.pendingId),pendingVersion=Number(value.pendingVersion);
  if(!Number.isSafeInteger(pendingId)||pendingId<1||!Number.isSafeInteger(pendingVersion)||pendingVersion<1)return null;
  return {pendingId,pendingVersion};
}

/** Reuse only replies belonging to the currently verified workspace and phone. */
export function createOwnerReplyStore({supabase,clock=()=>new Date(),env=process.env}={}) {
  const conversations=createConversationStore(supabase);
  const replayButtons=async(scope,reference)=>{
    const ref=normalizeOwnerActionRef(reference);
    if(!ref)return [];
    try{
      const action=data(await supabase.from('whatsapp_pending_actions').select('id,version,workspace_id,phone,action,consumed_at')
        .eq('workspace_id',scope.workspaceId).eq('phone',scope.phone).eq('id',ref.pendingId)
        .eq('version',ref.pendingVersion).is('consumed_at',null).maybeSingle());
      if(!action||action.workspace_id!==scope.workspaceId||action.phone!==scope.phone
        ||Number(action.id)!==ref.pendingId||Number(action.version)!==ref.pendingVersion||action.consumed_at)return [];
      return createOwnerActionButtons({scope:{workspaceId:scope.workspaceId,phone:scope.phone},action,env,clock,
        ...(/delete/.test(action.action?.type||'')?{confirmTitle:'Delete',cancelTitle:'Keep invoice'}:{})});
    }catch{return [];}
  };
  const reply=async(scope,messageId)=>{
    if(typeof messageId!=='string'||!messageId)return null;
    const row=data(await supabase.from('whatsapp_messages').select('body,kind,status,owner_action_ref')
      .eq('workspace_id',scope.workspaceId).eq('phone',scope.phone).eq('audience','owner')
      .eq('direction','outbound').eq('kind','normal').eq('idempotency_key',`reply:${messageId}`).maybeSingle());
    if(typeof row?.body!=='string'||!row.body.trim())return null;
    const result={answer:row.body,replayMessageId:messageId,replayDeliveryStatus:row.status};
    const buttons=await replayButtons(scope,row.owner_action_ref);
    if(buttons.length)return {...result,buttons};
    if(row.owner_action_ref==null)return result;
    const reference=normalizeOwnerActionRef(row.owner_action_ref);
    return {...result,answer:OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY,...(reference?{ownerActionFallback:reference}:{})};
  };
  return {
    async find(scope) {
      // Only provider redelivery is a duplicate. A repeated question with a new
      // message ID must see current dashboard/database state, even seconds later.
      return reply(scope,scope.messageId);
    },
    async save(scope,result) {
      if(!scope.messageId||!result?.answer?.trim())return result;
      const ownerActionRef=normalizeOwnerActionRef(result.ownerActionRef);
      const choicesExpected=result.ownerActionRef!=null||(Array.isArray(result.buttons)&&result.buttons.length>0);
      const storedBody=choicesExpected&&!ownerActionRef?OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY:result.answer;
      const stored=await conversations.record({workspaceId:scope.workspaceId,phone:scope.phone,
        customerId:null,invoiceId:null,audience:'owner',direction:'outbound',kind:'normal',status:'pending',
        body:storedBody,key:`reply:${scope.messageId}`,createdAt:new Date(epoch(clock)).toISOString(),ownerActionRef});
      if(!stored?.body||stored.phone!==scope.phone||stored.audience!=='owner'||stored.kind!=='normal')
        throw Object.assign(new Error('Owner reply receipt unavailable'),{code:'OWNER_REPLY_STORE_FAILED'});
      const output={...result,answer:stored.body};
      delete output.ownerActionRef;
      delete output.buttons;
      const buttons=await replayButtons(scope,stored.owner_action_ref);
      if(buttons.length)return {...output,buttons};
      if(!choicesExpected)return output;
      const reference=normalizeOwnerActionRef(stored.owner_action_ref);
      return {...output,answer:OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY,...(reference?{ownerActionFallback:reference}:{})};
    },
  };
}
