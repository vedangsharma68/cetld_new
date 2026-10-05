/** Optional receipt backend. Both flags default disabled; SQL is not deployed. */
export function createFirstPartyReminderReceiptStore({supabase,env=process.env}={}){
  const isEnabled=()=>env.WHATSAPP_REMINDERS_ENABLED==='true'&&env.WHATSAPP_REMINDER_RECEIPTS_ENABLED==='true'
    &&/^\d{5,30}$/.test(env.WHATSAPP_WABA_ID||'')&&/^\d{5,30}$/.test(env.WHATSAPP_PHONE_NUMBER_ID||'')&&typeof supabase?.rpc==='function';
  return {isEnabled,async status(item){
    if(!isEnabled())return {ok:false,reason:'disabled'};
    if(!/^[a-f0-9]{64}$/.test(item.callbackToken||''))return {ok:false,reason:'unbound'};
    const result=await supabase.rpc('cetld_core_record_first_party_receipt',{
      p_callback_token:item.callbackToken,p_waba_id:env.WHATSAPP_WABA_ID,p_phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID,
      p_phone:item.phone,p_message_id:item.messageId,p_status:item.status,
    });
    if(result.error)throw result.error;
    return result.data;
  }};
}

/** Only the signed webhook's already account-filtered status path may call this
 * store. It cannot choose an owner/workspace/claim from recipient arguments. */
export function createDurableReminderProvider({provider,receiptStore}={}){
  const accepted=new Map();
  return {...(typeof provider?.prepareReminder==='function'?{prepareReminder:input=>provider.prepareReminder(input)}:{}),async sendReminder(input){
    if(receiptStore?.isEnabled?.()!==true)return {status:'blocked',reason:'receipt_backend_disabled'};
    const result=await provider.sendReminder(input);
    if(result.status==='accepted')accepted.set(input.idempotencyKey,{...input,...result});
    return result;
  },async finalizeReminder({idempotencyKey,providerMessageId}){
    const intent=accepted.get(idempotencyKey);
    if(!intent||intent.providerMessageId!==providerMessageId)return {ok:false};
    const result=await receiptStore.status({callbackToken:intent.callbackToken,phone:intent.to,messageId:providerMessageId,status:'accepted'});
    if(result.ok)accepted.delete(idempotencyKey);
    return result;
  }};
}
