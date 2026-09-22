import test from 'node:test';
import assert from 'node:assert/strict';
import {FollowUpEngine} from '../automation/engine.mjs';
import {MemoryAutomationStore} from '../automation/store.mjs';
import {MockWhatsAppProvider} from '../automation/whatsapp/mock.mjs';
import {nextContactTime,scheduleNextFollowUp} from '../automation/cadence.mjs';
const scope={ownerId:'owner',workspaceId:'workspace',invoiceId:'invoice'};
const at=new Date('2026-09-22T10:00:00Z');
function setup(patch={},checker) {
  const store=new MemoryAutomationStore({now:()=>at});
  store.seedInvoice({id:scope.invoiceId,...scope,amountMinor:1000,paidMinor:0,followupState:'approved',nextFollowUpAt:'2026-09-22T09:00:00Z',customerPhone:'+919876543210',reminderCount:0,...patch});
  const provider=new MockWhatsAppProvider();let calls=0;
  const original=provider.sendReminder.bind(provider);provider.sendReminder=async input=>{calls++;return original(input);};
  const engine=new FollowUpEngine({store,provider,clock:()=>at,paymentChecker:checker || (async ({invoice})=>({paidMinor:invoice.paidMinor}))});
  return {store,provider,engine,calls:()=>calls};
}
test('paid invoice stops and never sends',async()=>{const x=setup({paidMinor:1000});assert.equal((await x.engine.run(scope)).reason,'paid');assert.equal(x.calls(),0);assert.equal(x.store.getInvoice(scope).nextFollowUpAt,null);});
test('paused and draft invoices send nothing',async()=>{for(const followupState of ['paused','draft','cancelled']){const x=setup({followupState});await x.engine.run(scope);assert.equal(x.calls(),0);assert.equal(x.store.getInvoice(scope).paidMinor,0);}});
test('real mock and store run complete reminder and persist next cadence',async()=>{const x=setup();assert.equal((await x.engine.run(scope)).status,'sent');assert.equal(x.calls(),1);const invoice=x.store.getInvoice(scope);assert.equal(invoice.reminderCount,1);assert.equal(invoice.nextFollowUpAt,'2026-09-25T09:00:00.000Z');assert.equal([...x.store.messages.values()][0].status,'sent');await x.engine.run(scope);assert.equal(x.calls(),1);});
test('simultaneous workers send only one reminder',async()=>{const x=setup();await Promise.all(Array.from({length:12},()=>x.engine.run(scope)));assert.equal(x.calls(),1);});
test('latest paid state checked after intent persistence',async()=>{let x;x=setup({},async()=>{assert.equal(x.store.messages.size,1);return {paidMinor:1000};});assert.equal((await x.engine.run(scope)).reason,'paid');assert.equal(x.calls(),0);});
test('pause written during accounting refresh wins',async()=>{let x;x=setup({},async()=>{x.store.pauseInvoice(scope);return {paidMinor:0};});assert.equal((await x.engine.run(scope)).reason,'paused');assert.equal(x.calls(),0);});
test('pause during provider request is not overwritten on success',async()=>{const x=setup();x.provider.sendReminder=async()=>{x.store.pauseInvoice(scope);return {status:'accepted',providerMessageId:'accepted-1'};};await x.engine.run(scope);assert.equal(x.store.getInvoice(scope).followupState,'paused');assert.equal(x.store.getInvoice(scope).nextFollowUpAt,null);});
test('uncertain sends and failed payment checks quarantine without retries',async()=>{for(const mode of ['unknown','payment']){const x=setup({},mode==='payment'?async()=>{throw Error('offline');}:undefined);if(mode==='unknown')x.provider.sendReminder=async()=>({status:'unknown'});assert.equal((await x.engine.run(scope)).status,'quarantined');assert.equal((await x.engine.run(scope)).reason,'not_claimed');}});
test('contact hours and weekend midnight scheduling',async()=>{const x=setup({followUpSettings:{hoursStart:'12:00',hoursEnd:'17:00'}});assert.equal((await x.engine.run(scope)).reason,'contact_hours');assert.equal(x.calls(),0);assert.equal(nextContactTime(new Date('2026-09-26T13:00:00Z'),{hoursStart:'00:00',hoursEnd:'18:00'},'UTC').toISOString(),'2026-09-28T00:00:00.000Z');assert.equal(scheduleNextFollowUp(new Date('2026-10-30T14:00:00Z'),{cadenceDays:3},'America/New_York').toISOString(),'2026-11-02T14:00:00.000Z');});
test('customer reply pauses, persists, and escalates; forged sender rejected',async()=>{const x=setup();await assert.rejects(x.engine.processReply({...scope,from:'+919111111111',body:'paid',messageId:'m1'}));assert.equal((await x.engine.processReply({...scope,from:'+919876543210',body:'I paid already',messageId:'m1'})).status,'paused');assert.equal(x.store.getInvoice(scope).paidMinor,0);await x.engine.run(scope);assert.equal(x.calls(),0);assert.ok([...x.store.events.values()].some(e=>e.type==='needs_attention'));});
test('cadence exhaustion escalates without another customer message',async()=>{const x=setup({reminderCount:3});assert.equal((await x.engine.run(scope)).status,'needs_attention');assert.equal(x.calls(),0);});
