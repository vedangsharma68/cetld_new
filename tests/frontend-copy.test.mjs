import test from 'node:test';
import assert from 'node:assert/strict';
import {followUpPreferencesForm} from '../followup-preferences-ui.mjs';
import {ownerWhatsAppSettings} from '../owner-whatsapp-ui.mjs';
import {debtorReminderToneForm} from '../reminder-tone-ui.mjs';

test('Settings and customer tone helpers consistently call the account a business',()=>{
  for(const html of [followUpPreferencesForm(),ownerWhatsAppSettings({owner:true,phone:'+919871367051',businessName:'Example'}),debtorReminderToneForm({name:'Example'},String)])assert.doesNotMatch(html,/\bworkspace\b/i);
});
