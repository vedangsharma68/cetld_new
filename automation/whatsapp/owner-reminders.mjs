import {PHONE_FORMAT_GUIDANCE} from './owner-phone.mjs';
import {ownerConsentFailure} from './owner-consent.mjs';
import {resolveWorkspaceRecord} from './workspace-records.mjs';
import {getSendEligibility} from './consent.mjs';
import {brandedReminder} from '../preferences.mjs';
import {selectInvoiceReminderTemplate,buildReminderTemplate} from './reminder-templates.mjs';
import {buildInvoiceReminderParameters} from './reminder-parameters.mjs';

const TYPE='owner_reminder_approval';
const MESSAGES={
  AMBIGUOUS:'More than one invoice matches. Which invoice number should I use?',
  NOT_FOUND:'I could not find that invoice in your business.',
  DENIED:'The verified owner binding is unavailable. Reconnect your owner WhatsApp number in Settings, then request a fresh preview. Nothing was approved or sent.',
  PENDING:'Another owner action is pending. Confirm or cancel it first.',
  STALE:'The invoice, customer or reminder preferences changed after the preview. Request a fresh preview.',
  EXPIRED:'The reminder preview expired. Request a fresh preview.',
  REPLAY_MISMATCH:'This reminder request changed after it was recorded. Request a fresh preview.',
  INVALID:'A later explicit confirmation or cancellation is required.',
  NO_PENDING_ACTION:'There is no matching reminder preview to confirm. Request a fresh preview.',
  missing_contact:"This customer's number isn't a usable WhatsApp number yet. "+PHONE_FORMAT_GUIDANCE,
  missing_consent:"This customer hasn't agreed to WhatsApp reminders. Get their OK, then tell me.",
  revoked:'This customer withdrew consent for invoice reminders. Get their renewed OK and record their consent before requesting another reminder.',
  missing_recipient_opt_in:"This customer hasn't agreed to WhatsApp reminders. Get their OK, then tell me.",
  category_not_consented:'This customer has not consented to invoice updates. Get their OK for invoice reminders, then record it.',
  unbound:'The current customer phone does not match the reminder consent. Verify the customer and record consent for their current number.',
  suppressed:'This customer has stopped WhatsApp reminders. Ask them to opt back in before requesting another reminder.',
  globally_suppressed:'This phone has stopped WhatsApp messages. Ask the recipient to opt back in before requesting another reminder.',
  ineligible_invoice:'Reminders require a sent, unpaid receivable invoice with a due date. Review the invoice status, balance and due date first.',
  unresolved_exception:'Resolve the invoice follow-up exception before approving a reminder.',
  business_name_required:"Save your business name first - tell me the name and I'll store it.",
  reminder_limit:'This invoice has reached the maximum number of reminders. Review the reminder limit in Settings before requesting another.',
  contact_hours:'The customer is outside your allowed contact hours. Request the reminder during the contact window.',
  delivery_in_progress:'A reminder delivery is already pending or uncertain. Review its delivery status before requesting another.',
  external_accounting_required:'This invoice requires external accounting verification before reminders can be queued.',
  payment_audit_mismatch:'The recorded payment audit is inconsistent. Review the payment history first.',
  payment_balance_mismatch:'The invoice balance does not match its recorded payments. Review the payment history first.',
  template_unavailable:'The approved reminder template is unavailable. Check the approved template in WhatsApp Settings, then request a fresh preview. Nothing was approved or queued.',
};
export const ownerReminderFailure=code=>({ok:false,completed:false,code:MESSAGES[code]?code:'UNAVAILABLE',
  message:MESSAGES[code]||'Reminder approval is temporarily unavailable. Nothing was approved or queued.'});
const unwrap=result=>{if(result?.error)throw result.error;return result?.data;};

export function prepareOwnerReminderContent({invoice,settings,customer}) {
  const entry=selectInvoiceReminderTemplate(settings.follow_up_preferences,customer.reminder_tone??null);
  const parameters=entry.parameterCount===3?[settings.business_name,invoice.invoice_number,customer.name]:buildInvoiceReminderParameters({invoice,settings,customer});
  const rendered=buildReminderTemplate(entry,parameters);
  return {invoiceId:invoice.id,preview:rendered.body,approvalText:brandedReminder(rendered.body,settings.business_name),
    template:{name:entry.name,language:entry.language,revision:entry.revision,parameters:rendered.template.components[0].parameters.map(p=>p.text)},
    snapshot:{invoiceVersion:String(invoice.automation_version),invoiceUpdatedAt:invoice.updated_at,settingsUpdatedAt:settings.updated_at,customer}};
}

