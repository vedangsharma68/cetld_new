// This reference is emitted by the verified phone-save RPC, never a planner.
// SQL rechecks its source, scope, age and current customer/invoice versions.
export function normalizeOwnerReceiptRef(value){
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const keys=['kind','ownerId','customerId','customerUpdatedAt','phone','invoiceId','invoiceUpdatedAt','sourceMessageId'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))
    ||value.kind!=='customer_phone_saved'||!uuid.test(value.ownerId||'')||!uuid.test(value.customerId||'')
    ||!/^\+[1-9]\d{7,14}$/.test(value.phone||'')||!Number.isFinite(Date.parse(value.customerUpdatedAt))
    ||typeof value.sourceMessageId!=='string'||!value.sourceMessageId.trim()||Buffer.byteLength(value.sourceMessageId)>256
    ||(value.invoiceId!=null? !uuid.test(value.invoiceId)||!Number.isFinite(Date.parse(value.invoiceUpdatedAt)):value.invoiceUpdatedAt!=null))return null;
  return Object.fromEntries(keys.map(k=>[k,value[k]??null]));
}
