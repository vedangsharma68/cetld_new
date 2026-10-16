import {createHash} from 'node:crypto';
import {APIError} from '../../ai/http.mjs';
import {resolveOwnerBinding} from './owner-binding.mjs';
import {getSendEligibility} from './consent.mjs';
import {readApprovedReminderTemplates} from './template-diagnostic.mjs';
import {APPROVED_REMINDER_WABA,selectReminderTemplate,buildReminderTemplate,matchesApprovedReminderTemplate} from './reminder-templates.mjs';

// One explicitly authorized fixture, never an arbitrary customer/recipient send.
export const OWNER_TEST_SCOPE=Object.freeze({workspaceId:'9a83b58d-6b02-4b17-8de5-c67136f26434',
  ownerId:'40ff343c-4334-4aec-b49a-ca772f0cf8ad',invoiceId:'f86e28bd-16a8-4c83-a03d-05302f7f3ff6',
  invoiceNumber:'INV-2026-6771',phone:'+919871367051'});
export const ownerTestKey='owner-template-test:v1:'+createHash('sha256')
  .update(JSON.stringify(OWNER_TEST_SCOPE)).digest('hex');
const unwrap=result=>{if(result?.error)throw result.error;return result?.data;};

// A consumed dispatch is a receipt, never another opportunity to send. Project
// only its status, scoped independently of caller-supplied review/token values.
export async function readOwnerTestReceipt({supabase,workspaceId,ownerId,invoiceId}){
  if(workspaceId!==OWNER_TEST_SCOPE.workspaceId||ownerId!==OWNER_TEST_SCOPE.ownerId||invoiceId!==OWNER_TEST_SCOPE.invoiceId)
    throw new APIError(403,'OWNER_TEST_SCOPE_REQUIRED');
  const row=unwrap(await supabase.from('whatsapp_messages').select('status')
    .eq('workspace_id',workspaceId).eq('idempotency_key',ownerTestKey)
    .eq('invoice_id',invoiceId).eq('phone',OWNER_TEST_SCOPE.phone)
    .eq('audience','owner').eq('direction','outbound').eq('kind','invoice_update').maybeSingle());
  if(!row)return null;
  return {test:true,audience:'owner',workspaceId,ownerId,invoiceId,recipient:OWNER_TEST_SCOPE.phone,
    status:'existing',deliveryStatus:['pending','unknown','accepted','sent','delivered','read','failed','blocked'].includes(row.status)?row.status:'unknown'};
}

