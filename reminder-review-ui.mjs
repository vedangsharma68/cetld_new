import {buildInvoiceReminderParameters} from './automation/whatsapp/reminder-parameters.mjs';
import {REMINDER_TONES,selectInvoiceReminderTemplate,buildReminderTemplate} from './automation/whatsapp/reminder-templates.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reviewTime=(value,timezone='Asia/Kolkata')=>new Date(value).toLocaleString('en-IN',{timeZone:timezone,day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
const label=tone=>tone[0].toUpperCase()+tone.slice(1);

// Transport-independent view: all window/eligibility facts and approval tokens come from the server.
export function reminderReviewForm({text,tone='professional',customer,number,sendNow=false}) {
  return `<form id="draft-form"><div class="dialog-body reminder-review-body"><p>${escape(customer)} · ${escape(number)}</p>
    <label class="field">Delivery timing<select name="sendNow"><option value="false" ${!sendNow?'selected':''}>Scheduled follow-up</option><option value="true" ${sendNow?'selected':''}>Send once now</option></select></label>
    <label class="field">Tone for this reminder<select name="tone">${REMINDER_TONES.map(t=>`<option value="${t}" ${t===tone?'selected':''}>${label(t)}</option>`).join('')}</select></label>
    <label class="field">Your message<textarea name="message" rows="7" maxlength="4000" required>${escape(text)}</textarea></label>
    <p class="settings-hint">Cetld uses approved templates for scheduled reminders. For a one-off send, your edited message can send within the customer’s 24-hour service window. Saving a draft resets approval.</p>
    <label class="delivery-acknowledgement"><input type="checkbox" name="approveFallback"><span>For a one-off message, allow the named template below if the service window closes. Both versions must be reviewed before approval.</span></label>
    <button class="btn" type="button" data-preview-reminder>Preview delivery</button>
    <section class="reminder-delivery-preview" aria-live="polite" aria-atomic="true" data-delivery-preview><p>Preview delivery to check the actual outgoing words and form before approval.</p></section>
    <div class="error hidden" data-error role="alert"></div>
    </div><div class="dialog-foot"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn" type="submit">Save draft</button><button class="btn primary" type="button" data-approve-reminder disabled>Approve reviewed delivery</button></div></form>`;
}

export function validateDeliveryPreview(preview,{text,tone,sendNow,approveFallback},now=Date.now()) {
  if(!preview||preview.eligible!==true)throw Error(preview?.reason||'This reminder is not eligible for approval.');
  if(typeof preview.approvalToken!=='string'||!preview.approvalToken||!Number.isFinite(Date.parse(preview.expiresAt))||Date.parse(preview.expiresAt)<=now)throw Error('The delivery preview expired. Preview it again.');
  const d=preview.delivery;
  if(!d||!['service','template'].includes(d.form)||typeof d.text!=='string'||!d.text.trim()||d.text.length>4000)throw Error('The server did not confirm the outgoing words and form.');
  if(d.form==='service'&&((preview.sendNow===false||sendNow===false)||d.text!==text||!['hold','template_fallback'].includes(d.windowClosedPolicy)||!Number.isFinite(Date.parse(d.windowExpiresAt))||Date.parse(d.windowExpiresAt)<=now))throw Error('The server must confirm your exact message and its window-expiry policy. Scheduled reminders require approved templates under cetld’s delivery rules.');
  if(d.form==='service'&&d.windowClosedPolicy==='template_fallback'&&(!d.fallback||d.fallback.form!=='template'||d.fallback.templateName!==selectInvoiceReminderTemplate({tone},tone).name||typeof d.fallback.text!=='string'||!d.fallback.text.trim()))throw Error('The named fallback and its exact words need confirmation.');
  if(d.form==='service'&&Boolean(d.fallback)!==Boolean(approveFallback))throw Error('The fallback choice changed. Preview both delivery forms again.');
  if(d.form==='service'&&d.windowClosedPolicy==='hold'&&d.fallback)throw Error('A fallback cannot be selected without explicit approval.');
  if(d.form==='template'&&d.templateName!==selectInvoiceReminderTemplate({tone},tone).name)throw Error('The approved template does not match the selected tone. Preview again.');
  return preview;
}

