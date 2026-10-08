export async function ownerPartialPaymentAvailable(supabase){
 try{const result=await supabase.rpc('whatsapp_owner_partial_payment_capability',{});return !result.error&&result.data?.ok===true&&result.data?.version===3;}catch{return false;}
}
// Receipt plus independent scoped invoice/payment reads are completion evidence.
export async function verifyOwnerPaymentReceipt({supabase,scope,messageId}){
 const receipt=await supabase.from('whatsapp_owner_action_receipts').select('result,action_id').eq('workspace_id',scope.workspaceId).eq('owner_id',scope.ownerId).eq('phone',scope.phone).eq('provider_message_id',messageId).maybeSingle();
 if(receipt.error||receipt.data?.result?.ok!==true)return null;
 const facts=receipt.data.result;
 if(!facts.paymentId||typeof facts.paymentAmount!=='number'||!Number.isFinite(facts.paymentAmount)||facts.paymentAmount<=0)return null;
 const [invoice,payment]=await Promise.all([
  supabase.from('invoices').select('id,workspace_id,invoice_number,customer_id,currency,total_amount,amount_paid,status,metadata,updated_at').eq('workspace_id',scope.workspaceId).eq('id',facts.invoiceId).maybeSingle(),
  supabase.from('payments').select('id,workspace_id,invoice_id,amount,idempotency_key,settle_remaining').eq('workspace_id',scope.workspaceId).eq('invoice_id',facts.invoiceId).eq('id',facts.paymentId).maybeSingle(),
 ]);
 const row=invoice.data,p=payment.data;
 if(invoice.error||payment.error||!row||!p||row.currency!==facts.currency||row.updated_at!==facts.updatedAt||Number(row.amount_paid)!==facts.amountPaid
   ||Math.round((Number(row.total_amount)-Number(row.amount_paid))*100)/100!==facts.outstandingAmount||Number(p.amount)!==facts.paymentAmount
   ||p.idempotency_key!=='wa_owner_payment_'+receipt.data.action_id||p.settle_remaining!==false||row.metadata?.followup_state!=='paused'||row.metadata?.next_follow_up_at!==null)return null;
 return {ok:true,completed:true,action:'invoice.payment_recorded',actionType:'owner_invoice_payment',invoiceNumber:row.invoice_number,
  paymentAmount:facts.paymentAmount,currency:row.currency,amountPaid:facts.amountPaid,outstandingAmount:facts.outstandingAmount,record:row,payment:p,remindersPaused:true};
}
