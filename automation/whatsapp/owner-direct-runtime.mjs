import {ownerPartialPaymentAvailable} from './owner-payment-readback.mjs';
import {ownerPaymentAmountMentioned} from './owner-payment-intent.mjs';
import {createDirectOwnerWriteAdapter} from './direct-owner-write.mjs';
import {resolveWorkspaceRecord} from './workspace-records.mjs';
const TABLE_TYPES={invoices:'invoice',customers:'customer',business_records:'business_record',workspace_settings:'settings',workspace_ai_settings:'ai_settings'};
const data=result=>{if(result?.error)throw result.error;return result?.data;};
export function createOwnerDirectRuntime({supabase,scope,message,messageId,authorize,adapter=createDirectOwnerWriteAdapter({supabase,invoiceCorrectionsEnabled:true})}){
  return {
    async lookupCompleted(){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      return adapter.lookupCompleted({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,providerMessageId:messageId});
    },
    async executeBatch(params,ctx={}){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      const operations=[],seen=new Set();
      for(const item of params.operations){
        const {table,operation,filters=[],values={}}=item;
        if(!TABLE_TYPES[table]||!['create','update'].includes(operation)||Object.hasOwn(values,'status'))return {ok:false,code:'INVALID'};
        let row=null;
        if(operation==='update'){
          if(table.startsWith('workspace_')){
            if(filters.length)return {ok:false,code:'INVALID'};
            row=data(await supabase.from(table).select('workspace_id,updated_at').eq('workspace_id',scope.workspaceId).maybeSingle());
          }else{
            const found=await resolveWorkspaceRecord({supabase,scope,table,filters,operation,assertAuthorized:()=>ctx.assertAuthorized?.(),assertLive:()=>ctx.assertLive?.(),
              select:table==='invoices'?'id,invoice_number,updated_at':'id,name,updated_at'});
            if(!found.ok)return found;row=found.row;
          }
          if(!row&&table!=='workspace_ai_settings')return {ok:false,code:'NOT_FOUND'};
          const key=table+':'+(row?.id||scope.workspaceId);
          if(seen.has(key))return {ok:false,code:'INVALID',message:'Combine changes to the same record in one operation.'};seen.add(key);
        }
        operations.push({operation:TABLE_TYPES[table]+'.'+operation,targetId:row?.id||(table.startsWith('workspace_')?scope.workspaceId:null),expectedUpdatedAt:row?.updated_at||null,payload:values});
      }
      await ctx.assertAuthorized?.();ctx.assertLive?.();ctx.markWriteAttempted?.();
      return adapter.applyBatch({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,providerMessageId:messageId,
        authorization:{kind:'instruction',quote:String(message||'')},operations});
    },
    async execute(params,ctx={}){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      const {table,operation,filters=[],values={}}=params;
      if(!TABLE_TYPES[table]||!['create','update','delete','restore'].includes(operation))return {ok:false,code:'INVALID'};
      if(table==='invoices'&&operation==='update'&&values.status==='paid'&&ownerPaymentAmountMentioned(message))return {ok:false,completed:false,code:'PAYMENT_GUARD',message:'Use an exact amount payment proposal. Marking paid would settle the full balance. No payment was recorded.'};
      let row=null;
      if(operation!=='create'){
        const settings=table.startsWith('workspace_');
        let query=supabase.from(table).select(settings?'workspace_id,updated_at':'id,updated_at').eq('workspace_id',scope.workspaceId);
        if(!settings){
          const found=await resolveWorkspaceRecord({supabase,scope,table,filters,operation,
            assertAuthorized:()=>ctx.assertAuthorized?.(),assertLive:()=>ctx.assertLive?.(),
            select:table==='invoices'?'id,invoice_number,updated_at,metadata':table==='business_records'?'id,name,record_type,updated_at':'id,name,company_name,updated_at'});
          if(!found.ok)return found;
          row=found.row;
        }else{
          if(filters.length)return {ok:false,code:'INVALID'};
          row=data(await query.maybeSingle());
        }
      }
      let payload=values;
      // The unchanged-currency completeness check must refer to the same
      // version that the SQL correction locks, including concurrent edits.
      if(ctx.invoiceCorrectionReadGuard&&(table!=='invoices'||operation!=='update'
        ||row?.id!==ctx.invoiceCorrectionReadGuard.id||row?.updated_at!==ctx.invoiceCorrectionReadGuard.updatedAt))return {ok:false,completed:false,code:'STALE'};
      if(table==='invoices'&&operation==='update'&&values.status==='paid'&&row?.metadata?.invoice_direction!=='receivable')
        return {ok:false,completed:false,code:'PAYMENT_GUARD',message:'Recording money received requires a receivable invoice. No payment was recorded.'};
      if(table==='invoices'&&operation==='update'&&values.customer_name!==undefined){
        const customer=await resolveWorkspaceRecord({supabase,scope,table:'customers',operation:'update',filters:[{column:'name',operator:'eq',value:values.customer_name}],select:'id,name,updated_at',
          assertAuthorized:()=>ctx.assertAuthorized?.(),assertLive:()=>ctx.assertLive?.()});
        if(!customer.ok)return customer;
        payload={...values,customer_id:customer.row.id};delete payload.customer_name;
      }
      await ctx.assertAuthorized?.();ctx.assertLive?.();
      return adapter.apply({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,
        providerMessageId:messageId,authorization:{kind:'instruction',quote:String(message||'')},
        operation:TABLE_TYPES[table]+'.'+operation,targetId:row?.id||(table.startsWith('workspace_')?scope.workspaceId:null),
        expectedUpdatedAt:row?.updated_at||null,payload});
    },
    async decideButton({interactionId,decision,pending}){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      if(decision==='confirm'&&pending?.action?.type==='owner_invoice_payment'&&pending.action.changes?.amount!==undefined&&!await ownerPartialPaymentAvailable(supabase))return {ok:false,code:'UNAVAILABLE',message:'Exact amount payment confirmation is not available. No payment was recorded.'};
      return adapter.apply({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,
        providerMessageId:messageId,interactionId,operation:'pending.decide',
        authorization:{kind:'button',decision,pendingId:pending.id,pendingVersion:pending.version}});
    },
  };
}
