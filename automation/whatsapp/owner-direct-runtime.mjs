import {createDirectOwnerWriteAdapter} from './direct-owner-write.mjs';
const TABLE_TYPES={invoices:'invoice',customers:'customer',workspace_settings:'settings',workspace_ai_settings:'ai_settings'};
const data=result=>{if(result?.error)throw result.error;return result?.data;};
export function createOwnerDirectRuntime({supabase,scope,message,messageId,authorize,adapter=createDirectOwnerWriteAdapter({supabase})}){
  return {
    async lookupCompleted(){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      return adapter.lookupCompleted({workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,providerMessageId:messageId});
    },
    async execute(params){
      if(!await authorize(scope))return {ok:false,code:'DENIED'};
      const {table,operation,filters=[],values={}}=params;
      if(!TABLE_TYPES[table]||!['create','update','delete','restore'].includes(operation))return {ok:false,code:'INVALID'};
      let row=null;
      if(operation!=='create'){
        const settings=table.startsWith('workspace_');
        let query=supabase.from(table).select(settings?'workspace_id,updated_at':'id,updated_at').eq('workspace_id',scope.workspaceId);
        if(!settings){
          const allowed=table==='invoices'?['id','invoice_number']:['id','name','company_name','email','phone'];
          if(filters.length!==1||filters[0].operator!=='eq'||!allowed.includes(filters[0].column))return {ok:false,code:'AMBIGUOUS'};
          query=query.eq(filters[0].column,filters[0].value);
          if(table==='invoices'&&operation!=='restore')query=query.is('deleted_at',null);
          const rows=data(await query.limit(2))||[];
          if(rows.length!==1)return {ok:false,code:rows.length?'AMBIGUOUS':'NOT_FOUND'};
          row=rows[0];
        }else{
          if(filters.length)return {ok:false,code:'INVALID'};
          row=data(await query.maybeSingle());
        }
      }
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
