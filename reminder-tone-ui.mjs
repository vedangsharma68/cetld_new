import {REMINDER_TONES} from './automation/whatsapp/reminder-templates.mjs';

export function readDebtorReminderTone(value){
  if(value==='')return null;
  if(!REMINDER_TONES.includes(value))throw Error('Choose a valid reminder tone.');
  return value;
}

export function debtorReminderToneForm(customer,escape){
  const choices=[['','Use business tone'],['gentle','Gentle'],['relaxed','Relaxed'],['firm','Firm'],['professional','Professional']];
  return `<form id="debtor-reminder-tone-form"><div class="dialog-body"><p>${escape(customer.name||'Customer')}</p><label class="field">Reminder tone<select name="reminder_tone">${choices.map(([value,label])=>`<option value="${value}" ${value===(customer.reminder_tone??'')?'selected':''}>${label}</option>`).join('')}</select></label><p class="muted">Applies to this customer’s invoices. Gentle and relaxed use the same approved wording. Changing tone pauses approved reminders so you can review them again.</p><div class="error hidden" data-error role="alert"></div></div><div class="dialog-foot"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary">Save tone</button></div></form>`;
}
