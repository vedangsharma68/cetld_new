import {AccountingError} from './errors.mjs';

const changed=()=>new AccountingError('ACCOUNTING_EXPORT_OPERATION_CHANGED','Export completion protocol changed');
const isState=(value,state)=>value?.state===state&&value.originCaptured===false;

// Disabled origin capture. This owns one unverified operation from reservation
// through atomic linkage/result completion; no caller JSON is a receipt/grant.
export async function runCaptureCompletion({store,accessToken,adapter,userId,workspaceId,row,invoice}){
 if(!store.captureCompletionProtocol)return null;
 const probe=await store.probeCaptureCompletion(workspaceId,row.id);
 if(probe===null)return null;
 if(probe?.eligible!==true||probe.originCaptured!==false||!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(probe.ownerId||''))throw changed();
 const identity={userId:probe.ownerId,workspaceId,provider:'zoho_books'};
 const context=await store.zohoOperationContext(identity);
 const saved=await store.getInvoiceExportState(workspaceId,row.id);
 const reserved=await store.captureCompletionProtocol(identity,row.id,'reserve',{
  // Caller stores do not all project automation_version. Load that version on
  // the server, while still comparing the caller-observed exact updated_at.
  p_expected_updated_at:row.updated_at,p_expected_version:row.automation_version??saved?.automation_version,p_expected_epoch:context?.epochId||null});
 if(reserved?.originCaptured!==false)throw changed();
 if(['not_admitted','unavailable'].includes(reserved.state)){
  if(!context)return null; // missing epoch retains explicitly unverified legacy behavior
  return {row:reserved.invoice||row,sync:{status:'failed',provider:'zoho_books',retryable:true}};
 }
 if(!isState(reserved,'reserved')||!reserved.invoice||!reserved.customer
  ||!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(reserved.operationId||''))throw changed();
 const call=(action,extra={})=>store.captureCompletionProtocol(identity,row.id,action,{p_operation_id:reserved.operationId,...extra});
 const fail=async()=>{
  let value;try{value=await call('abort');}catch{}
  return {row:value?.invoice||reserved.invoice,sync:{status:'failed',provider:'zoho_books',retryable:true}};
 };
 let result;
 try{
  const saved=reserved.invoice,customer=reserved.customer;
  if(invoice.direction!=='receivable'||invoice.invoiceNumber!==saved.invoice_number||invoice.currency!==saved.currency
   ||Number(invoice.total)!==Number(saved.total_amount)||invoice.invoiceDate!==saved.issue_date||(invoice.dueDate||null)!==(saved.due_date||null)
   ||String(invoice.clientName||'').trim().toLowerCase()!==String(customer.name||'').trim().toLowerCase()
   ||(invoice.clientEmail&&invoice.clientEmail!==customer.email)||(invoice.clientPhone&&invoice.clientPhone!==customer.phone))throw changed();
  const authorization=await accessToken(identity),current=await store.zohoOperationContext(identity);
  if(!context||current?.epochId!==context.epochId||authorization.connection.providerAccountId!==context.accountId
   ||['region','apiDomain','accountsDomain'].some(key=>authorization.connection[key]!==context[key]))throw changed();
  if(!isState(await call('start'),'started'))throw changed();
  // All searches/contact writes/invoice writes belong to this already-started
  // operation. No integration-level retry or current-account reselection.
  result=await adapter.createInvoice({token:authorization.token,accountId:context.accountId,invoice:{...invoice,localInvoiceId:row.id}});
  if(!result||typeof result.externalId!=='string'||!result.externalId||result.externalId.length>100)throw changed();
 }catch{return fail();}
 let completed;
 try{
  completed=await call('complete',{p_external_id:result.externalId,p_outcome:result.duplicate?'duplicate_unverified':'created_unverified'});
 }catch{
  // A lost acknowledgement is not permission to redispatch. Recover only an
  // unchanged, durable completed result through a SELECT-only server RPC.
  try{completed=await store.recoverCaptureCompletion(identity,row.id,reserved.operationId);}catch{}
  if(!isState(completed,'completed_unverified')){
   await fail();throw new AccountingError('ACCOUNTING_EXPORT_COMPLETION_UNKNOWN','Export completion is unknown');
  }
 }
 if(!isState(completed,'completed_unverified')||completed.invoice?.id!==row.id||completed.invoice.workspace_id!==workspaceId
  ||completed.invoice.external_provider!=='zoho_books'||completed.invoice.external_invoice_id!==result.externalId)return fail();
 return {row:completed.invoice,sync:{status:'synced',provider:'zoho_books',externalId:result.externalId,retryable:false}};
}
