import {createConversationStore,normalizeOwnerReplyMediaRef} from './conversation-store.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';
import {authorizeOwnerPhone} from './owner-binding.mjs';
import {createOwnerActionButtons} from './owner-action-buttons.mjs';
import {createOwnerNextButtons,normalizeOwnerNextActionRef} from './owner-next-actions.mjs';

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
export function createOwnerReplyStore({supabase,clock=()=>new Date(),env=process.env,
  mediaReader=async(scope,ref)=>createWhatsAppInvoiceStore({supabase,...scope,audience:'owner',authorize:()=>authorizeOwnerPhone({supabase,...scope})}).latestInvoiceFile(ref.invoiceId)}={}) {
  const conversations=createConversationStore(supabase);
  const replayMedia=async(scope,row)=>{
    const ref=normalizeOwnerReplyMediaRef(row.owner_reply_media_ref);
    if(!ref||row.owner_action_ref||row.owner_next_action_ref)throw Error('Invalid stored invoice file receipt');
    const invoice=data(await supabase.from('invoices').select('id,updated_at').eq('workspace_id',scope.workspaceId).eq('id',ref.invoiceId).is('deleted_at',null).maybeSingle());
    if(!invoice||new Date(invoice.updated_at).getTime()!==Date.parse(ref.invoiceUpdatedAt))throw Error('Stored invoice file changed');
    const media=await mediaReader(scope,ref);
    if(!media?.bytes?.length||media.id!==ref.fileId)throw Error('Stored invoice file is unavailable');
    return media;
  };
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
    const row=data(await supabase.from('whatsapp_messages').select('body,kind,status,owner_action_ref,owner_next_action_ref,owner_reply_media_ref')
      .eq('workspace_id',scope.workspaceId).eq('phone',scope.phone).eq('audience','owner')
      .eq('direction','outbound').eq('kind','normal').eq('idempotency_key',`reply:${messageId}`).maybeSingle());
    if(typeof row?.body!=='string'||!row.body.trim())return null;
    const result={answer:row.body,replayMessageId:messageId,replayDeliveryStatus:row.status};
    if(row.owner_reply_media_ref!=null){
      if(['accepted','sent','delivered','read'].includes(row.status))return result;
      return {...result,media:await replayMedia(scope,row)};
    }
    if(row.owner_next_action_ref!=null&&row.owner_action_ref==null){
      const buttons=Array.from(row.body).length<=1024?createOwnerNextButtons({scope,reference:row.owner_next_action_ref,env,clock}):[];
      return buttons.length?{...result,buttons}:result;
    }
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
      const ownerNextActionRef=ownerActionRef?null:normalizeOwnerNextActionRef(result.ownerNextActionRef);
      const choicesExpected=result.ownerNextActionRef==null&&(result.ownerActionRef!=null||(Array.isArray(result.buttons)&&result.buttons.length>0));
      const storedBody=choicesExpected&&!ownerActionRef?OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY:result.answer;
      const stored=await conversations.record({workspaceId:scope.workspaceId,phone:scope.phone,
        customerId:null,invoiceId:null,audience:'owner',direction:'outbound',kind:'normal',status:'pending',
        body:storedBody,key:`reply:${scope.messageId}`,createdAt:new Date(epoch(clock)).toISOString(),ownerActionRef,ownerNextActionRef,ownerReplyMediaRef:result.ownerReplyMediaRef});
      if(!stored?.body||stored.phone!==scope.phone||stored.audience!=='owner'||stored.kind!=='normal')
        throw Object.assign(new Error('Owner reply receipt unavailable'),{code:'OWNER_REPLY_STORE_FAILED'});
      const output={...result,answer:stored.body};
      delete output.ownerActionRef;
      delete output.ownerNextActionRef;
      delete output.ownerReplyMediaRef;
      delete output.buttons;
      if(stored.owner_reply_media_ref!=null)return {...output,media:await replayMedia(scope,stored)};
      if(stored.owner_next_action_ref!=null&&stored.owner_action_ref==null){
        const buttons=Array.from(stored.body).length<=1024?createOwnerNextButtons({scope,reference:stored.owner_next_action_ref,env,clock}):[];
        return buttons.length?{...output,buttons}:output;
      }
      const buttons=await replayButtons(scope,stored.owner_action_ref);
      if(buttons.length)return {...output,buttons};
      if(!choicesExpected)return output;
      const reference=normalizeOwnerActionRef(stored.owner_action_ref);
      return {...output,answer:OWNER_ACTION_CHOICES_UNAVAILABLE_REPLY,...(reference?{ownerActionFallback:reference}:{})};
    },
  };
}
