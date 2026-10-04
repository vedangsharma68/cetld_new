// Original receipts remain visible; collection totals use their net allocation.
export function applyPaymentReversals(payments,reversals,workspaceId){
  const byPayment=new Map();
  for(const r of reversals||[]){
    if(r.workspace_id!==workspaceId)throw Error('Payment audit scope mismatch.');
    if(byPayment.has(r.payment_id))throw Error('Duplicate payment reversal.');
    byPayment.set(r.payment_id,r);
  }
  return payments.map(p=>{
    if(p.workspace_id!==workspaceId)throw Error('Payment scope mismatch.');
    const reversal=byPayment.get(p.id),amount=Number(p.amount);
    if(reversal&&(reversal.invoice_id!==p.invoice_id||Number(reversal.amount)!==amount))throw Error('Payment audit does not match the original receipt.');
    return {...p,reversed_amount:reversal?amount:0,net_amount:reversal?0:amount,reversed_at:reversal?.recorded_at||null};
  });
}
export function isMissingReversalStorage(error){return ['42P01','PGRST205'].includes(error?.code);}