// A bounded shortcut for common requests. Other phrasing uses the same model
// tool contract. Only prepares a preview; never interprets a request as a YES.
export function ownerReminderRequest(message){
  const text=String(message||'').trim().replace(/[.!?]+$/,'');
  const match=text.match(/^(?:(?:please|can you)\s+)?(send\s+(?:a\s+)?reminder|remind\s+the\s+customer|show\s+(?:me\s+)?(?:the\s+)?reminder\s+preview|approve\s+(?:the\s+)?reminder(?:\s+draft)?)\s+(?:(?:to|for|on)\s+)?(.+?)(?:\s+now)?$/i);
  if(!match||/[\n;]|\b(?:and|except|don't|do not|tomorrow|later)\b/i.test(match[2]))return null;
  const target=match[2].replace(/^(?:invoice|customer)\s+/i,'').trim();
  if(!target||target.length>100)return null;
  return {operation:/^(send|remind)/i.test(match[1])?'sendReminderNow':'previewReminder',table:'invoices',
    filters:[{column:/^(?:INV[-/]|[A-Z]+-\d)/i.test(target)?'invoice_number':'customer_name',operator:'eq',value:target}]};
}

export function createOwnerReminderRuntime({supabase,scope,message='',messageId,authorize}={}){
  let reply=null,confirmation=false,customerName=null,contactWindow=null;
  const check=async ctx=>{ctx?.assertLive?.();if(!await authorize(scope))throw Error('owner required');await ctx?.assertAuthorized?.();ctx?.assertLive?.();};
  const refuse=code=>{confirmation=false;const result=ownerReminderFailure(code);if(customerName)result.message=result.message.replace(/This customer(?:'s)?/g,m=>customerName+(m.endsWith("'s")?"'s":''));
    if(code==='contact_hours'&&contactWindow)result.message+=' Contact window: '+contactWindow+'.';
    reply=result.message;return result;};
  const resultReply=result=>{
    if(!result?.ok)return refuse(result?.code||result?.reason);
    confirmation=result.requiresConfirmation===true;
    if(confirmation){
      if(typeof result.preview!=='string'||!result.preview)return refuse('UNAVAILABLE');
      reply=`Reminder preview for ${result.invoiceNumber}:\nDelivery form: approved WhatsApp template.\n\n${result.preview}\n\n${result.sendNow?'Confirm to approve and queue this reminder for the next scheduler tick. Delivery still follows your WhatsApp settings.':'Confirm to approve this reminder draft. Delivery follows your WhatsApp settings.'} Reply yes to confirm, or cancel.`;
    }else if(result.completed){
      reply=result.action==='pending.cancelled'?'Canceled the reminder approval. Nothing was queued.':result.sendNow
        ?`Approved and queued the reminder for ${result.invoiceNumber}. The next scheduler tick will recheck all delivery requirements. It has not been sent yet.`
        :`Approved the reminder for ${result.invoiceNumber}. Delivery follows your WhatsApp settings. It has not been sent yet.`;
    }
    return result;
  };
  const rpc=async(args,ctx)=>{
    await check(ctx);
    const result=unwrap(await supabase.rpc('whatsapp_owner_reminder',{
      p_workspace_id:scope.workspaceId,p_owner_id:scope.ownerId,p_phone:scope.phone,
      p_message_id:messageId,p_user_message:String(message),...args,
    }));
    await check(ctx);return resultReply(result);
  };
  const decide=async({pending,decision,interactionId=null},ctx)=>{
    if(pending?.action?.type!==TYPE||!['confirm','cancel','pending'].includes(decision))return refuse('INVALID');
    customerName=pending?.action?.snapshot?.customer?.name?.trim()||null;
    try{
      await check(ctx);
      const settings=unwrap(await supabase.from('workspace_settings').select('default_timezone,follow_up_preferences').eq('workspace_id',scope.workspaceId).maybeSingle());
      const prefs=settings?.follow_up_preferences||{};
      contactWindow=`${prefs.contactStart||'09:00'}-${prefs.contactEnd||'18:00'} (${settings?.default_timezone||'Asia/Kolkata'}), weekdays ${(prefs.allowedWeekdays||[1,2,3,4,5]).map(day=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')}`;
    }catch{}
    try{const result=await rpc({p_action:decision,p_pending_id:pending.id,p_pending_version:pending.version,p_interaction_id:interactionId},ctx);if(!result.ok)reply=result.message;return result;}
    catch{const result=refuse('UNAVAILABLE');reply=result.message;return result;}
  };
  return {
    getReply:()=>reply,requiresConfirmation:()=>confirmation,decide,
    async lookupCompleted(){
      if(!scope?.interactionId&&!/^\s*(?:yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve|no|cancel|never mind|nevermind|discard)\s*[.!]?\s*$/i.test(message))return null;
      try{
        await check();
        const receipt=unwrap(await supabase.from('whatsapp_direct_write_receipts').select('result,request')
          .eq('workspace_id',scope.workspaceId).eq('owner_id',scope.ownerId).eq('phone',scope.phone).eq('provider_message_id',messageId).maybeSingle());
        await check();
        if(!['reminder.confirm','reminder.cancel'].includes(receipt?.request?.operation)||receipt?.result?.ok!==true||receipt.result.completed!==true)return null;
        return resultReply({...receipt.result,replayed:true});
      }catch{return null;}
    },
    async execute(params,ctx){
      reply=null;confirmation=false;
      if(['pending','confirm','cancel'].includes(params.operation)){
        const result=await decide({pending:params.pending,decision:params.operation},ctx);
        if(!result.ok)reply=result.message;return result;
      }
      try{
        await check(ctx);
        const found=await resolveWorkspaceRecord({supabase,scope,table:'invoices',filters:params.filters,operation:'update',select:'id,invoice_number,customer_id,due_date,currency,total_amount,amount_paid,status,metadata,automation_version,updated_at,deleted_at',
          assertAuthorized:()=>check(ctx),assertLive:()=>ctx?.assertLive?.()});
        if(!found.ok)return refuse(found.code);
        const invoice=found.row;
        const settings=unwrap(await supabase.from('workspace_settings').select('business_name,default_timezone,follow_up_preferences,updated_at').eq('workspace_id',scope.workspaceId).maybeSingle());
        const customer=unwrap(await supabase.from('customers').select('id,name,phone,reminder_tone').eq('workspace_id',scope.workspaceId).eq('id',invoice.customer_id).maybeSingle());
        customerName=customer?.name?.trim()||null;
        const prefs=settings?.follow_up_preferences||{};
        contactWindow=`${prefs.contactStart||'09:00'}-${prefs.contactEnd||'18:00'} (${settings?.default_timezone||'Asia/Kolkata'}), weekdays ${(prefs.allowedWeekdays||[1,2,3,4,5]).map(day=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')}`;
        await check(ctx);
        if(!customer||!/^\+[1-9]\d{7,14}$/.test(customer.phone||'')){
          if(customer)try{
            await check(ctx);
            await supabase.from('whatsapp_owner_contact_recovery').upsert({workspace_id:scope.workspaceId,owner_id:scope.ownerId,phone:scope.phone,
              invoice_id:invoice.id,customer_id:customer.id,request_message:String(message),send_now:params.operation==='sendReminderNow',
              reason:'missing_contact',expires_at:new Date(Date.now()+30*60_000).toISOString()},{onConflict:'workspace_id,owner_id,phone'});
            await check(ctx);
          }catch{/* The owner still receives the specific failure if context storage is unavailable. */}
          return refuse('missing_contact');
        }
        const eligibility=await getSendEligibility({supabase,workspaceId:scope.workspaceId,phone:customer.phone});
        await check(ctx);
        if(!eligibility.allowed)return refuse(eligibility.reason);
        if(eligibility.customer.id!==invoice.customer_id){
          const result=refuse('unbound');
          if(customer.phone===scope.phone){result.message=ownerConsentFailure('OWNER_PHONE').message;reply=result.message;}
          return result;
        }
        if(!settings?.business_name?.trim())return refuse('business_name_required');
        if(invoice.status!=='sent'||invoice.deleted_at||invoice.metadata?.invoice_direction!=='receivable'||!invoice.due_date||Number(invoice.total_amount)<=Number(invoice.amount_paid))return refuse('ineligible_invoice');
        let draft;
        try{
          draft=prepareOwnerReminderContent({invoice,settings,customer});
        }catch{return refuse('template_unavailable');}
        return await rpc({p_action:'prepare',p_invoice_id:invoice.id,p_send_now:params.operation==='sendReminderNow',
          p_preview:draft.preview,p_approval_text:draft.approvalText,p_template:draft.template,p_snapshot:draft.snapshot},ctx);
      }catch{return refuse('UNAVAILABLE');}
    },
  };
}
