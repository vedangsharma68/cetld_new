// Approval binds the exact transport form as well as the rendered words. There
// is deliberately no implicit free-form -> template fallback, even when a
// service window expires or its state is unknown. Every retry checks again.
export function reminderDeliveryForm({entry,parameters,body}) {
  return {type:'template',name:entry.name,language:entry.language,revision:entry.revision,
    parameters:[...parameters],body,buttonVariant:entry.buttonVariant===true};
}
export function matchesReminderDelivery(approved,actual) {
  return approved?.type==='template'&&actual?.type==='template'
    &&['name','language','revision','body','buttonVariant'].every(k=>approved[k]===actual[k])
    &&Array.isArray(approved.parameters)&&Array.isArray(actual.parameters)
    &&approved.parameters.length===actual.parameters.length&&approved.parameters.every((v,i)=>v===actual.parameters[i]);
}

// Invoice metadata is member-writable. Only an owner-confirmed proposal or a
// confirmed WhatsApp receipt linked to its retained proposal proves review.
export async function hasPersistedLegacyReminderApproval({supabase,ownerId,workspaceId,invoiceId,delivery,approvedText}) {
  const matches=payload=>payload?.invoiceId===invoiceId&&!payload.template?.reviewedDelivery
    &&payload.preview===delivery.body&&payload.approvalText===approvedText
    &&['name','language','revision'].every(key=>payload.template?.[key]===delivery[key])
    &&JSON.stringify(payload.template?.parameters)===JSON.stringify(delivery.parameters);
  const proposals=await supabase.from('owner_assistant_proposals').select('action,result,state,workspace_id,owner_id')
    .eq('workspace_id',workspaceId).eq('owner_id',ownerId).eq('state','confirmed')
    .eq('action->>type','owner_reminder').eq('action->payload->>invoiceId',invoiceId)
    .order('created_at',{ascending:false}).limit(100);
  if(proposals?.error||!Array.isArray(proposals?.data))return false;
  const scoped=proposals.data.filter(row=>row.workspace_id===workspaceId&&row.owner_id===ownerId&&row.state==='confirmed'
    &&row.action?.type==='owner_reminder'&&row.action.payload?.invoiceId===invoiceId
    &&row.result?.ok===true&&row.result.action==='reminder.approved');
  if(scoped.some(row=>row.action.payload.template?.reviewedDelivery))return false;
  if(scoped.some(row=>matches(row.action.payload)))return true;
  const pending=await supabase.from('whatsapp_pending_actions').select('id,workspace_id,phone,action,consumed_at,version')
    .eq('workspace_id',workspaceId).eq('action->>type','owner_reminder_approval').eq('action->>invoiceId',invoiceId)
    .order('created_at',{ascending:false}).limit(100);
  if(pending?.error||!Array.isArray(pending?.data))return false;
  for(const row of pending.data){
    if(row.workspace_id!==workspaceId||!row.consumed_at||row.action?.type!=='owner_reminder_approval'||!matches(row.action))continue;
    const receipts=await supabase.from('whatsapp_direct_write_receipts').select('workspace_id,owner_id,phone,request,result')
      .eq('workspace_id',workspaceId).eq('owner_id',ownerId).eq('phone',row.phone).eq('request->>operation','reminder.confirm')
      .eq('request->>pendingId',row.id).eq('request->>pendingVersion',row.version).order('created_at',{ascending:false}).limit(1);
    if(receipts?.error||!Array.isArray(receipts?.data))return false;
    if(receipts.data.some(receipt=>receipt.workspace_id===workspaceId&&receipt.owner_id===ownerId&&receipt.phone===row.phone
      &&receipt.request?.operation==='reminder.confirm'&&String(receipt.request.pendingId)===String(row.id)
      &&String(receipt.request.pendingVersion)===String(row.version)&&receipt.result?.ok===true&&receipt.result.action==='reminder.approved'))return true;
  }
  return false;
}