export function deliveryPreviewView(preview,{text,timezone}) {
  const d=preview.delivery,service=d.form==='service';
  return `<h3>${service?'Will send as your message (customer active within 24h)':`Will send as approved template: ${escape(d.templateName)}`}</h3>
    ${preview.deliveryReason==='scheduled_template_only'?'<p>Cetld’s scheduled reminders use approved templates, including when the customer is active within 24 hours.</p>':''}
    ${!service&&d.text!==text?'<p class="notice">Your edited text cannot be delivered as-is in this delivery form. Only the template below will be sent; your custom text stays in the dashboard.</p>':''}
    <blockquote>${escape(d.text)}</blockquote>
    ${service?`<p>Service window closes ${escape(reviewTime(d.windowExpiresAt,timezone))}.</p>${d.fallback?`<h4>If the window closes: approved fallback template ${escape(d.fallback.templateName)}</h4><blockquote>${escape(d.fallback.text)}</blockquote><p>Only this separately approved fallback may replace your message.</p>`:'<p>If it closes before send, this reminder will be held for re-review. No template will be substituted.</p>'}`:'<p>This approval covers the named template and the exact words shown above.</p>'}
    <p class="settings-hint">Consent, invoice eligibility and contact hours are checked again before sending.</p>
    <label class="delivery-acknowledgement"><input type="checkbox" data-delivery-ack><span>${service?d.fallback?'I approve both versions: my exact message while eligible, and this named template if the window closes.':'I approve these exact words as a service message. Hold for re-review if the window closes.':'I choose this approved template and the exact words shown above.'}</span></label>`;
}

export function mountReminderReview(form,{requestPreview,approve,onSaveDraft,onApproved,isCurrent=()=>true,makeToneDraft,confirmReplace=message=>window.confirm(message),timezone,now=()=>Date.now()}) {
  let preview=null,revision=0,busy=false,controller=null,timer=null,lastTone=form.elements.tone.value,lastDraft=form.elements.message.value;
  if(makeToneDraft){try{lastDraft=makeToneDraft(lastTone)}catch{lastDraft=null}}
  const output=form.querySelector('[data-delivery-preview]'),approveButton=form.querySelector('[data-approve-reminder]'),previewButton=form.querySelector('[data-preview-reminder]'),error=form.querySelector('[data-error]');
  const values=()=>({text:form.elements.message.value.trim(),tone:form.elements.tone.value,sendNow:form.elements.sendNow.value==='true',approveFallback:form.elements.approveFallback.checked});
  const current=()=>form.isConnected&&isCurrent();
  const showError=e=>{error.textContent=e.message||'Reminder review is unavailable.';error.classList.remove('hidden')};
  const reset=()=>{revision++;preview=null;controller?.abort();clearTimeout(timer);approveButton.disabled=true;error.classList.add('hidden');output.innerHTML='<p>Delivery preview needs updating. Preview again before approval.</p>'};
  const lock=value=>{busy=value;previewButton.disabled=value;form.querySelector('[type=submit]').disabled=value;form.elements.message.disabled=value;form.elements.tone.disabled=value;form.elements.sendNow.disabled=value;form.elements.approveFallback.disabled=value||form.elements.sendNow.value!=='true';approveButton.disabled=value||!preview||!output.querySelector('[data-delivery-ack]')?.checked};
  form.addEventListener('input',event=>{if(event.target.matches('[name="message"],[name="tone"],[name="sendNow"],[name="approveFallback"]'))reset()});
  form.addEventListener('change',event=>{if(event.target.matches('[name="tone"]')){reset();if(makeToneDraft){try{if(form.elements.message.value===lastDraft||confirmReplace('Replace your edited message with the selected tone’s draft?')){lastDraft=makeToneDraft(form.elements.tone.value);form.elements.message.value=lastDraft;lastTone=form.elements.tone.value}else form.elements.tone.value=lastTone}catch(e){showError(e)}}}if(event.target.matches('[name="sendNow"],[name="approveFallback"]')){if(form.elements.sendNow.value!=='true')form.elements.approveFallback.checked=false;reset();lock(false);}if(event.target.matches('[data-delivery-ack]'))approveButton.disabled=busy||!preview||!event.target.checked});
  previewButton.addEventListener('click',async()=>{
    if(busy||!current())return;reset();const input=values();
    if(!input.text||!REMINDER_TONES.includes(input.tone)){showError(Error('Write a message and choose its tone.'));return}
    const attempt=revision;controller=new AbortController();lock(true);output.textContent='Checking delivery eligibility…';
    try{
      const result=validateDeliveryPreview(await requestPreview(input,{signal:controller.signal}),input,now());
      if(!current()||attempt!==revision)return;
      preview=result;output.innerHTML=deliveryPreviewView(result,{...input,timezone});
      const expires=Math.min(Date.parse(result.expiresAt),result.delivery.form==='service'?Date.parse(result.delivery.windowExpiresAt):Infinity);
      timer=setTimeout(()=>{if(!current())return;reset();showError(Error('This preview expired. Preview delivery again before approval.'))},Math.max(0,expires-now()));
    }catch(e){if(current()&&attempt===revision){output.textContent='Delivery could not be confirmed. Nothing was approved.';showError(e)}}
    finally{if(current())lock(false)}
  });
  approveButton.addEventListener('click',async()=>{
    if(busy||!current()||!preview||!output.querySelector('[data-delivery-ack]')?.checked)return;
    const input=values(),reviewed=preview;
    try{
      validateDeliveryPreview(reviewed,input,now());lock(true);error.classList.add('hidden');
      const result=await approve({approvalToken:reviewed.approvalToken,reviewPayload:reviewed.reviewPayload,...input,windowClosedPolicy:reviewed.delivery.windowClosedPolicy});
      if(!current())return;
      if(result?.approved!==true)throw Error('Approval was not confirmed. Refresh and review this reminder again.');
      clearTimeout(timer);preview=null;await onApproved(result);
    }catch(e){if(current()){reset();showError(e)}}finally{if(current())lock(false)}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!current())return;
    const input=values();if(!input.text){showError(Error('Write a message before saving.'));return}
    lock(true);try{await onSaveDraft(input)}catch(e){if(current())showError(e)}finally{if(current())lock(false)}
  });
  lock(false);
  return ()=>{reset();controller?.abort();clearTimeout(timer)};
}

