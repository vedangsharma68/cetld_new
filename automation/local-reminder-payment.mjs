import {reminderPaymentRpc,hasExternalReminderLedger} from './external-reminder-verification.mjs';
/** Optional local checker selected only by the default-disabled reminder mode. */
export function createLocalReminderPaymentChecker({supabase,ownerId,workspaceId,accounting,env=process.env,fetchImpl=fetch}={}){
  if(!supabase?.rpc||!ownerId||!workspaceId)throw new TypeError('Fixed server owner/workspace and client required');
  return async scope=>{
    if(scope.ownerId!==ownerId||scope.workspaceId!==workspaceId||!scope.invoiceId)throw Error('Payment scope mismatch');
    const row=scope.invoice&&!hasExternalReminderLedger(scope.invoice)?{data:scope.invoice}:
      await supabase.from('invoices').select('*').eq('workspace_id',workspaceId).eq('id',scope.invoiceId).maybeSingle();
    if(row.error||!row.data)throw Error('Invoice unavailable');
    // The engine must never refresh linked invoice amounts from this read.
    if(hasExternalReminderLedger(row.data)&&scope.invoice
      &&(String(row.data.automation_version)!==String(scope.invoice.automation_version)
        ||Number(row.data.amount_paid)!==Number(scope.invoice.amount_paid)
        ||Number(row.data.total_amount)!==Number(scope.invoice.total_amount)))throw Error('Invoice changed before payment verification');
    const result=await reminderPaymentRpc({supabase,name:'cetld_core_check_local_reminder_payment',invoice:row.data,ownerId,workspaceId,accounting,env,fetchImpl,args:{
      p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:scope.invoiceId,
    }});
    if(result.error||result.data?.ok!==true||!Number.isSafeInteger(Number(result.data.paidMinor)))throw Error('Local payment verification unavailable');
    return {paidMinor:Number(result.data.paidMinor)};
  };
}
