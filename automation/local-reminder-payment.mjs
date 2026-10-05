/** Optional local checker selected only by the default-disabled reminder mode. */
export function createLocalReminderPaymentChecker({supabase,ownerId,workspaceId}={}){
  if(!supabase?.rpc||!ownerId||!workspaceId)throw new TypeError('Fixed server owner/workspace and client required');
  return async scope=>{
    if(scope.ownerId!==ownerId||scope.workspaceId!==workspaceId||!scope.invoiceId)throw Error('Payment scope mismatch');
    const result=await supabase.rpc('cetld_core_check_local_reminder_payment',{
      p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:scope.invoiceId,
    });
    if(result.error||result.data?.ok!==true||!Number.isSafeInteger(Number(result.data.paidMinor)))throw Error('Local payment verification unavailable');
    return {paidMinor:Number(result.data.paidMinor)};
  };
}
