import {REMINDER_TONES,selectInvoiceReminderTemplate} from './automation/whatsapp/reminder-templates.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reviewTime=(value,timezone='Asia/Kolkata')=>new Date(value).toLocaleString('en-IN',{timeZone:timezone,day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
const label=tone=>tone[0].toUpperCase()+tone.slice(1);

// Transport-independent view: all window/eligibility facts and approval tokens come from the server.
export function reminderReviewForm({text,tone='professional',customer,number}) {
  return `<form id="draft-form"><div class="dialog-body reminder-review-body"><p>${escape(customer)} · ${escape(number)}</p>
    <label class="field">Tone for this reminder<select name="tone">${REMINDER_TONES.map(t=>`<option value="${t}" ${t===tone?'selected':''}>${label(t)}</option>`).join('')}</select></label>
    <label class="field">Your message<textarea name="message" rows="7" maxlength="4000" required>${escape(text)}</textarea></label>
    <p class="settings-hint">Custom text can send only while the customer is active within 24 hours. Otherwise, review the approved template below. Saving a draft resets approval.</p>
    <button class="btn" type="button" data-preview-reminder>Preview delivery</button>
    <section class="reminder-delivery-preview" aria-live="polite" aria-atomic="true" data-delivery-preview><p>Preview delivery to check the actual outgoing words and form before approval.</p></section>
    <div class="error hidden" data-error role="alert"></div>
    </div><div class="dialog-foot"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn" type="submit">Save draft</button><button class="btn primary" type="button" data-approve-reminder disabled>Approve reviewed delivery</button></div></form>`;
}

export function validateDeliveryPreview(preview,{text,tone},now=Date.now()) {
  if(!preview||preview.eligible!==true)throw Error(preview?.reason||'This reminder is not eligible for approval.');
  if(typeof preview.approvalToken!=='string'||!preview.approvalToken||!Number.isFinite(Date.parse(preview.expiresAt))||Date.parse(preview.expiresAt)<=now)throw Error('The delivery preview expired. Preview it again.');
  const d=preview.delivery;
  if(!d||!['service','template'].includes(d.form)||typeof d.text!=='string'||!d.text.trim()||d.text.length>4000)throw Error('The server did not confirm the outgoing words and form.');
  if(d.form==='service'&&(d.text!==text||d.windowClosedPolicy!=='hold'||!Number.isFinite(Date.parse(d.windowExpiresAt))||Date.parse(d.windowExpiresAt)<=now))throw Error('The server must confirm your exact message and hold it for re-review if the service window closes.');
  if(d.form==='template'&&d.templateName!==selectInvoiceReminderTemplate({tone},tone).name)throw Error('The approved template does not match the selected tone. Preview again.');
  return preview;
}

export function deliveryPreviewView(preview,{text,timezone}) {
  const d=preview.delivery,service=d.form==='service';
  return `<h3>${service?'Will send as your message (customer active within 24h)':`Will send as approved template: ${escape(d.templateName)}`}</h3>
    ${!service&&d.text!==text?'<p class="notice">Your edited text cannot be delivered as-is in this delivery form. Only the template below will be sent; your custom text stays in the dashboard.</p>':''}
    <blockquote>${escape(d.text)}</blockquote>
    ${service?`<p>Service window closes ${escape(reviewTime(d.windowExpiresAt,timezone))}. If it closes before send, this reminder will be held for re-review. No template will be substituted.</p>`:'<p>This approval covers the named template and the exact words shown above.</p>'}
    <label class="delivery-acknowledgement"><input type="checkbox" data-delivery-ack><span>${service?'I approve these exact words as a service message. Hold for re-review if the window closes.':'I choose this approved template and the exact words shown above.'}</span></label>`;
}

export function mountReminderReview(form,{requestPreview,approve,onSaveDraft,onApproved,isCurrent=()=>true,timezone,now=()=>Date.now()}) {
  let preview=null,revision=0,busy=false,controller=null,timer=null;
  const output=form.querySelector('[data-delivery-preview]'),approveButton=form.querySelector('[data-approve-reminder]'),previewButton=form.querySelector('[data-preview-reminder]'),error=form.querySelector('[data-error]');
  const values=()=>({text:form.elements.message.value.trim(),tone:form.elements.tone.value});
  const current=()=>form.isConnected&&isCurrent();
  const showError=e=>{error.textContent=e.message||'Reminder review is unavailable.';error.classList.remove('hidden')};
  const reset=()=>{revision++;preview=null;controller?.abort();clearTimeout(timer);approveButton.disabled=true;error.classList.add('hidden');output.innerHTML='<p>Delivery preview needs updating. Preview again before approval.</p>'};
  const lock=value=>{busy=value;previewButton.disabled=value;form.querySelector('[type=submit]').disabled=value;form.elements.message.disabled=value;form.elements.tone.disabled=value;approveButton.disabled=value||!preview||!output.querySelector('[data-delivery-ack]')?.checked};
  form.addEventListener('input',event=>{if(event.target.matches('[name="message"],[name="tone"]'))reset()});
  form.addEventListener('change',event=>{if(event.target.matches('[name="tone"]'))reset();if(event.target.matches('[data-delivery-ack]'))approveButton.disabled=busy||!preview||!event.target.checked});
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
      const result=await approve({approvalToken:reviewed.approvalToken,...input,windowClosedPolicy:'hold'});
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
  return ()=>{reset();controller?.abort();clearTimeout(timer)};
}

export function approvedDeliverySummary(approval) {
  if(!approval||!['service','template'].includes(approval.form)||typeof approval.text!=='string')return '';
  if(approval.form==='service'&&approval.windowClosedPolicy!=='hold')return '<p class="notice">Delivery policy needs review before this reminder can send.</p>';
  return `<section class="approved-delivery-summary"><h3>Approved delivery</h3><strong>${approval.form==='service'?'Your message · service message':`Approved template: ${escape(approval.templateName)}`}</strong><blockquote>${escape(approval.text)}</blockquote><p>${approval.form==='service'?'If the 24-hour window closes before send: hold for re-review. No template substitution.':'Only these approved template words may be sent.'}</p></section>`;
}