export async function readOwnerTestReview({supabase,env,workspaceId,ownerId,invoiceId,fetchImpl}){
  const scope=OWNER_TEST_SCOPE;
  if(workspaceId!==scope.workspaceId||ownerId!==scope.ownerId||invoiceId!==scope.invoiceId)
    throw new APIError(403,'OWNER_TEST_SCOPE_REQUIRED');
  if(env.WHATSAPP_OUTBOUND_ENABLED!=='true'||env.WHATSAPP_TEST_OPERATOR_USER_ID!==ownerId
    ||env.WHATSAPP_WABA_ID!==APPROVED_REMINDER_WABA
    ||!String(env.WHATSAPP_TEST_ALLOWLIST||'').split(',').map(v=>v.trim()).includes(scope.phone))
    throw new APIError(409,'OWNER_TEST_DISABLED');
  const settings=unwrap(await supabase.from('workspace_settings').select('workspace_id,business_name,whatsapp_owner_phone')
    .eq('workspace_id',workspaceId).maybeSingle());
  if(settings?.workspace_id!==workspaceId||settings.whatsapp_owner_phone!==scope.phone||!settings.business_name?.trim())
    throw new APIError(409,'VERIFIED_OWNER_REQUIRED');
  const binding=await resolveOwnerBinding({supabase,phone:settings.whatsapp_owner_phone});
  if(binding?.workspaceId!==workspaceId||binding.ownerId!==ownerId||binding.businessName!==settings.business_name.trim())
    throw new APIError(409,'VERIFIED_OWNER_REQUIRED');
  const eligibility=await getSendEligibility({supabase,workspaceId,phone:scope.phone});
  if(!eligibility.allowed||eligibility.customer?.id!==binding.customerId)
    throw new APIError(409,'OWNER_TEST_RECIPIENT_INELIGIBLE');
  const invoice=unwrap(await supabase.from('invoices').select('id,workspace_id,invoice_number,status,updated_at,deleted_at')
    .eq('workspace_id',workspaceId).eq('id',invoiceId).is('deleted_at',null).maybeSingle());
  if(invoice?.id!==invoiceId||invoice.workspace_id!==workspaceId||invoice.deleted_at
    ||invoice.invoice_number!==scope.invoiceNumber||!['sent','paid'].includes(invoice.status))
    throw new APIError(409,'OWNER_TEST_INVOICE_REQUIRED');
  const entry=selectReminderTemplate({tone:'professional'});
  const rendered=buildReminderTemplate(entry,[binding.businessName,`TEST ONLY - ${invoice.invoice_number}`,'owner test only']);
  const metadata=await readApprovedReminderTemplates({env,fetchImpl});
  const actual=metadata.templates.find(t=>t.name===entry.name&&t.language==='en');
  if(!matchesApprovedReminderTemplate(actual,entry))
    throw new APIError(409,'APPROVED_TEST_TEMPLATE_MISMATCH');
  // Metadata reads can take time. Recheck consent/suppression and the verified
  // owner after them, including on the final check immediately before POST.
  const finalEligibility=await getSendEligibility({supabase,workspaceId,phone:scope.phone});
  const finalBinding=await resolveOwnerBinding({supabase,phone:scope.phone});
  if(!finalEligibility.allowed||finalEligibility.customer?.id!==binding.customerId
    ||finalBinding?.workspaceId!==workspaceId||finalBinding.ownerId!==ownerId
    ||finalBinding.customerId!==binding.customerId||finalBinding.businessName!==binding.businessName)
    throw new APIError(409,'OWNER_TEST_RECIPIENT_INELIGIBLE');
  const finalInvoice=unwrap(await supabase.from('invoices').select('id,workspace_id,invoice_number,status,updated_at,deleted_at')
    .eq('workspace_id',workspaceId).eq('id',invoiceId).is('deleted_at',null).maybeSingle());
  if(!finalInvoice||finalInvoice.updated_at!==invoice.updated_at||finalInvoice.invoice_number!==scope.invoiceNumber
    ||finalInvoice.workspace_id!==workspaceId||finalInvoice.deleted_at||!['sent','paid'].includes(finalInvoice.status))
    throw new APIError(409,'OWNER_TEST_INVOICE_REQUIRED');
  return {workspaceId,ownerId,invoiceId,recipient:scope.phone,businessName:binding.businessName,
    customerId:binding.customerId,invoiceUpdatedAt:invoice.updated_at,providerTemplateId:actual.id,
    idempotencyKey:ownerTestKey,text:rendered.body,template:rendered.template,
    footer:actual.components.find(c=>c.type==='FOOTER')?.text||null};
}

// Conditional UPDATE is an atomic claim on the existing uniquely keyed message.
// unknown is deliberately terminal for dispatch, including a crash before POST.
export async function claimOwnerTest({supabase,workspaceId,key}){
  if(workspaceId!==OWNER_TEST_SCOPE.workspaceId||key!==ownerTestKey)return false;
  const rows=unwrap(await supabase.from('whatsapp_messages').update({status:'unknown',updated_at:new Date().toISOString()})
    .eq('workspace_id',workspaceId).eq('idempotency_key',key).eq('status','pending')
    .eq('audience','owner').eq('direction','outbound').eq('phone',OWNER_TEST_SCOPE.phone)
    .eq('invoice_id',OWNER_TEST_SCOPE.invoiceId).select('id'));
  return Array.isArray(rows)&&rows.length===1;
}
