import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as followups from '../automation/preferences.mjs';
import * as ui from '../followup-preferences-ui.mjs';

const placeholders = '{{business_name}} · {{customer_name}} · {{invoice_number}} · {{balance}} · {{due_date}}';

test('reminder template sanitizer accepts only bounded safe placeholders',()=>{
  assert.equal(typeof followups.sanitizeReminderTemplate,'function');
  if(typeof followups.sanitizeReminderTemplate!=='function')return;
  assert.equal(followups.sanitizeReminderTemplate('  Hello {{customer_name}}\r\nInvoice {{invoice_number}}  '),
    'Hello {{customer_name}}\nInvoice {{invoice_number}}');
  assert.equal(followups.sanitizeReminderTemplate('Hello — {{customer_name}} —'),
    'Hello, {{customer_name}}');
  assert.equal(followups.sanitizeReminderTemplate('A — B'), 'A, B');
  for(const invalid of [
    '{{account_number}}',
    '{{ business_name }}',
    'unclosed {{customer_name',
    'x'.repeat(1001),
    'bad\u0001text',
  ])assert.throws(()=>followups.sanitizeReminderTemplate(invalid));
});

test('rendering fills the allowlisted values and branded reminder body',()=>{
  assert.equal(typeof followups.renderReminderTemplate,'function');
  if(typeof followups.renderReminderTemplate!=='function')return;
  assert.equal(followups.renderReminderTemplate(placeholders,{
    business_name:'CETLD',customer_name:'Ada',invoice_number:'INV-17',balance:'₹1,250.00',due_date:'12 Oct 2026',
  }),'CETLD · Ada · INV-17 · ₹1,250.00 · 12 Oct 2026');
  const settings=followups.normalizeFollowUpPreferences({
    tone:'professional',businessName:'CETLD',reminderTemplate:'Hi {{customer_name}}, {{invoice_number}} has {{balance}} due on {{due_date}}.',
  },'UTC');
  assert.match(followups.reminderBody({
    invoice_number:'INV-17',client:'Ada',due_date:'12 Oct 2026',balance:'₹1,250.00',
  },settings),/Hi Ada, INV-17 has ₹1,250\.00 due on 12 Oct 2026\.\n\nCETLD$/);
  const signed = followups.normalizeFollowUpPreferences({businessName:'CETLD',reminderTemplate:'Hi {{customer_name}} — {{business_name}}'},'UTC');
  assert.equal(followups.reminderBody({client:'Ada'},signed),'Hi Ada,\n\nCETLD');
});

test('follow-up form exposes the saved template and supported token help',()=>{
  const html=ui.followUpPreferencesForm({reminderTemplate:'Hello {{customer_name}}'});
  assert.match(html,/name="reminderTemplate"/);
  assert.ok(html.includes('Hello {{customer_name}}'));
  assert.ok(html.includes('{{business_name}}'));
  assert.match(html,/Meta-approved template/);
  const unsafe=ui.followUpPreferencesForm({reminderTemplate:'<img src=x onerror=alert(1)>'});
  assert.ok(unsafe.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!unsafe.includes('<img src=x'));
});

test('follow-up form reads a validated template for the save payload',()=>{
  const original=globalThis.FormData;
  globalThis.FormData=class {
    constructor(){this.values={tone:'professional',firstReminderDays:'3',cadenceDays:'3',maxReminders:'3',contactStart:'09:00',contactEnd:'18:00',escalation:'manual_review',reminderTemplate:'Hi {{customer_name}}'};}
    get(key){return this.values[key]??null;}
    getAll(key){return key==='weekday'?[1,2,3,4,5]:[];}
    has(key){return key==='pauseOnReply';}
  };
  try{assert.equal(ui.readFollowUpPreferences({}).reminderTemplate,'Hi {{customer_name}}');}
  finally{globalThis.FormData=original;}
});

test('preference merge keeps unknown settings and app uses it before saving',async()=>{
  assert.equal(typeof ui.mergeFollowUpPreferences,'function');
  if(typeof ui.mergeFollowUpPreferences==='function'){
    assert.deepEqual(ui.mergeFollowUpPreferences({dailyReport:'keep',maxReminders:5},{tone:'firm',reminderTemplate:'Hello.'}),{
      dailyReport:'keep',maxReminders:5,tone:'firm',reminderTemplate:'Hello.',
    });
  }
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  assert.ok(source.includes('mergeFollowUpPreferences(state.settings?.follow_up_preferences,readFollowUpPreferences(form))'));
  assert.ok(source.includes('reminderTemplate'));
  assert.ok(source.includes('const reminderFactsChanged=!!x&&'));
  assert.ok(source.includes("reminder_text:reminderFactsChanged?'':x?.reminder_text||''"));
  assert.ok(source.includes('delete metadata.approved_reminder_text;delete metadata.approved_preferences_updated_at;'));
});
