import test from 'node:test';
import assert from 'node:assert/strict';
import {reminderReviewForm,validateDeliveryPreview,deliveryPreviewView,approvedDeliverySummary} from '../reminder-review-ui.mjs';
const now=Date.parse('2026-10-23T10:00:00Z');
const input={text:'Please pay invoice 123.',tone:'firm'};
const service=()=>({eligible:true,approvalToken:'server-bound-token',expiresAt:'2026-10-23T10:05:00Z',delivery:{form:'service',text:input.text,windowExpiresAt:'2026-10-23T11:00:00Z',windowClosedPolicy:'hold'}});
test('service approval requires exact words and a server-confirmed hold policy',()=>{
  assert.equal(validateDeliveryPreview(service(),input,now).delivery.form,'service');
  for(const delivery of [{...service().delivery,text:'Different words'},{...service().delivery,windowClosedPolicy:'template'},{...service().delivery,windowExpiresAt:'2026-10-23T09:00:00Z'}])assert.throws(()=>validateDeliveryPreview({...service(),delivery},input,now));
  assert.throws(()=>validateDeliveryPreview({...service(),eligible:false},input,now));
  assert.throws(()=>validateDeliveryPreview({...service(),expiresAt:'2026-10-23T09:00:00Z'},input,now));
  assert.match(deliveryPreviewView(service(),input),/No template will be substituted/);
});
test('template approval maps the selected tone and explicitly reviews replacement text',()=>{
  const p={...service(),delivery:{form:'template',text:'Approved firm template words.',templateName:'cetld_invoice_details_firm_v1'}};
  assert.equal(validateDeliveryPreview(p,input,now),p);
  assert.throws(()=>validateDeliveryPreview(p,{...input,tone:'professional'},now));
  const html=deliveryPreviewView(p,input);assert.match(html,/cannot be delivered as-is/);assert.match(html,/I choose this approved template/);assert.match(html,/Approved firm template words/);
});
test('review and scheduled summaries escape text, show form, and start without approval',()=>{
  assert.match(reminderReviewForm({text:'<script>',tone:'firm',customer:'<img>',number:'1'}),/&lt;script&gt;/);
  assert.match(reminderReviewForm(input),/data-approve-reminder disabled/);
  assert.match(approvedDeliverySummary(service().delivery),/hold for re-review/);
  assert.match(approvedDeliverySummary({form:'template',text:'<script>',templateName:'<img>'}),/&lt;img&gt;/);
});

test('queued reminders show the server receipt words, never the later editable draft',async()=>{
  const {queuedReminderDeliveryView}=await import('../reminder-review-ui.mjs');
  const invoice={status:'sent',followup_state:'approved',reminder_text:'Different editable words',metadata:{approved_reminder_delivery:{type:'template',name:'cetld_invoice_details_firm_v1',body:'Exactly approved words'},approved_reminder_delivery_reviewed_at:'2026-10-23T10:00:00Z'}};
  const html=queuedReminderDeliveryView(invoice);
  assert.match(html,/Exactly approved words/);assert.match(html,/cetld_invoice_details_firm_v1/);assert.doesNotMatch(html,/Different editable words/);
  assert.equal(queuedReminderDeliveryView({...invoice,status:'paid'}),'');
  assert.match(queuedReminderDeliveryView({...invoice,metadata:{}}),/Delivery needs re-review/);
});

test('editable tone drafts avoid possessive apostrophes in business names',async()=>{
  const {reminderToneDraft}=await import('../reminder-review-ui.mjs');
  for(const business_name of ['CETLD test','QA Sharma Traders',"James' Studio",'A$&B']){
    for(const tone of ['gentle','relaxed','firm','professional']){
      const text=reminderToneDraft({invoice:{invoice_number:'INV-1',total_amount:'1500.00',currency:'INR',due_date:'2026-10-30'},settings:{business_name},customer:{name:'Customer'}},tone);
      assert.ok(text.includes(`I'm Cetld, an assistant for ${business_name}.`));
      assert.ok(!text.includes(`${business_name}'s assistant`));
    }
  }
});

test('test invoice review shows the block, honest default and no approvable payment template',async()=>{
  const {reminderToneDraft,queuedReminderDeliveryView}=await import('../reminder-review-ui.mjs');
  const {REMINDER_TEMPLATES,TEST_REMINDER_TEMPLATE_DRAFT}=await import('../automation/whatsapp/reminder-templates.mjs');
  const invoice={invoice_number:'CETLD-TEST-fixture-NO-PAYMENT-REQUIRED',metadata:{test_invoice:true},status:'sent',followup_state:'approved'};
  const context={invoice,settings:{business_name:'Test business'},customer:{name:'Pappa'}};
  for(const tone of ['gentle','relaxed','firm','professional']){
    const text=reminderToneDraft(context,tone);
    assert.match(text,/^TEST — NO PAYMENT REQUIRED\n/);
    assert.doesNotMatch(text,/outstanding|please arrange payment|expected payment date/i);
  }
  const html=reminderReviewForm({text:reminderToneDraft(context,'firm'),testInvoice:true});
  assert.match(html,/Template delivery is blocked/);
  assert.match(html,/approved template cannot carry explicit TEST/);
  assert.match(html,/name="approveFallback" disabled/);
  assert.match(html,/data-approve-reminder disabled/);
  const queued=queuedReminderDeliveryView({...invoice,metadata:{...invoice.metadata,approved_reminder_delivery:{type:'template',body:'Demand payment'}}});
  assert.match(queued,/Template delivery blocked/);assert.doesNotMatch(queued,/Demand payment/);
  const p={...service(),delivery:{form:'template',text:'Payment demand',templateName:'cetld_invoice_details_firm_v1'}};
  assert.throws(()=>validateDeliveryPreview(p,{...input,testInvoice:true},now),/Template delivery is blocked/);
  assert.throws(()=>validateDeliveryPreview(service(),{...input,testInvoice:true},now),/standalone TEST/);
  assert.ok(!REMINDER_TEMPLATES.includes(TEST_REMINDER_TEMPLATE_DRAFT));
  assert.match(TEST_REMINDER_TEMPLATE_DRAFT.body,/^TEST — NO PAYMENT REQUIRED\n/);
});

test('normal invoice tone drafts remain byte-identical to the existing approved render',async()=>{
  const {reminderToneDraft}=await import('../reminder-review-ui.mjs');
  const {selectInvoiceReminderTemplate,buildReminderTemplate}=await import('../automation/whatsapp/reminder-templates.mjs');
  const {buildInvoiceReminderParameters}=await import('../automation/whatsapp/reminder-parameters.mjs');
  const context={invoice:{invoice_number:'INV-1',total_amount:'1500.00',currency:'INR',due_date:'2026-10-30'},settings:{business_name:'Ordinary business'},customer:{name:'Customer'}};
  for(const tone of ['gentle','relaxed','firm','professional']){
    const before=buildReminderTemplate(selectInvoiceReminderTemplate({},tone),buildInvoiceReminderParameters(context)).body.replace("I'm Cetld, Ordinary business's assistant.","I'm Cetld, an assistant for Ordinary business.");
    assert.equal(reminderToneDraft(context,tone),before);
  }
});
