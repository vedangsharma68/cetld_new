import {createHash} from 'node:crypto';

const OPERATIONS=new Set([
  'invoice.create','invoice.update','invoice.delete','invoice.restore',
  'customer.create','customer.update','customer.delete',
  'business_record.create','business_record.update',
  'settings.update','ai_settings.update','pending.decide',
]);

const TABLES=Object.freeze({
  business_record:{table:'business_records',select:'id,workspace_id,record_type,name,custom_fields,created_at,updated_at'},
  invoice:{table:'invoices',select:'id,workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,amount_paid,status,notes,custom_fields,metadata,created_at,updated_at,deleted_at,deleted_by'},
  customer:{table:'customers',select:'id,workspace_id,name,company_name,email,phone,custom_fields,metadata,created_at,updated_at'},
  settings:{table:'workspace_settings',select:'workspace_id,business_name,default_currency,default_timezone,follow_up_preferences,owner_bot_preferences,updated_at'},
  ai_settings:{table:'workspace_ai_settings',select:'workspace_id,primary_model,fallback_model,updated_at'},
  pending:{table:'whatsapp_pending_actions',select:'id,workspace_id,customer_id,phone,action,consumed_at,version,generation'},
});

const SAFE_CODES=new Set([
  'ACTION_PENDING','ALREADY_DELETED','AMBIGUOUS','DATABASE_UNAVAILABLE','DENIED','EXPIRED',
  'IN_USE','INVALID','INVALID_AUTHORIZATION','INVOICE_EXISTS','NO_PENDING_ACTION','NOT_FOUND',
  'NO_RECEIPT','PAYMENT_GUARD','REPLAY_MISMATCH','STALE','UNDO_EXPIRED','UNAVAILABLE','WRITE_UNCONFIRMED',
]);

