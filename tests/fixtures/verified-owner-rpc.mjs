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
  const prior=typeof supabase.rpc==='function'?supabase.rpc.bind(supabase):null;
  const calls=supabase.rpcCalls||(supabase.rpcCalls=[]);
  supabase.rpc=async(name,args={})=>{
    calls.push({name,args:structuredClone(args)});
    if(name==='whatsapp_resolve_verified_owner'){
      if(expectedPhone&&args.p_phone!==expectedPhone)throw new Error('owner RPC phone scope mismatch');
      return {data:verifiedOwnerRows(getTables(),args.p_phone),error:null};
    }
    return prior?prior(name,args):{data:null,error:null};
  };
  return supabase;
}
