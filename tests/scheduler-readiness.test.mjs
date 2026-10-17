import test from 'node:test';
import assert from 'node:assert/strict';
import {nextContactTime,isWithinContactHours,scheduleInitialFollowUp,scheduleNextFollowUp} from '../automation/cadence.mjs';
import {FollowUpEngine} from '../automation/engine.mjs';
import {MemoryAutomationStore} from '../automation/store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';

const allDays=[0,1,2,3,4,5,6];
const scope={ownerId:'fixture-owner',workspaceId:'fixture-workspace',invoiceId:'fixture-invoice'},now=new Date('2026-10-19T10:00:00Z');
for(const scenario of [
  {zone:'America/New_York',now:'2026-03-08T06:45:00Z',start:'02:30',end:'04:00',expected:'2026-03-08T07:00:00.000Z'},
  {zone:'America/New_York',now:'2026-03-08T06:45:00Z',start:'02:10',end:'02:50',expected:'2026-03-09T06:10:00.000Z'},
  {zone:'Australia/Lord_Howe',now:'2026-10-03T15:20:00Z',start:'02:15',end:'04:00',expected:'2026-10-03T15:30:00.000Z'},
  {zone:'America/New_York',now:'2026-11-01T05:45:00Z',start:'01:30',end:'03:00',expected:'2026-11-01T05:45:00.000Z'},
  {zone:'America/New_York',now:'2026-11-01T06:15:00Z',start:'01:30',end:'03:00',expected:'2026-11-01T06:30:00.000Z'},
  {zone:'America/New_York',now:'2026-11-01T05:45:00Z',start:'01:00',end:'01:30',expected:'2026-11-01T06:00:00.000Z'},
  {zone:'Australia/Lord_Howe',now:'2026-04-04T14:50:00Z',start:'01:30',end:'01:45',expected:'2026-04-04T15:00:00.000Z'},
  {zone:'Asia/Kolkata',now:'2026-10-19T03:29:00Z',start:'09:00',end:'18:00',expected:'2026-10-19T03:30:00.000Z'},
])test(`next contact is not past or outside its window: ${scenario.zone} ${scenario.start}`,()=>{
  const settings={hoursStart:scenario.start,hoursEnd:scenario.end,weekdays:allDays};
  const now=new Date(scenario.now),next=nextContactTime(now,settings,scenario.zone);
  assert.equal(next.toISOString(),scenario.expected);assert.ok(next>=now);
  assert.equal(isWithinContactHours(next,settings,scenario.zone),true);
});

for(const phase of ['payment-check','final-read'])test(`an exception appearing during ${phase} prevents transport`,async()=>{
  const store=new MemoryAutomationStore({now:()=>now});
  store.seedInvoice({id:scope.invoiceId,...scope,amountMinor:10000,paidMinor:4000,followupState:'approved',nextFollowUpAt:'2026-10-19T09:00:00Z',customerPhone:'+919871367051'});
  const hold=()=>{store.invoices.get(scope.invoiceId).metadata={followup_exception:{type:'dispute',note:'Concurrent fixture hold'}};};
  let reads=0,calls=0;const read=store.getInvoice.bind(store);
  store.getInvoice=input=>{if(phase==='final-read'&&++reads===3)hold();return read(input);};
  const engine=new FollowUpEngine({store,clock:()=>now,settings:{businessName:'Fixture'},provider:{async sendReminder(){calls++;}},
    paymentChecker:async()=>{if(phase==='payment-check')hold();return {paidMinor:4000};}});
  assert.equal((await engine.run(scope)).reason,'unresolved_exception');assert.equal(calls,0);
  assert.equal(store.getInvoice(scope).paidMinor,4000);assert.equal(store.getInvoice(scope).amountMinor,10000);
});

test('a resolved report still permits an explicitly approved reminder',async()=>{
  const store=new MemoryAutomationStore({now:()=>now});
  store.seedInvoice({id:scope.invoiceId,...scope,amountMinor:10000,paidMinor:4000,followupState:'approved',
    nextFollowUpAt:'2026-10-19T09:00:00Z',customerPhone:'+919871367051',metadata:{followup_exception:{type:'dispute',resolved_at:now.toISOString()}}});
  let calls=0;const engine=new FollowUpEngine({store,clock:()=>now,settings:{businessName:'Fixture'},
    provider:{async sendReminder(){calls++;return {status:'accepted',providerMessageId:'fixture-only'};}},paymentChecker:async()=>({paidMinor:4000})});
  assert.equal((await engine.run(scope)).status,'sent');assert.equal(calls,1);assert.equal(store.getInvoice(scope).paidMinor,4000);
});

test('initial and subsequent schedules handle nonexistent local starts without scheduling early',()=>{
  const settings={hoursStart:'02:30',hoursEnd:'04:00',weekdays:allDays,firstReminderDays:0,cadenceDays:1};
  assert.equal(scheduleInitialFollowUp({due_date:'2026-03-08',debtor_timezone:'America/New_York'},settings).toISOString(),'2026-03-08T07:00:00.000Z');
  assert.equal(scheduleNextFollowUp(new Date('2026-03-07T08:00:00Z'),settings,'America/New_York').toISOString(),'2026-03-08T07:00:00.000Z');
});

for(const type of ['dispute','paid_claim','stop'])test(`unresolved ${type} independently blocks an active invoice and explicit resume`,async()=>{
  const store=new MemoryAutomationStore({now:()=>now});
  store.seedInvoice({id:scope.invoiceId,...scope,amountMinor:10000,paidMinor:4000,followupState:'approved',
    nextFollowUpAt:'2026-10-19T09:00:00Z',customerPhone:'+919871367051',metadata:{followup_exception:{type,note:'Fixture report',recorded_at:now.toISOString()}}});
  const before=store.getInvoice(scope);let calls=0;
  const provider={async sendReminder(){calls++;return {status:'accepted',providerMessageId:'fixture-only'};}};
  const engine=new FollowUpEngine({store,provider,clock:()=>now,settings:{businessName:'Fixture'},paymentChecker:async()=>({paidMinor:4000})});
  assert.deepEqual(await engine.run(scope),{status:'skipped',reason:'unresolved_exception'});
  const runtime=createAutomationRuntime({store,provider,clock:()=>now,env:{NODE_ENV:'test',WHATSAPP_PROVIDER:'mock',AUTOMATION_OUTBOUND_ENABLED:'true'}});
  await assert.rejects(runtime.resume(scope),/exception/i);
  assert.equal(calls,0);assert.equal(store.claims.size,0);assert.equal(store.messages.size,0);assert.deepEqual(store.getInvoice(scope),before);
});