function failure(code){return {ok:false,completed:false,code:SAFE_CODES.has(code)?code:'DATABASE_UNAVAILABLE'};}
function valueOf(result){return Array.isArray(result?.data)?result.data[0]:result?.data;}
function validUuid(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
function validPhone(value){return typeof value==='string'&&/^\+[1-9][0-9]{7,14}$/.test(value);}
function minorUnits(value){
  if(typeof value!=='string'&&typeof value!=='number')return null;
  const match=/^([0-9]{1,12})(?:\.([0-9]{1,2}))?$/.exec(String(value));
  if(!match)return null;
  return BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0'));
}
function isSettledPaidInvoice(record){
  const paid=minorUnits(record?.amount_paid);
  const total=minorUnits(record?.total_amount);
  return record?.status==='paid'&&paid!==null&&total!==null&&paid>=total;
}
function stableKey({workspaceId,ownerId,phone,providerMessageId,operation,targetId}){
  const digest=createHash('sha256').update(JSON.stringify([workspaceId,ownerId,phone,providerMessageId,operation,targetId??null])).digest('hex');
  return `ownerwrite_${digest.slice(0,48)}`;
}
function validAuthorization(input){
  const auth=input?.authorization;
  if(auth?.kind==='instruction'){
    return input.operation!=='pending.decide'&&typeof auth.quote==='string'&&auth.quote.length>0&&auth.quote.length<=4000
      &&input.interactionId==null;
  }
  if(auth?.kind==='button'){
    return input.operation==='pending.decide'&&['confirm','cancel'].includes(auth.decision)
      &&Number.isSafeInteger(Number(auth.pendingId))&&Number(auth.pendingId)>0
      &&Number.isSafeInteger(Number(auth.pendingVersion))&&Number(auth.pendingVersion)>0
      &&typeof input.interactionId==='string'&&input.interactionId.length>0&&input.interactionId.length<=256;
  }
  return false;
}

async function readPersistedRecord({supabase,workspaceId,entityType,entityId,outcome}){
  const spec=TABLES[entityType];
  if(!spec||!validUuid(workspaceId)
    ||(entityType==='pending'?!/^\d{1,18}$/.test(entityId):!validUuid(entityId)))return null;
  let query=supabase.from(spec.table).select(spec.select).eq('workspace_id',workspaceId);
  if(entityType==='pending')query=query.eq('id',Number(entityId)).eq('phone',outcome.phone);
  else if(entityType==='settings'||entityType==='ai_settings'){
    if(entityId!==workspaceId)return null;
  }else query=query.eq('id',entityId);
  const result=await query.maybeSingle();
  if(result?.error)throw result.error;
  return result?.data||null;
}

/**
 * Server-only mutation adapter. Caller must supply an owner binding from the
 * verified webhook context. Button authorizations must have passed the caller's
 * HMAC verifier; the RPC independently checks their stored pending row/version.
 */
export function createDirectOwnerWriteAdapter({supabase}={}){
  if(!supabase?.rpc||!supabase?.from)throw new TypeError('Service-role Supabase client required');
  return Object.freeze({
    async lookupCompleted({workspaceId,ownerId,phone,providerMessageId}={}){
      if(!validUuid(workspaceId)||!validUuid(ownerId)||!validPhone(phone)
        ||typeof providerMessageId!=='string'||providerMessageId.length<1||providerMessageId.length>256)return failure('INVALID');
      let receipt;
      try{
        const result=await supabase.from('whatsapp_direct_write_receipts')
          .select('workspace_id,owner_id,phone,provider_message_id,result')
          .eq('workspace_id',workspaceId).eq('owner_id',ownerId).eq('phone',phone)
          .eq('provider_message_id',providerMessageId).maybeSingle();
        if(result?.error)return failure('DATABASE_UNAVAILABLE');
        receipt=result?.data;
      }catch{return failure('DATABASE_UNAVAILABLE');}
      if(!receipt)return failure('NO_RECEIPT');
      if(receipt.workspace_id!==workspaceId||receipt.owner_id!==ownerId||receipt.phone!==phone
        ||receipt.provider_message_id!==providerMessageId)return failure('DENIED');
      const outcome=receipt.result;
      if(outcome?.ok===true&&outcome.action==='batch.completed'){
        if(outcome.entityId!==workspaceId||!Array.isArray(outcome.results)||outcome.results.length<2||outcome.results.length>10)return failure('WRITE_UNCONFIRMED');
        const results=[];
        for(const child of outcome.results){
          if(child?.ok!==true||child.completed!==true||!TABLES[child.entityType]||child.entityType==='pending')return failure('WRITE_UNCONFIRMED');
          let record;
          try{record=await readPersistedRecord({supabase,workspaceId,entityType:child.entityType,entityId:child.entityId,outcome:child});}catch{return failure('WRITE_UNCONFIRMED');}
          if(!record||record.workspace_id!==workspaceId||child.updatedAt&&record.updated_at!==child.updatedAt)return failure('WRITE_UNCONFIRMED');
          results.push({...child,record});
        }
        return {ok:true,completed:true,action:'batch.completed',results,replayed:true};
      }
      if(outcome?.ok!==true||typeof outcome.entityType!=='string'||typeof outcome.entityId!=='string')return failure('NO_RECEIPT');
      let record;
      try{record=await readPersistedRecord({supabase,workspaceId,entityType:outcome.entityType,
        entityId:outcome.entityId,outcome:{...outcome,phone}});}
      catch{return failure('WRITE_UNCONFIRMED');}
      if(outcome.entityType==='customer'&&outcome.action==='customer.deleted'){
        if(record)return failure('WRITE_UNCONFIRMED');
        record=outcome.record;
        if(!record||record.workspace_id!==workspaceId||record.id!==outcome.entityId)return failure('WRITE_UNCONFIRMED');
      }else if(!record)return failure('WRITE_UNCONFIRMED');
      if(record.workspace_id!==workspaceId)return failure('WRITE_UNCONFIRMED');
      if(outcome.entityType==='pending'){
        if(!record.consumed_at)return failure('WRITE_UNCONFIRMED');
        record={id:record.id,workspace_id:record.workspace_id,actionType:record.action?.type||null,consumed_at:record.consumed_at};
      }else{
        if(!['settings','ai_settings'].includes(outcome.entityType)&&record.id!==outcome.entityId)return failure('WRITE_UNCONFIRMED');
        if(outcome.updatedAt&&record.updated_at!==outcome.updatedAt)return failure('WRITE_UNCONFIRMED');
        if(outcome.entityType==='invoice'&&outcome.action==='invoice.deleted'&&!record.deleted_at)return failure('WRITE_UNCONFIRMED');
        if(outcome.entityType==='invoice'&&outcome.action==='invoice.restored'&&record.deleted_at!==null)return failure('WRITE_UNCONFIRMED');
        if(outcome.entityType==='invoice'&&outcome.action==='invoice.paid'&&!isSettledPaidInvoice(record))return failure('WRITE_UNCONFIRMED');
        if(outcome.entityType==='invoice'&&outcome.action==='invoice.reopened'
          &&(minorUnits(record.amount_paid)!==0n||!['sent','overdue'].includes(record.status)))return failure('WRITE_UNCONFIRMED');
      }
      return {ok:true,completed:true,action:outcome.action,entityType:outcome.entityType,
        entityId:outcome.entityId,record,replayed:true,...(outcome.action==='invoice.reopened'?{invoiceNumber:outcome.invoiceNumber,currency:outcome.currency,
          reversedAmount:outcome.reversedAmount,balanceAfter:outcome.balanceAfter,paymentCount:outcome.paymentCount,paymentHistoryPreserved:true,cashRefund:false}: {})};
    },
    async applyBatch({workspaceId,ownerId,phone,providerMessageId,authorization,operations}={}){
      if(!validUuid(workspaceId)||!validUuid(ownerId)||!validPhone(phone)||typeof providerMessageId!=='string'||providerMessageId.length<1||providerMessageId.length>256
        ||authorization?.kind!=='instruction'||typeof authorization.quote!=='string'||!authorization.quote||authorization.quote.length>4000
        ||!Array.isArray(operations)||operations.length<2||operations.length>10)return failure('INVALID');
      for(const item of operations)if(!OPERATIONS.has(item?.operation)||!['create','update'].includes(item.operation.split('.').at(-1))
        ||item.payload?.status!==undefined||!item.payload||typeof item.payload!=='object'||Array.isArray(item.payload)
        ||item.targetId!==null&&!validUuid(item.targetId)||item.expectedUpdatedAt!==null&&!Number.isFinite(Date.parse(item.expectedUpdatedAt)))return failure('INVALID');
      let result;
      try{result=await supabase.rpc('whatsapp_apply_owner_batch',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_provider_message_id:providerMessageId,
        p_authorization_quote:authorization.quote,p_operations:operations});}catch{return failure('WRITE_UNCONFIRMED');}
      if(result?.error)return failure('WRITE_UNCONFIRMED');
      const outcome=valueOf(result);
      if(outcome?.ok!==true)return {...failure(outcome?.code),...(outcome?.rolledBack===true?{rolledBack:true,failedOperation:outcome.failedOperation}:{})};
      return this.lookupCompleted({workspaceId,ownerId,phone,providerMessageId});
    },
    async apply(input={}){
      const {workspaceId,ownerId,phone,providerMessageId,interactionId=null,authorization,operation,
        targetId=null,expectedUpdatedAt=null,payload={}}=input;
      if(!validUuid(workspaceId)||!validUuid(ownerId)||!validPhone(phone)
        ||typeof providerMessageId!=='string'||providerMessageId.length<1||providerMessageId.length>256
        ||!OPERATIONS.has(operation)||!validAuthorization({...input,interactionId,operation})
        ||!payload||typeof payload!=='object'||Array.isArray(payload))return failure('INVALID');
      if(operation!=='pending.decide'&&authorization.kind==='instruction'
        &&targetId!==null&&!validUuid(targetId))return failure('INVALID');
      if(operation==='pending.decide'&&(targetId!==null||expectedUpdatedAt!==null||Object.keys(payload).length))return failure('INVALID');
      if(expectedUpdatedAt!==null&&(typeof expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(expectedUpdatedAt))))return failure('INVALID');
      if(operation.endsWith('.create')&&targetId!==null)return failure('INVALID');
      if(operation.endsWith('.update')||operation.endsWith('.delete')||operation.endsWith('.restore')){
        if(!validUuid(targetId))return failure('INVALID');
        if(operation!=='ai_settings.update'&&expectedUpdatedAt===null)return failure('INVALID');
      }
      if(authorization.kind==='button'&&authorization.decision==='cancel'&&operation!=='pending.decide')return failure('INVALID');

      const idempotencyKey=stableKey({workspaceId,ownerId,phone,providerMessageId,operation,targetId});
      let result;
      try{
        result=await supabase.rpc('whatsapp_apply_direct_owner_write',{
          p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,
          p_provider_message_id:providerMessageId,p_interaction_id:interactionId,
          p_idempotency_key:idempotencyKey,p_operation:operation,p_target_id:targetId,
          p_expected_updated_at:expectedUpdatedAt,p_authorization_kind:authorization.kind,
          p_authorization_quote:authorization.kind==='instruction'?authorization.quote:null,
          p_button_decision:authorization.kind==='button'?authorization.decision:null,
          p_pending_id:authorization.kind==='button'?Number(authorization.pendingId):null,
          p_pending_version:authorization.kind==='button'?Number(authorization.pendingVersion):null,
          p_payload:payload,
        });
      }catch{return failure('DATABASE_UNAVAILABLE');}
      if(result?.error)return failure('DATABASE_UNAVAILABLE');
      const outcome=valueOf(result);
      if(outcome?.ok!==true)return failure(outcome?.code);
      const entityType=outcome.entityType;
      const entityId=String(outcome.entityId||'');
      const readOutcome={...outcome,phone};
      let record;
      try{record=await readPersistedRecord({supabase,workspaceId,entityType,entityId,outcome:readOutcome});}
      catch{return failure('WRITE_UNCONFIRMED');}

      // A physical customer delete is verified by the scoped absence read;
      // the transaction receipt retains the removed public snapshot.
      if(entityType==='customer'&&outcome.action==='customer.deleted'){
        if(record)return failure('WRITE_UNCONFIRMED');
        record=outcome.record;
        if(!record||record.workspace_id!==workspaceId||record.id!==entityId)return failure('WRITE_UNCONFIRMED');
      }else if(!record)return failure('WRITE_UNCONFIRMED');
      if(record.workspace_id!==workspaceId)return failure('WRITE_UNCONFIRMED');
      if(entityType==='pending'){
        if(!record.consumed_at)return failure('WRITE_UNCONFIRMED');
        record={id:record.id,workspace_id:record.workspace_id,actionType:record.action?.type||null,consumed_at:record.consumed_at};
      }else{
        if(entityType!=='settings'&&entityType!=='ai_settings'&&record.id!==entityId)return failure('WRITE_UNCONFIRMED');
        if(outcome.updatedAt&&record.updated_at!==outcome.updatedAt)return failure('WRITE_UNCONFIRMED');
        if(entityType==='invoice'&&outcome.action==='invoice.deleted'&&!record.deleted_at)return failure('WRITE_UNCONFIRMED');
        if(entityType==='invoice'&&outcome.action==='invoice.restored'&&record.deleted_at!==null)return failure('WRITE_UNCONFIRMED');
        if(entityType==='invoice'&&outcome.action==='invoice.paid'&&!isSettledPaidInvoice(record))return failure('WRITE_UNCONFIRMED');
      }
      return {ok:true,completed:true,action:outcome.action,entityType,entityId,record,replayed:outcome.replayed===true};
    },
  });
}

export {stableKey as directOwnerWriteIdempotencyKey};
