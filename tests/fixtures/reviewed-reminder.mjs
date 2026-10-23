import {randomUUID} from 'node:crypto';
import {selectInvoiceReminderTemplate,buildReminderTemplate} from '../../automation/whatsapp/reminder-templates.mjs';
import {buildInvoiceReminderParameters} from '../../automation/whatsapp/reminder-parameters.mjs';
import {reminderDeliveryForm} from '../../automation/whatsapp/reminder-approval.mjs';
import {brandedReminder} from '../../automation/preferences.mjs';

// Simulates an explicit review of these exact outgoing words and template form.
// Tests of legacy/free-form approval intentionally do not call this helper.
export async function approveReviewedReminder(db,{workspaceId,invoiceId,entry}) {
 const invoice=(await db.query('select * from invoices where workspace_id=$1 and id=$2',[workspaceId,invoiceId])).rows[0];
 const customer=(await db.query('select * from customers where workspace_id=$1 and id=$2',[workspaceId,invoice.customer_id])).rows[0];
 const settings=(await db.query('select * from workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
 entry ||= selectInvoiceReminderTemplate(settings.follow_up_preferences,customer.reminder_tone??null);
 invoice.due_date=new Date(invoice.due_date).toISOString().slice(0,10);
 const parameters=entry.parameterCount===3?[settings.business_name,invoice.invoice_number,customer.name]:buildInvoiceReminderParameters({invoice,settings,customer});
 const {body}=buildReminderTemplate(entry,parameters),delivery=reminderDeliveryForm({entry,parameters,body});
 await db.query("update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_delivery',$2::jsonb,'approved_reminder_text',$3::text,'approved_preferences_updated_at',$4::text),next_follow_up_at=now()-interval '1 minute' where id=$1",[invoiceId,delivery,brandedReminder(body,settings.business_name),new Date(settings.updated_at).toISOString()]);
 // Seed the protected #173 confirmation record as well as its metadata mirror.
 if((await db.query("select to_regclass('public.owner_assistant_proposals') present")).rows[0].present){
  const ownerId=(await db.query('select owner_id from workspaces where id=$1',[workspaceId])).rows[0].owner_id;
  const id=randomUUID(),payload={invoiceId,preview:body,approvalText:brandedReminder(body,settings.business_name),
   template:{name:entry.name,language:entry.language,revision:entry.revision,parameters}};
  await db.query("insert into owner_assistant_proposals(id,workspace_id,owner_id,action,state,result) values($1,$2,$3,$4,'confirmed',$5)",
   [id,workspaceId,ownerId,{id,type:'owner_reminder',payload},{ok:true,completed:true,action:'reminder.approved'}]);
 }
 return delivery;
}
