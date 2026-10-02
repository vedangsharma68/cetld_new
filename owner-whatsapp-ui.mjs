const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const CETLD_WHATSAPP_NUMBER='917303338959';
export function normalizeOwnerPhone(value){
 const phone=String(value||'').trim().replace(/[\s().-]/g,'');
 if(!/^\+[1-9]\d{7,14}$/.test(phone))throw Error('Include the country code, for example +919871367051.');
 return phone;
}
export function ownerWhatsAppSettings({owner=false,phone='',businessName='',verification=null}={}){
 const link='https://wa.me/'+CETLD_WHATSAPP_NUMBER;
 let body;
 if(!owner)body='<p>Only the workspace owner can connect or disconnect their number.</p>';
 else if(verification)body=`<div role="status"><p>Open WhatsApp from <strong>${escape(verification.phone)}</strong>. Send the prefilled message to connect your number.</p><a class="btn primary" href="${link}?text=${encodeURIComponent('LINK '+verification.code)}" target="_blank" rel="noopener">Open WhatsApp</a><p class="settings-hint">Keep this page open. It updates when your number is connected. The link expires in 10 minutes.</p><details><summary>Using WhatsApp on another device?</summary><p>Send <strong>LINK ${escape(verification.code)}</strong> to +91 73033 38959 from your number.</p></details><button class="btn ghost" type="button" data-action="owner-verify-cancel">Cancel setup</button></div>`;
 else body=`${phone?`<p role="status">Connected · <strong>${escape(phone)}</strong></p><p class="settings-hint">The bot can read your dashboard invoices, retrieve files, and confirm changes.</p><a class="btn" href="${link}" target="_blank" rel="noopener">Chat with the bot</a> <button class="btn ghost" type="button" data-action="owner-disconnect">Disconnect</button>`:''}<form id="whatsapp-owner-form" class="settings-fields"><label class="field">Your WhatsApp number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+919876543210" value="${escape(phone)}" maxlength="24" required></label>${businessName.trim()?'':'<p class="settings-hint">Save your business name in Profile first.</p>'}<p class="settings-hint">Use your own number, including its country code. You only need to connect it once.</p><div class="error hidden" data-error role="alert"></div><button class="btn primary" type="submit" ${businessName.trim()?'':'disabled'}>${phone?'Connect a different number':'Connect WhatsApp'}</button></form>`;
 return `<section class="panel" id="owner-whatsapp" aria-labelledby="owner-whatsapp-title"><div class="panel-head"><div><h2 id="owner-whatsapp-title">Your WhatsApp</h2><p>Manage the same invoices you see in this dashboard.</p></div></div><div class="panel-body">${body}</div></section>`;
}