export function reminderToneDraft({invoice,settings,customer},tone) {
  const entry=selectInvoiceReminderTemplate({},tone);
  const body=buildReminderTemplate(entry,buildInvoiceReminderParameters({invoice,settings,customer})).body;
  // Editable draft copy can use natural grammar. The delivery preview always
  // renders the server's exact Meta-approved template, including its fixed copy.
  return body.replace(`I'm Cetld, ${settings.business_name}'s assistant.`,()=>`I'm Cetld, an assistant for ${settings.business_name}.`);
}

export function approvedDeliverySummary(approval) {
  if(!approval||!['service','template'].includes(approval.form)||typeof approval.text!=='string')return '';
  if(approval.form==='service'&&!['hold','template_fallback'].includes(approval.windowClosedPolicy))return '<p class="notice">Delivery policy needs review before this reminder can send.</p>';
  return `<section class="approved-delivery-summary"><h3>Approved delivery</h3><strong>${approval.form==='service'?'Your message · service message':`Approved template: ${escape(approval.templateName)}`}</strong><blockquote>${escape(approval.text)}</blockquote>${approval.form==='service'&&approval.fallback?`<h4>Approved fallback: ${escape(approval.fallback.templateName)}</h4><blockquote>${escape(approval.fallback.text)}</blockquote><p>If the 24-hour window closes, only this approved template may be sent.</p>`:`<p>${approval.form==='service'?'If the 24-hour window closes before send: hold for re-review. No template substitution.':'Only these approved template words may be sent.'}</p>`}</section>`;
}

// The immutable server receipt is the authority, never the later editable draft.
export function queuedReminderDeliveryView(invoice) {
  if(!invoice||['paid','void','cancelled'].includes(invoice.status))return '';
  const reason=invoice.reminder_review_reason??invoice.metadata?.reminder_review_reason;
  const pending=['approved','active','scheduled'].includes(invoice.followup_state);
  const needsReview=['delivery_form_review','undeliverable_window_expired','scheduled_template_only'].includes(reason);
  if(!pending&&!needsReview)return '';
  const delivery=invoice.metadata?.approved_reminder_delivery??invoice.approved_reminder_delivery;
  const reviewedAt=invoice.metadata?.approved_reminder_delivery_reviewed_at??invoice.approved_reminder_delivery_reviewed_at;
  const evaluation=invoice.reminder_delivery_outcome==='template_fallback'?'<p class="notice">Dispatch evaluated as the explicitly approved template fallback. Check delivery status for its receipt.</p>':'';
  const notice=needsReview?`<section class="approved-delivery-summary" role="status"><h3>Delivery needs re-review</h3><p>${reason==='scheduled_template_only'?'Cetld uses approved templates for scheduled reminders. Review delivery again.':reason==='undeliverable_window_expired'?'The customer’s 24-hour service window closed. Your approved message was held; no different words were sent.':'Review the exact outgoing words and delivery form before this reminder can send.'}</p></section>`:'';
  if(!['template','freeform'].includes(delivery?.type)||typeof delivery.body!=='string'||!delivery.body||!Number.isFinite(Date.parse(reviewedAt)))return notice||'<section class="approved-delivery-summary"><h3>Delivery needs re-review</h3><p>The outgoing words and delivery form have not been confirmed for this reminder. Review delivery before it can send.</p></section>';
  return notice+evaluation+approvedDeliverySummary({form:delivery.type==='freeform'?'service':'template',templateName:delivery.name,text:delivery.body,
    windowClosedPolicy:delivery.fallback?'template_fallback':'hold',fallback:delivery.fallback?{templateName:delivery.fallback.name,text:delivery.fallback.body}:null});
}
