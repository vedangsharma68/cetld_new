import {normalizeWhatsAppPhone} from './consent.mjs';
const data = result => {if(result?.error)throw result.error;return result?.data;};
const verifiedBindings=new WeakMap();

function checkedOwnerBinding(row,phone) {
  if(!row||typeof row!=='object'||Array.isArray(row)
      ||typeof row.workspace_id!=='string'||typeof row.owner_id!=='string'||typeof row.customer_id!=='string'
      ||typeof row.business_name!=='string'||!row.business_name.trim())return null;
  const binding={workspaceId:row.workspace_id,ownerId:row.owner_id,businessName:row.business_name.trim(),
    audience:'owner',customerId:row.customer_id};
  verifiedBindings.set(binding,phone);
  return binding;
}

export function isVerifiedOwnerBinding(binding,scope={}) {
  if(!binding||typeof binding!=='object'||!verifiedBindings.has(binding))return false;
  const phone=typeof scope.phone==='string'?normalizeWhatsAppPhone(scope.phone):null;
  return typeof scope.workspaceId==='string'&&binding.workspaceId===scope.workspaceId
    &&typeof scope.ownerId==='string'&&binding.ownerId===scope.ownerId
    &&typeof scope.customerId==='string'&&binding.customerId===scope.customerId
    &&Boolean(phone)&&phone===verifiedBindings.get(binding);
}

// Editable customer metadata is not proof of ownership. Only a code received
// from the WhatsApp sender and verified for the actual owner grants ledger access.
export async function resolveOwnerIdentity({supabase,phone}) {
  phone=normalizeWhatsAppPhone(phone);
  const proofs=data(await supabase.from('whatsapp_owner_verifications')
    .select('workspace_id,requested_by,verified_at,created_at').eq('phone',phone).not('verified_at','is',null)
    .order('created_at',{ascending:false}).limit(100))||[];
  const workspaceIds=[...new Set(proofs.filter(p=>p.verified_at).map(p=>p.workspace_id))];
  const workspaces=await Promise.all(workspaceIds.map(async workspaceId=>data(await supabase.from('workspaces')
    .select('id,owner_id').eq('id',workspaceId).maybeSingle())));
  const identities=(await Promise.all(workspaces.filter(workspace=>workspace?.owner_id
    &&proofs.some(p=>p.workspace_id===workspace.id&&p.requested_by===workspace.owner_id&&p.verified_at))
    .map(async workspace=>{
      const [member,setting]=await Promise.all([
        supabase.from('workspace_members').select('user_id,role').eq('workspace_id',workspace.id).eq('user_id',workspace.owner_id).maybeSingle(),
        supabase.from('workspace_settings').select('business_name,whatsapp_owner_phone').eq('workspace_id',workspace.id).maybeSingle(),
      ].map(async query=>data(await query)));
      if(member?.role!=='owner'||setting?.whatsapp_owner_phone!==phone||!setting.business_name?.trim())return null;
      return {workspaceId:workspace.id,ownerId:workspace.owner_id,businessName:setting.business_name.trim(),audience:'owner'};
    }))).filter(Boolean);
  return identities.length===1?identities[0]:null;
}

export async function resolveOwnerBinding({supabase,phone}) {
  phone=normalizeWhatsAppPhone(phone);
  const rows=data(await supabase.rpc('whatsapp_resolve_verified_owner',{p_phone:phone}));
  if(!Array.isArray(rows)||rows.length!==1)return null;
  return checkedOwnerBinding(rows[0],phone);
}

export async function authorizeOwnerPhone({supabase,workspaceId,ownerId,phone}) {
  const binding=await resolveOwnerBinding({supabase,phone});
  return Boolean(binding&&binding.workspaceId===workspaceId&&(!ownerId||binding.ownerId===ownerId));
}
