import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {brandedReminder} from '../automation/preferences.mjs';
import assert from 'node:assert/strict';
import {createReminderReviewNetwork} from './fixtures/reminder-review-network.mjs';
import {deliveryPreviewView} from '../reminder-review-ui.mjs';
import {REMINDER_TEMPLATES,buildReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');

test('exact words survive preview, attestation, PostgreSQL artifact and actual provider parameters',async t=>{
 const f=await createReminderReviewNetwork();
 try{
  for(const sendNow of [false,true])await t.test(sendNow?'service preserves the complete owner signature and punctuation':'template preserves the exact approved words without a metadata-only signature',async()=>{
   const data=await f.seed(),text='Please reply if you have any questions. — Thank you!\n\nBrowser business';
   const p=await f.api('preview-reminder',{invoiceId:data.invoice.id,text,tone:'professional',sendNow,approveFallback:false});
   assert.equal(p.code,200,JSON.stringify({data:p.data,errors:f.errors}));
   const preview=p.data,words=preview.delivery.text,payload=preview.reviewPayload.payload;
   assert.equal(payload.preview,words);assert.equal(payload.approvalText,words);assert.equal(payload.template.reviewedDelivery.body,words);
   if(sendNow)assert.equal(words,text);else assert.ok(!words.endsWith('\n\nBrowser business'));
   const html=deliveryPreviewView(preview,{text});
   assert.ok(html.includes(`<blockquote>${escape(words)}</blockquote>`));
   assert.ok(html.indexOf(escape(words))<html.indexOf('data-delivery-ack'),'the complete words precede the attestation');
   const changed=structuredClone(preview.reviewPayload);changed.payload.approvalText+='\n\nUnreviewed signature';
   assert.equal((await f.api('approve-reminder',{approvalToken:preview.approvalToken,reviewPayload:changed,confirmed:true})).code,409);
   assert.equal((await f.api('approve-reminder',{approvalToken:preview.approvalToken,reviewPayload:preview.reviewPayload,confirmed:true})).code,200);
   await f.service();
   const row=(await f.db.query('select * from invoices where id=$1',[data.invoice.id])).rows[0];
   const receipt=(await f.db.query('select * from app.reminder_approvals where invoice_id=$1',[data.invoice.id])).rows[0];
   assert.equal(row.metadata.approved_reminder_text,words);assert.equal(row.metadata.approved_reminder_delivery.body,words);assert.equal(receipt.approved_text,words);
   if(!sendNow)await f.db.query("update invoices set next_follow_up_at=clock_timestamp()-interval '1 minute' where id=$1",[data.invoice.id]);
   const tick=await f.tick();assert.equal(tick.results.find(result=>result.invoiceId===data.invoice.id)?.status,'sent',JSON.stringify({tick,errors:f.errors}));
   const sent=f.graph.at(-1);
   if(sendNow)assert.equal(sent.text.body,words);
   else{
    const entry=REMINDER_TEMPLATES.find(entry=>entry.name===sent.template.name);
    const parameters=sent.template.components.find(component=>component.type==='body').parameters.map(parameter=>parameter.text);
    assert.equal(buildReminderTemplate(entry,parameters).body,words);
    assert.deepEqual(parameters,payload.template.parameters);
   }
  });
  await t.test('older signed artifacts continue to dispatch their original reviewed words',async()=>{
   const data=await f.seed(),text='Legacy reviewed words.';
   const preview=await f.api('preview-reminder',{invoiceId:data.invoice.id,text,tone:'professional',sendNow:true});
   const payload=structuredClone(preview.data.reviewPayload.payload);delete payload.template.reviewedDelivery.artifactVersion;
   payload.approvalText=brandedReminder(text,data.settings.business_name);
   const id=randomUUID();await f.asUser();
   const proposed=await f.supabase.rpc('owner_assistant_propose',{p_workspace_id:f.workspaceId,p_owner_id:f.ownerId,p_proposal:{id,type:'owner_reminder',payload,summary:'Legacy exact words review'}});
   assert.equal(proposed.data?.id,id,JSON.stringify(proposed));
   const confirmed=await f.supabase.rpc('owner_assistant_decide',{p_workspace_id:f.workspaceId,p_owner_id:f.ownerId,p_id:id,p_confirmed:true});
   assert.equal(confirmed.data?.ok,true,JSON.stringify(confirmed));
   await f.service();const before=(await f.db.query('select metadata from invoices where id=$1',[data.invoice.id])).rows[0].metadata;
   assert.equal(before.approved_reminder_text,payload.approvalText);
   const tick=await f.tick();assert.equal(tick.results.find(result=>result.invoiceId===data.invoice.id)?.status,'sent',JSON.stringify(tick));
   assert.equal(f.graph.at(-1).text.body,text);
  });
  await t.test('a client cannot manufacture an exact-word receipt or change approved words',async()=>{
   const data=await f.seed();await f.asUser();await f.db.exec('set role authenticated');
   await assert.rejects(f.db.query("update invoices set metadata=metadata||$2::jsonb where id=$1",[data.invoice.id,{followup_state:'approved',approved_reminder_text:'Unreviewed',approved_reminder_delivery:{version:2,artifactVersion:1,approvalId:data.invoice.id,body:'Unreviewed'}}]),/permission denied|exact reviewed reminder words/);
   await f.service();assert.equal((await f.db.query('select count(*)::int n from app.reminder_approvals where invoice_id=$1',[data.invoice.id])).rows[0].n,0);
  });
 }finally{await f.close();}
});
