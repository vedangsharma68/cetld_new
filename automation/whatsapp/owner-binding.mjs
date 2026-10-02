import {normalizeWhatsAppPhone} from './consent.mjs';
const data = result => {if(result?.error)throw result.error;return result?.data;};

// Editable customer metadata is not proof of ownership. Only a code received
// from the WhatsApp sender and verified for the actual owner grants ledger access.
export async function resolveOwnerIdentity({supabase,phone}) {
  phone=normalizeWhatsAppPhone(phone);
  const proofs=data(await supabase.from('whatsapp_owner_verifications')
    .select('workspace_id,requested_by,verified_at,created_at').eq('phone',phone).not('verified_at','is',null)
    .order('created_at',{ascending:false}).limit(100))||[];
  const identities=[];
  for(const workspaceId of new Set(proofs.filter(p=>p.verified_at).map(p=>p.workspace_id))){
    const workspace=data(await supabase.from('workspaces').select('id,owner_id').eq('id',workspaceId).maybeSingle());
    if(!workspace?.owner_id||!proofs.some(p=>p.workspace_id===workspaceId&&p.requested_by===workspace.owner_id&&p.verified_at))continue;
    const member=data(await supabase.from('workspace_members').select('user_id,role')
      .eq('workspace_id',workspaceId).eq('user_id',workspace.owner_id).maybeSingle());
    if(member?.role!=='owner')continue;
    const setting=data(await supabase.from('workspace_settings').select('business_name,whatsapp_owner_phone')
      .eq('workspace_id',workspaceId).maybeSingle());
    if(setting?.whatsapp_owner_phone!==phone||!setting.business_name?.trim())continue;
    identities.push({workspaceId,ownerId:workspace.owner_id,businessName:setting.business_name.trim(),audience:'owner'});
  }
  return identities.length===1?identities[0]:null;
}

export async function resolveOwnerBinding({supabase,phone}) {
  phone=normalizeWhatsAppPhone(phone);
  const identity=await resolveOwnerIdentity({supabase,phone});
  if(!identity)return null;
  const global=data(await supabase.from('whatsapp_global_suppressions').select('phone').eq('phone',phone).maybeSingle());
  const local=data(await supabase.from('whatsapp_suppressions').select('phone').eq('workspace_id',identity.workspaceId).eq('phone',phone).maybeSingle());
  if(global||local)return null;
  const consents=data(await supabase.from('whatsapp_consents').select('customer_id,revoked_at,consented_by')
    .eq('workspace_id',identity.workspaceId).eq('phone',phone).is('revoked_at',null))||[];
  if(consents.length!==1||consents[0].consented_by!==identity.ownerId)return null;
  const customer=data(await supabase.from('customers').select('id,phone,metadata')
    .eq('workspace_id',identity.workspaceId).eq('id',consents[0].customer_id).eq('phone',phone).maybeSingle());
  if(!customer||String(customer.metadata?.whatsapp_owner)!=='true')return null;
  return {...identity,customerId:customer.id};
}

export async function authorizeOwnerPhone({supabase,workspaceId,ownerId,phone}) {
  const binding=await resolveOwnerBinding({supabase,phone});
  return Boolean(binding&&binding.workspaceId===workspaceId&&(!ownerId||binding.ownerId===ownerId));
}
