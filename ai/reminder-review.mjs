import {assertTestReminderDelivery} from '../automation/whatsapp/test-reminder-policy.mjs';
import {randomUUID} from 'node:crypto';
import {APIError,object,uuid} from './http.mjs';
import {createAccountingActionToken,verifyAccountingActionToken} from './accounting-actions.mjs';
import {reminderFingerprint} from '../automation/whatsapp/reminder-fingerprint.mjs';
import {REMINDER_TONES,selectInvoiceReminderTemplate,buildReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
import {buildInvoiceReminderParameters} from '../automation/whatsapp/reminder-parameters.mjs';
import {reminderDeliveryForm} from '../automation/whatsapp/reminder-approval.mjs';
const secret=env=>env.AI_ACCOUNTING_CONFIRMATION_SECRET||env.ACCOUNTING_TOKEN_ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY;
const owner=store=>{if(store.role!=='owner'||!store.ownerConversation)throw new APIError(403,'OWNER_REQUIRED');};

async function checkApprovalSlot(store,clock,proposalId=null){
 const pending=await store.ownerConversation.pending();
 if(pending&&pending.id!==proposalId)throw new APIError(409,'PENDING');
 const turns=await store.ownerConversation.read();
 if(turns.some(t=>['create_invoice','update_invoice'].includes(t.pending_action?.type)&&(!t.pending_action.status||t.pending_action.status==='pending')&&Date.parse(t.pending_action.expiresAt)>clock().getTime()))throw new APIError(409,'PENDING');
}

export async function previewReminderReview({store,body,env,clock=()=>new Date()}) {
 owner(store);
 await checkApprovalSlot(store,clock);
 const invoiceId=uuid(body.invoiceId),{text,tone,sendNow,approveFallback=false}=body;
 if(typeof text!=='string'||!text.trim()||text.length>4000||!REMINDER_TONES.includes(tone)||typeof sendNow!=='boolean'||typeof approveFallback!=='boolean')throw new APIError(400,'INVALID_REMINDER_REVIEW');
 const invoice=(await store.query('invoices',{select:'*',filters:{id:`eq.${invoiceId}`},limit:1}))[0];
 if(!invoice||invoice.deleted_at)throw new APIError(404,'INVOICE_NOT_FOUND');
 const settings=await store.getOwnerAssistantSettings();
 const customer=(await store.query('customers',{select:'id,name,phone,reminder_tone',filters:{id:`eq.${invoice.customer_id}`},limit:1}))[0];
 if(!customer)throw new APIError(409,'missing_contact');
 const projection={id:customer.id,name:customer.name,phone:customer.phone,reminder_tone:customer.reminder_tone??null};
 let entry,parameters,rendered;
 try{entry=selectInvoiceReminderTemplate({},tone);parameters=buildInvoiceReminderParameters({invoice,settings,customer});rendered=buildReminderTemplate(entry,parameters);}catch{throw new APIError(409,'template_unavailable');}
 const template=reminderDeliveryForm({entry,parameters,body:rendered.body});
 const window=await store.ownerAssistantRPC('owner_assistant_reminder_window',{p_invoice_id:invoiceId});
 const deadline=Date.parse(window?.windowExpiresAt),open=Number.isFinite(deadline)&&deadline>clock().getTime();
 // Cetld product policy is stricter than WhatsApp's service-window capability.
 const service=sendNow&&open;
 const delivery={...(service?{type:'freeform',body:text}:{...template}),version:2,artifactVersion:1,tone,mode:sendNow?'immediate':'scheduled',
   windowExpiresAt:window?.windowExpiresAt??null,fallback:service&&approveFallback?template:null};
 try{assertTestReminderDelivery(invoice,delivery);}catch(error){throw new APIError(409,error.code);}
 const payload={invoiceId,preview:delivery.body,approvalText:delivery.body,sendNow,
   template:{name:entry.name,language:entry.language,revision:entry.revision,parameters,templatePreview:rendered.body,dashboardDraft:text,reviewedDelivery:delivery},
   snapshot:{invoiceVersion:String(invoice.automation_version),invoiceUpdatedAt:invoice.updated_at,settingsUpdatedAt:settings.updated_at,customer:projection}};
 const checked=await store.ownerAssistantRPC('owner_assistant_preview_reminder',{p_payload:payload});
 if(checked?.ok!==true)throw new APIError(409,checked?.code||'REMINDER_PREVIEW_UNAVAILABLE');
 if(!checked.delivery||reminderFingerprint(checked.delivery)!==reminderFingerprint(delivery))throw new APIError(503,'REMINDER_REVIEW_MIGRATION_REQUIRED');
 const summary=`Reminder delivery for ${invoice.invoice_number}:\n${service?'Your exact message (service message)':`Approved template: ${entry.name}`}\n\n${delivery.body}${delivery.fallback?`\n\nIf the service window closes, approved fallback: ${entry.name}\n${delivery.fallback.body}`:service?'\n\nIf the service window closes: hold for re-review. No template substitution.':''}`;
 const reviewPayload={payload,summary};
 const tokenNow=clock().getTime();
 const approvalToken=createAccountingActionToken({action:'owner_reminder',payload:{proposalId:randomUUID(),reviewHash:reminderFingerprint(reviewPayload)},
   workspaceId:store.workspaceId,userId:store.userId,secret:secret(env),now:tokenNow});
 return {eligible:true,approvalToken,expiresAt:new Date(Math.floor(tokenNow/1000)*1000+600000).toISOString(),reviewPayload,sendNow,
   deliveryReason:!sendNow?'scheduled_template_only':!open?'window_closed':null,
   delivery:{form:service?'service':'template',text:delivery.body,templateName:service?undefined:entry.name,
    windowExpiresAt:window?.windowExpiresAt??null,windowClosedPolicy:delivery.fallback?'template_fallback':'hold',
    fallback:delivery.fallback?{form:'template',templateName:entry.name,text:delivery.fallback.body}:null}};
}

export async function approveReminderReview({store,body,env,clock=()=>new Date()}) {
 owner(store);
 if(body.confirmed!==true)throw new APIError(409,'CONFIRMATION_REQUIRED');
 const token=verifyAccountingActionToken(body.approvalToken,{workspaceId:store.workspaceId,userId:store.userId,secret:secret(env),now:clock().getTime()});
 if(token.action!=='owner_reminder'||typeof token.payload.reviewHash!=='string'||!body.reviewPayload||reminderFingerprint(body.reviewPayload)!==token.payload.reviewHash)throw new APIError(409,'REMINDER_REVIEW_CHANGED');
 const {payload,summary}=body.reviewPayload;
 object(body.reviewPayload,['payload','summary']);
 const invoice=(await store.query('invoices',{select:'*',filters:{id:`eq.${uuid(payload.invoiceId)}`},limit:1}))[0];
 if(!invoice||invoice.deleted_at)throw new APIError(404,'INVOICE_NOT_FOUND');
 try{assertTestReminderDelivery(invoice,payload.template?.reviewedDelivery);}catch(error){throw new APIError(409,error.code);}
 const id=uuid(token.payload.proposalId);
 await checkApprovalSlot(store,clock,id);
 const proposal=await store.ownerConversation.propose({id,type:'owner_reminder',payload,summary});
 if(proposal?.id!==id)throw new APIError(409,proposal?.code||'PENDING');
 const result=await store.ownerConversation.decide(id,true);
 if(result?.ok!==true)throw new APIError(409,result?.code||'REMINDER_APPROVAL_UNAVAILABLE');
 await store.ownerConversation.append({key:`decision:${id}:true`,role:'assistant',content:result.answer||'Approved the exact reviewed reminder delivery. It has not been sent yet.'});
 return {...result,approved:true};
}
