import {createAccountingRuntime} from './runtime.mjs';

const text=value=>String(value??'').trim();
export const hasExternalReminderLedger=i=>[i.external_provider,i.external_invoice_id,i.metadata?.accounting_provider,i.metadata?.bookkeeping_record_id].some(value=>text(value));
const scale=currency=>['BHD','IQD','JOD','KWD','LYD','OMR','TND'].includes(currency)?1000:
  ['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(currency)?1:100;
const minor=(value,currency)=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')throw Error('Missing amount');
  const n=Number(value)*scale(currency),rounded=Math.round(n);
  if(!Number.isSafeInteger(rounded)||rounded<0||Math.abs(n-rounded)>0.000001)throw Error('Invalid amount');
  return rounded;
};

/** Evidence is private server input for one RPC, never part of an approval snapshot.
 * Timeout covers credentials, refresh and provider read. Late results are discarded.
 */
export async function externalReminderRead({invoice,ownerId,workspaceId,accounting,env=process.env,fetchImpl=fetch,timeoutMs=5000}={}){
  if(!hasExternalReminderLedger(invoice))return null;
  const provider=text(invoice.external_provider)||text(invoice.metadata?.accounting_provider);
  const invoiceId=text(invoice.external_invoice_id)||text(invoice.metadata?.bookkeeping_record_id);
  if(!['zoho_books','quickbooks'].includes(provider)||!invoiceId)throw Error('Authoritative provider unavailable');
  for(const marker of [invoice.external_provider,invoice.metadata?.accounting_provider])if(text(marker)&&text(marker)!==provider)throw Error('Provider linkage mismatch');
  for(const marker of [invoice.external_invoice_id,invoice.metadata?.bookkeeping_record_id])if(text(marker)&&text(marker)!==invoiceId)throw Error('Invoice linkage mismatch');
  const startedAt=new Date().toISOString(),controller=new AbortController();let timer;
  try{
    const connector=accounting||createAccountingRuntime({env,fetchImpl:(url,options={})=>fetchImpl(url,{...options,signal:controller.signal})});
    const remote=await Promise.race([
      connector.reminderInvoiceState({userId:ownerId,workspaceId,provider,invoiceId,signal:controller.signal}),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('External verification timed out'));},Math.min(5000,Math.max(1,timeoutMs)));}),
    ]);
    const currency=invoice.currency,total=minor(invoice.total_amount,currency),paid=minor(invoice.amount_paid,currency);
    // Compare the provider adapter's financial status; unknown states fail closed.
    if(remote?.externalId!==invoiceId||remote.currency!==currency||remote.status!==invoice.status||remote.status!=='sent'
      ||!Number.isSafeInteger(remote.totalMinor)||!Number.isSafeInteger(remote.balanceMinor)||!Number.isSafeInteger(remote.paidMinor)
      ||remote.totalMinor!==total||remote.paidMinor!==paid||remote.balanceMinor!==total-paid||remote.balanceMinor<=0)throw Error('External invoice diverged');
    return {ownerId,workspaceId,invoiceId:invoice.id,provider,externalId:invoiceId,startedAt,
      invoiceVersion:String(invoice.automation_version),invoiceUpdatedAt:invoice.updated_at,
      status:invoice.status,currency,total: String(invoice.total_amount),paid:String(invoice.amount_paid),
      linkage:[invoice.external_provider??null,invoice.external_invoice_id??null,invoice.metadata?.accounting_provider??null,invoice.metadata?.bookkeeping_record_id??null]};
  }finally{clearTimeout(timer);}
}

export async function reminderPaymentRpc({supabase,name,args,invoice,ownerId,workspaceId,beforeRpc,...options}){
  if(!hasExternalReminderLedger(invoice)){await beforeRpc?.();return supabase.rpc(name,args);}
  try{
    const evidence=await externalReminderRead({invoice,ownerId,workspaceId,...options});
    await beforeRpc?.();
    return await supabase.rpc(name+'_with_external_read',{...args,p_external_read:evidence});
  }catch{return {data:{ok:false,authorized:false,code:'external_accounting_required',reason:'external_accounting_required'},error:null};}
}
