export function verifiedOwnerRows(tables,phone) {
  const results=[];
  const proofs=tables.whatsapp_owner_verifications||[];
  const settings=tables.workspace_settings||[];
  const members=tables.workspace_members||[];
  const workspaces=tables.workspaces||[];
  const consents=tables.whatsapp_consents||[];
  const customers=tables.customers||[];
  const globalSuppressed=(tables.whatsapp_global_suppressions||[]).some(row=>row.phone===phone);
  if(globalSuppressed)return results;
  for(const workspace of workspaces){
    const setting=settings.find(row=>row.workspace_id===workspace.id&&row.whatsapp_owner_phone===phone
      &&typeof row.business_name==='string'&&row.business_name.trim());
    if(!setting||!members.some(row=>row.workspace_id===workspace.id&&row.user_id===workspace.owner_id&&row.role==='owner'))continue;
    if(!(proofs||[]).some(row=>row.workspace_id===workspace.id&&row.phone===phone
        &&row.requested_by===workspace.owner_id&&row.verified_at))continue;
    if((tables.whatsapp_suppressions||[]).some(row=>row.workspace_id===workspace.id&&row.phone===phone))continue;
    for(const consent of consents.filter(row=>row.workspace_id===workspace.id&&row.phone===phone
        &&row.consented_by===workspace.owner_id&&row.revoked_at==null)){
      const customer=customers.find(row=>row.workspace_id===workspace.id&&row.id===consent.customer_id
        &&row.phone===phone&&String(row.metadata?.whatsapp_owner)==='true');
      if(customer)results.push({workspace_id:workspace.id,owner_id:workspace.owner_id,customer_id:customer.id,
        business_name:setting.business_name});
    }
  }
  return results;
}

export function installVerifiedOwnerRpc(supabase,getTables,{expectedPhone=null}={}) {
  const sharedTurns=[];
  const prior=typeof supabase.rpc==='function'?supabase.rpc.bind(supabase):null;
  const calls=supabase.rpcCalls||(supabase.rpcCalls=[]);
  supabase.rpc=async(name,args={})=>{
    calls.push({name,args:structuredClone(args)});
    if(name==='owner_assistant_append'){
      const turns=getTables().owner_assistant_turns||sharedTurns;
      if(!turns.some(t=>t.event_key===args.p_event_key))turns.push({id:turns.length+1,event_key:args.p_event_key,workspace_id:args.p_workspace_id,owner_id:args.p_owner_id,channel:args.p_channel,role:args.p_role,content:args.p_content,created_at:new Date().toISOString(),source_message_id:args.p_channel==='whatsapp'&&args.p_role==='user'?args.p_event_key.slice(3,-5):null});
      return {data:{id:turns.length},error:null};
    }
    if(name==='owner_assistant_pending')return {data:null,error:null};
    if(name==='owner_assistant_history'){
      const turns=getTables().owner_assistant_turns||sharedTurns;
      // Mirror the real owner-only whatsapp_messages synchronization trigger.
      for(const row of getTables().whatsapp_messages||[]){
        if(row.workspace_id!==args.p_workspace_id||row.audience!=='owner'||String(row.idempotency_key||'').startsWith('ack:')||!row.body)continue;
        const role=row.direction==='inbound'?'user':'assistant';
        const key=role==='user'&&row.provider_message_id?'wa:'+row.provider_message_id+':user':String(row.idempotency_key||'').startsWith('reply:')?'wa:'+row.idempotency_key.slice(6)+':assistant':'wa-message:'+row.id;
        if(!turns.some(t=>t.event_key===key||t.role===role&&t.content===row.body))turns.push({id:turns.length+1,event_key:key,role,content:row.body,created_at:row.created_at,source_message_id:row.provider_message_id,channel:'whatsapp',workspace_id:args.p_workspace_id,owner_id:args.p_owner_id});
      }
      return {data:turns.filter(t=>t.workspace_id===args.p_workspace_id&&(!t.owner_id||t.owner_id===args.p_owner_id)).slice(-20),error:null};
    }
    if(name==='whatsapp_resolve_verified_owner'){
      if(expectedPhone&&args.p_phone!==expectedPhone)throw new Error('owner RPC phone scope mismatch');
      return {data:verifiedOwnerRows(getTables(),args.p_phone),error:null};
    }
    return prior?prior(name,args):{data:null,error:null};
  };
  return supabase;
}
