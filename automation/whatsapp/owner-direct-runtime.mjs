import {createDirectOwnerWriteAdapter} from './direct-owner-write.mjs';
import {resolveWorkspaceRecord} from './workspace-records.mjs';
const TABLE_TYPES={invoices:'invoice',customers:'customer',business_records:'business_record',workspace_settings:'settings',workspace_ai_settings:'ai_settings'};
const data=result=>{if(result?.error)throw result.error;return result?.data;};
export function createOwnerDirectRuntime({supabase,scope,message,messageId,authorize,adapter=createDirectOwnerWriteAdapter({supabase})}){
  return {
    async lookupCompleted(){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      return adapter.lookupCompleted({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,providerMessageId:messageId});
    },
    async execute(params,ctx={}){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      const {table,operation,filters=[],values={}}=params;
      if(!TABLE_TYPES[table]||!['create','update','delete','restore'].includes(operation))return {ok:false,code:'INVALID'};
      let row=null;
      if(operation!=='create'){
        const settings=table.startsWith('workspace_');
        let query=supabase.from(table).select(settings?'workspace_id,updated_at':'id,updated_at').eq('workspace_id',scope.workspaceId);
        if(!settings){
          const found=await resolveWorkspaceRecord({supabase,scope,table,filters,operation,
            assertAuthorized:()=>ctx.assertAuthorized?.(),assertLive:()=>ctx.assertLive?.(),
            select:table==='invoices'?'id,invoice_number,updated_at':table==='business_records'?'id,name,record_type,updated_at':'id,name,company_name,updated_at'});
          if(!found.ok)return found;
          row=found.row;
        }else{
          if(filters.length)return {ok:false,code:'INVALID'};
          row=data(await query.maybeSingle());
        }
      }
      await ctx.assertAuthorized?.();ctx.assertLive?.();
      return adapter.apply({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,
        providerMessageId:messageId,authorization:{kind:'instruction',quote:String(message||'')},
        operation:TABLE_TYPES[table]+'.'+operation,targetId:row?.id||(table.startsWith('workspace_')?scope.workspaceId:null),
        expectedUpdatedAt:row?.updated_at||null,payload:values});
    },
    async decideButton({interactionId,decision,pending}){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      return adapter.apply({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,
        providerMessageId:messageId,interactionId,operation:'pending.decide',
        authorization:{kind:'button',decision,pendingId:pending.id,pendingVersion:pending.version}});
    },
  };
}
