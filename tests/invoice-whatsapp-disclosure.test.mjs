import test from 'node:test';
import assert from 'node:assert/strict';
import {invoiceWhatsAppDisclosure} from '../invoice/whatsapp-disclosure.mjs';

test('invoice notice names the current workspace business and STOP', () => {
  assert.equal(invoiceWhatsAppDisclosure('Acme Studio'),
    'Invoice updates from Acme Studio on WhatsApp. Reply STOP anytime.');
  assert.throws(() => invoiceWhatsAppDisclosure(' '), /business name/);
});
