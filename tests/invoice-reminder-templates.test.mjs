import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {REMINDER_TEMPLATES,selectReminderTemplate,selectInvoiceReminderTemplate,matchesApprovedReminderTemplate,buildReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
import {buildInvoiceReminderParameters,formatReminderAmount,formatReminderDueDate} from '../automation/whatsapp/reminder-parameters.mjs';
import {debtorReminderToneForm,readDebtorReminderTone} from '../reminder-tone-ui.mjs';

const invoice={invoice_number:'INV-001',total_amount:'13000.50',amount_paid:'500.50',due_date:'2026-10-18'};
const settings={business_name:'Fixture studio',default_timezone:'Asia/Kolkata'};
const customer={name:'  Priya   Sharma  '};
const facts=['Priya','Fixture studio','INV-001','₹12,500','18 Oct 2026'];
const name=tone=>`cetld_invoice_details_${tone}_v1`;
const approvedDetails={
  relaxed:"Hi {{1}} 👋 I'm Cetld, {{2}}'s assistant. A quick heads-up: invoice {{3}} has {{4}} outstanding, due on {{5}}. Questions? Just reply here 😊",
  firm:"Hi {{1}}, I'm Cetld, {{2}}'s assistant. 📌 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please confirm your expected payment date, or let us know if there is an issue.",
  professional:"Hi {{1}}, I'm Cetld, {{2}}'s assistant. 🧾 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please reply if you have any questions.",
};

for(const entry of REMINDER_TEMPLATES)test(`exact catalog contract: ${entry.name}`,()=>{
  if(entry.parameterCount===5)assert.equal(entry.body,approvedDetails[entry.tone]);
  const actual={found:true,name:entry.name,language:'en',status:'APPROVED',category:'UTILITY',parameter_format:'POSITIONAL',components:[{type:'BODY',text:entry.body}]};
  // Legacy button approval cannot be inferred without exact approved button facts.
  assert.equal(matchesApprovedReminderTemplate(actual,entry),!entry.buttonVariant);
  assert.equal(matchesApprovedReminderTemplate({...actual,components:[...actual.components,{type:'FOOTER',text:'Reply STOP to opt out'}]},entry),!entry.buttonVariant);
  for(const patch of [{found:false},{name:entry.name+'_wrong'},{language:'en_US'},{status:'ACTIVE'},{category:'MARKETING'},{parameter_format:'NAMED'},
    {components:[]},{components:[{type:'BODY',text:entry.body+' '}]},{components:[...actual.components,...actual.components]},
    {components:[...actual.components,{type:'HEADER',text:'Header'}]},{components:[...actual.components,{type:'BUTTONS',buttons:[]}]},
    {components:[...actual.components,{type:'FOOTER',text:'Wrong'}]}])assert.equal(matchesApprovedReminderTemplate({...actual,...patch},entry),false);
  const parameters=entry.parameterCount===5?facts:['Fixture studio','INV-001','Priya Sharma'];
  const rendered=buildReminderTemplate(entry,parameters);
  assert.equal(rendered.template.name,entry.name);assert.equal(rendered.template.language.code,'en');
  assert.deepEqual(rendered.template.components,[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]);
  assert.doesNotMatch(rendered.body,/\{\{|\}\}/);
  for(const invalid of ['', ' ', 'x'.repeat(257), 'a\nb','a\rb','a\tb','a{b','a}b','a\0b','a\x7fb','a\x85b','a\u2028b','a\u2029b',null,5]){
    for(let index=0;index<parameters.length;index++){
      const bad=[...parameters];bad[index]=invalid;assert.throws(()=>buildReminderTemplate(entry,bad),/Invalid/);
    }
  }
  assert.throws(()=>buildReminderTemplate(entry,parameters.slice(1)),/Invalid/);
  assert.throws(()=>buildReminderTemplate({...entry},parameters),/Invalid/);
});

test('workspace tones and per-debtor override select approved details; null inherits and default is professional',()=>{
  for(const [tone,expected] of [['gentle','relaxed'],['relaxed','relaxed'],['firm','firm'],['professional','professional'],[undefined,'professional'],['unknown','professional']]){
    assert.equal(selectInvoiceReminderTemplate({tone}).name,name(expected));
    for(const [debtor,mapped] of [['gentle','relaxed'],['relaxed','relaxed'],['firm','firm'],['professional','professional']]){
      assert.equal(selectInvoiceReminderTemplate({tone},debtor).name,name(mapped));
      assert.equal(selectInvoiceReminderTemplate({tone,templateButtons:true,templateName:'cetld_invoice_update_v2'},debtor).name,name(mapped));
    }
  }
  assert.equal(selectInvoiceReminderTemplate().name,name('professional'));
  for(const invalid of ['',false,0,'aggressive',{},undefined]){
    if(invalid!==undefined)assert.throws(()=>selectInvoiceReminderTemplate({},invalid),/Invalid debtor tone/);
  }
  for(const entry of REMINDER_TEMPLATES.filter(t=>t.parameterCount===3)){
    assert.equal(selectReminderTemplate({tone:entry.tone,templateButtons:entry.buttonVariant}),entry);
    assert.equal(selectInvoiceReminderTemplate({templateName:entry.name}),entry);
    if(entry.buttonVariant)assert.equal(selectInvoiceReminderTemplate({tone:entry.tone,templateButtons:true}),entry);
  }
  assert.throws(()=>selectInvoiceReminderTemplate({templateName:'model_authored_name'}),/Invalid/);
});

test('five parameters use first token, invoice balance, INR default, and workspace calendar date',()=>{
  assert.deepEqual(buildInvoiceReminderParameters({invoice,settings,customer}),facts);
  for(const name of ['', '   ',null])assert.equal(buildInvoiceReminderParameters({invoice,settings,customer:{name}})[0],'there');
  assert.equal(buildInvoiceReminderParameters({invoice,settings,customer:{name:'\u00a0Priya\u00a0Sharma\u00a0'}})[0],'Priya');
  assert.equal(formatReminderAmount({...invoice,total_amount:'1235067.89',amount_paid:'500'}),'₹12,34,567.89');
  assert.equal(formatReminderAmount({...invoice,currency:'USD',total_amount:'1234567.89',amount_paid:0}),'USD 1,234,567.89');
  assert.equal(formatReminderAmount({...invoice,currency:'EUR',total_amount:0.3,amount_paid:0.1}),'EUR 0.20');
  assert.equal(formatReminderAmount({...invoice,currency:'JPY',total_amount:12500,amount_paid:0}),'JPY 12,500.00');
  for(const timeZone of ['Asia/Kolkata','America/Los_Angeles','Pacific/Kiritimati'])assert.equal(formatReminderDueDate('2026-10-18',timeZone),'18 Oct 2026');
  assert.equal(formatReminderDueDate('2026-10-18T23:30:00Z','Asia/Kolkata'),'19 Oct 2026');
  assert.equal(formatReminderDueDate('2026-10-18T00:30:00Z','America/Los_Angeles'),'17 Oct 2026');
  assert.throws(()=>formatReminderDueDate('2026-02-30','UTC'),/Invalid/);
  assert.throws(()=>formatReminderDueDate('2026-10-18','invalid/timezone'),/time zone/i);
  for(const patch of [{currency:''},{currency:'XYZ!'}, {total_amount:NaN},{total_amount:'1.001'},{total_amount:1,amount_paid:1},{amount_paid:-1}])assert.throws(()=>formatReminderAmount({...invoice,...patch}),/Invalid/);
  for(const name of ['Priya\nSharma','Priya\tSharma','Priya {x}','Priya\x85Sharma',5])assert.throws(()=>buildInvoiceReminderParameters({invoice,settings,customer:{name}}),/Invalid/);
  for(const business_name of ['', 'bad\nname','x'.repeat(257)])assert.throws(()=>buildInvoiceReminderParameters({invoice,settings:{...settings,business_name},customer}),/Invalid/);
});

test('customer tone form exposes inheritance and every allowed tone; invalid selections fail',()=>{
  for(const tone of ['gentle','relaxed','firm','professional']){
    assert.equal(readDebtorReminderTone(tone),tone);
    assert.ok(debtorReminderToneForm({name:'Priya',reminder_tone:tone},String).includes(`value="${tone}" selected`));
  }
  assert.equal(readDebtorReminderTone(''),null);
  for(const invalid of ['invalid',null,{},true])assert.throws(()=>readDebtorReminderTone(invalid),/valid reminder tone/);
});

test('forward migrations constrain nullable debtor tone and extend rather than replace the atomic catalog',async()=>{
  const tone=await readFile(new URL('../supabase/migrations/20261018060000_customer_reminder_tone.sql',import.meta.url),'utf8');
  assert.match(tone,/alter table public\.customers add column reminder_tone text/);
  assert.match(tone,/reminder_tone is null or reminder_tone in \('gentle','relaxed','firm','professional'\)/);
  assert.doesNotMatch(tone,/reminder_tone text\s+(?:not null|default)/);
  assert.match(tone,/old\.reminder_tone is distinct from new\.reminder_tone/);
  assert.match(tone,/customer_id=new\.id/);assert.match(tone,/'approved_reminder_text',null/);
  const catalog=await readFile(new URL('../supabase/migrations/20261018060100_invoice_details_templates.sql',import.meta.url),'utf8');
  for(const entry of REMINDER_TEMPLATES.filter(t=>t.parameterCount===5)){
    assert.ok(catalog.includes(entry.name));assert.ok(catalog.includes(entry.body.replaceAll("'","''")));
  }
  assert.match(catalog,/parameter_count in \(3,5\)/);assert.match(catalog,/1\.\.t\.parameter_count/);
  assert.match(catalog,/coalesce\(x\.reminder_tone,s\.follow_up_preferences->>'tone','professional'\)/);
  assert.match(catalog,/Reminder gate patch point missing/);
  assert.doesNotMatch(catalog,/drop (?:table|function)|delete from|disable (?:trigger|row level security)/i);
});
