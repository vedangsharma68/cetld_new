import {sanitizeReminderTemplate} from './automation/preferences.mjs';

const DEFAULTS = Object.freeze({
  tone: 'professional', firstReminderDays: 3, cadenceDays: 3, maxReminders: 3,
  allowedWeekdays: [1, 2, 3, 4, 5], contactStart: '09:00', contactEnd: '18:00',
  escalation: 'manual_review', pauseOnReply: true, stopOnPayment: true, dailySummary: false, reminderTemplate: '',
});

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const weekdayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export function normalizedFollowUpPreferences(value = {}) {
  const p = {...DEFAULTS, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {})};
  p.allowedWeekdays = Array.isArray(p.allowedWeekdays) ? p.allowedWeekdays : DEFAULTS.allowedWeekdays;
  p.reminderTemplate = sanitizeReminderTemplate(p.reminderTemplate);
  return p;
}

export function mergeFollowUpPreferences(current = {}, patch = {}) {
  const previous = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const changes = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = {...previous, ...changes};
  merged.reminderTemplate = sanitizeReminderTemplate(merged.reminderTemplate ?? '');
  return merged;
}

export function followUpPreferencesForm(value = {}) {
  const p = normalizedFollowUpPreferences(value);
  const option = (name, label) => `<option value="${name}" ${p.tone === name ? 'selected' : ''}>${label}</option>`;
  return `<section class="panel" id="follow-up-preferences"><div class="panel-head"><div><h2>Follow-up preferences</h2><p>Saved for this business. These settings control reminder drafts and scheduling. Customer delivery must also be enabled separately.</p></div></div>
    <form class="panel-body settings-fields" id="follow-up-preferences-form">
      <label class="field">Tone<select name="tone">${option('professional','Professional')}${option('gentle','Gentle')}${option('firm','Firm')}</select></label>
      <label class="field follow-up-template-field">Customer reminder template<textarea name="reminderTemplate" maxlength="1000" rows="5" aria-describedby="reminder-template-help">${escapeHtml(p.reminderTemplate)}</textarea><small id="reminder-template-help">Supported tokens: <code>{{business_name}}</code>, <code>{{customer_name}}</code>, <code>{{invoice_number}}</code>, <code>{{balance}}</code>, and <code>{{due_date}}</code>.</small><small class="settings-hint">Edits pause existing reminder approvals. Customer delivery still follows Meta-approved template rules and your existing delivery settings; saving only updates the draft.</small></label>
      <div class="two-cols"><label class="field">First reminder, days after due<input type="number" name="firstReminderDays" min="0" max="90" step="1" value="${escapeHtml(p.firstReminderDays)}" required></label><label class="field">Cadence, days between reminders<input type="number" name="cadenceDays" min="1" max="90" step="1" value="${escapeHtml(p.cadenceDays)}" required></label></div>
      <label class="field">Maximum reminders<input type="number" name="maxReminders" min="1" max="20" step="1" value="${escapeHtml(p.maxReminders)}" required></label>
      <fieldset class="field"><legend>Allowed weekdays</legend><div class="row">${weekdayNames.map((day, index) => `<label><input type="checkbox" name="weekday" value="${index}" ${p.allowedWeekdays.includes(index) ? 'checked' : ''}> ${day}</label>`).join('')}</div></fieldset>
      <div class="two-cols"><label class="field">Contact start<input type="time" name="contactStart" value="${escapeHtml(p.contactStart)}" required></label><label class="field">Contact end<input type="time" name="contactEnd" value="${escapeHtml(p.contactEnd)}" required></label></div>
      <label class="field">After maximum reminders<select name="escalation"><option value="manual_review" ${p.escalation === 'manual_review' ? 'selected' : ''}>Pause and request manual review</option><option value="pause" ${p.escalation === 'pause' ? 'selected' : ''}>Pause</option></select></label>
      <label class="setting-row"><span>Pause when the customer replies</span><input type="checkbox" name="pauseOnReply" ${p.pauseOnReply ? 'checked' : ''}></label>
      <label class="setting-row"><span>Always stop when the invoice is paid</span><input type="checkbox" name="stopOnPayment" checked disabled aria-label="Paid invoices always stop reminders"></label>
      <label class="setting-row"><span>Daily summary in dashboard</span><input type="checkbox" name="dailySummary" ${p.dailySummary ? 'checked' : ''}></label>
      <div class="error hidden" data-error role="alert"></div><button class="btn primary" type="submit">Save follow-up preferences</button>
    </form></section>`;
}

export function readFollowUpPreferences(form) {
  const data = new FormData(form);
  const number = (key, min, max) => {
    const raw = String(data.get(key) ?? '');
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) throw new Error(`Enter a valid ${key}.`);
    return value;
  };
  const allowedWeekdays = data.getAll('weekday').map(Number).sort((a,b) => a-b);
  const contactStart = String(data.get('contactStart') || '');
  const contactEnd = String(data.get('contactEnd') || '');
  const tone = String(data.get('tone') || '');
  const escalation = String(data.get('escalation') || '');
  const reminderTemplate = sanitizeReminderTemplate(String(data.get('reminderTemplate') ?? ''));
  if (!['professional','gentle','firm'].includes(tone)) throw new Error('Choose a valid tone.');
  if (!['manual_review','pause'].includes(escalation)) throw new Error('Choose a valid escalation action.');
  if (!allowedWeekdays.length || allowedWeekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Choose at least one weekday.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(contactStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(contactEnd) || contactStart >= contactEnd) throw new Error('Contact end must be after contact start.');
  return {tone, firstReminderDays:number('firstReminderDays',0,90), cadenceDays:number('cadenceDays',1,90), maxReminders:number('maxReminders',1,20), allowedWeekdays, contactStart, contactEnd, escalation, pauseOnReply:data.has('pauseOnReply'), stopOnPayment:true, dailySummary:data.has('dailySummary'), reminderTemplate};
}
