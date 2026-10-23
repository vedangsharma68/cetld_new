import test from 'node:test';
import {createAssistantClient} from '../assistant-client.js';
import {invoiceWhatsAppDisclosure} from '../invoice/whatsapp-disclosure.mjs';
import assert from 'node:assert/strict';
import {followUpPreferencesForm} from '../followup-preferences-ui.mjs';
import {ownerWhatsAppSettings} from '../owner-whatsapp-ui.mjs';
import {debtorReminderToneForm} from '../reminder-tone-ui.mjs';

test('Settings and customer tone helpers consistently call the account a business',()=>{
  for(const html of [followUpPreferencesForm(),ownerWhatsAppSettings({owner:true,phone:'+919871367051',businessName:'Example'}),debtorReminderToneForm({name:'Example'},String)])assert.doesNotMatch(html,/\bworkspace\b/i);
});

test('an assistant without a selected business refuses the request with business wording',async()=>{
  let requests=0;
  const client=createAssistantClient({getAccessToken:async()=>'token',fetchImpl:async()=>{requests++;throw Error('Unexpected request')}});
  await assert.rejects(client.send({messages:[{role:'user',content:'Hello'}]}),/Open a business/);
  assert.equal(requests,0);
  assert.throws(()=>invoiceWhatsAppDisclosure(' '),error=>error.message==='A business name is required');
});
