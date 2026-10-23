import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFollowUpPreferences} from '../automation/preferences.mjs';
import {isWithinContactHours, nextContactTime} from '../automation/cadence.mjs';
import {FollowUpEngine} from '../automation/engine.mjs';
import {MemoryAutomationStore} from '../automation/store.mjs';
import {followUpPreferencesForm, normalizedFollowUpPreferences, readFollowUpPreferences, mergeFollowUpPreferences} from '../followup-preferences-ui.mjs';

const zone='Asia/Kolkata',allDays=[0,1,2,3,4,5,6];
const local=(time,date='2026-10-18')=>new Date(`${date}T${time}:00+05:30`);
const scope={ownerId:'owner',workspaceId:'workspace',invoiceId:'invoice'};

async function runAt(time,preferences,extraInvoice={}) {
  const now=local(time),store=new MemoryAutomationStore({now:()=>now});
  store.seedInvoice({id:scope.invoiceId,...scope,amountMinor:1000,paidMinor:0,followupState:'approved',
    nextFollowUpAt:'2026-10-17T00:00:00Z',customerPhone:'+919876543210',reminderCount:0,...extraInvoice});
  store.getWorkspacePreferences=()=>({business_name:'Fixture',follow_up_preferences:preferences,default_timezone:zone,updated_at:'v1'});
  let sends=0;
  const engine=new FollowUpEngine({store,clock:()=>now,paymentChecker:async()=>({paidMinor:0}),
    provider:{async sendReminder(){sends++;return {status:'accepted',providerMessageId:'fixture-only'};}}});
  return {result:await engine.run(scope),sends};
}

test('default is all seven days, 08:00 inclusive to 21:00 exclusive, in Asia/Kolkata',()=>{
  for (const raw of [undefined,null,{}]) {
    const p=normalizeFollowUpPreferences(raw);
    assert.deepEqual(p.weekdays,allDays);assert.equal(p.hoursStart,'08:00');assert.equal(p.hoursEnd,'21:00');assert.equal(p.timezone,zone);
    for(let day=18;day<=24;day++)for(const [time,allowed] of [['07:59',false],['08:00',true],['20:59',true],['21:00',false]])
      assert.equal(isWithinContactHours(local(time,`2026-10-${day}`),p,p.timezone),allowed);
  }
});

test('proof: default Sunday 2026-10-18 12:00 local passes engine contact guard and sends',async()=>{
  const out=await runAt('12:00',undefined);
  assert.equal(out.result.status,'sent');assert.equal(out.sends,1);
});

test('proof: explicit weekdays [1] still blocks Sunday 2026-10-18 12:00 local',async()=>{
  const out=await runAt('12:00',{weekdays:[1]});
  assert.equal(out.result.reason,'contact_hours');assert.equal(out.sends,0);
  assert.equal(nextContactTime(local('12:00'),normalizeFollowUpPreferences({weekdays:[1]}),zone).toISOString(),local('08:00','2026-10-19').toISOString());
});

for(const [time,allowed] of [['10:14',false],['10:15',true],['16:44',true],['16:45',false]])
  test(`custom Sunday+Wednesday 10:15-16:45: engine ${time} ${allowed?'passes':'blocks'}`,async()=>{
    const out=await runAt(time,{allowedWeekdays:[0,3],contactStart:'10:15',contactEnd:'16:45'},{debtor_timezone:'UTC'});
    assert.equal(out.sends,allowed?1:0);
    assert.equal(allowed?out.result.status:out.result.reason,allowed?'sent':'contact_hours');
  });

test('existing explicit days and hours retain their boundaries and weekend restriction',()=>{
  const p=normalizeFollowUpPreferences({allowedWeekdays:[1,2,3,4,5],contactStart:'09:00',contactEnd:'18:00'},zone);
  assert.deepEqual(p.weekdays,[1,2,3,4,5]);assert.equal(p.hoursStart,'09:00');assert.equal(p.hoursEnd,'18:00');
  assert.equal(isWithinContactHours(local('12:00'),p,zone),false);
  for(const [time,allowed] of [['08:59',false],['09:00',true],['17:59',true],['18:00',false]])
    assert.equal(isWithinContactHours(local(time,'2026-10-19'),p,zone),allowed);
});

test('every legacy alias loads in the UI and runtime with canonical precedence',()=>{
  for(const dayKey of ['allowedWeekdays','weekdays'])for(const [start,end] of [['contactStart','contactEnd'],['hoursStart','hoursEnd'],['start_local','end_local']]){
    const raw={[dayKey]:[0,6],[start]:'00:00',[end]:'23:59'},p=normalizeFollowUpPreferences(raw),ui=normalizedFollowUpPreferences(raw);
    assert.deepEqual(p.weekdays,[0,6]);assert.equal(p.hoursStart,'00:00');assert.equal(p.hoursEnd,'23:59');
    assert.deepEqual(ui.allowedWeekdays,[0,6]);assert.equal(ui.contactStart,'00:00');assert.equal(ui.contactEnd,'23:59');
  }
  const p=normalizeFollowUpPreferences({allowedWeekdays:[1],weekdays:[0],contactStart:'09:00',hoursStart:'10:00',start_local:'11:00',contactEnd:'18:00',hoursEnd:'19:00',end_local:'20:00'});
  assert.deepEqual(p.weekdays,[1]);assert.equal(p.hoursStart,'09:00');assert.equal(p.hoursEnd,'18:00');
});

function formPreferences(patch={}) {
  const values={tone:'professional',firstReminderDays:'3',cadenceDays:'3',maxReminders:'3',contactStart:'10:15',contactEnd:'16:45',escalation:'manual_review',weekday:['0','3'],...patch};
  const Original=globalThis.FormData;
  globalThis.FormData=class {get(key){return values[key]??null;}getAll(key){return values[key]??[];}has(key){return key in values;}};
  try{return readFollowUpPreferences({});}finally{globalThis.FormData=Original;}
}

test('UI saves selected days and clock times using canonical keys only, removing stale aliases',()=>{
  const saved=mergeFollowUpPreferences({weekdays:[1],hoursStart:'09:00',hoursEnd:'18:00',start_local:'11:00',end_local:'12:00',other:'keep'},formPreferences());
  assert.deepEqual(saved.allowedWeekdays,[0,3]);assert.equal(saved.contactStart,'10:15');assert.equal(saved.contactEnd,'16:45');assert.equal(saved.other,'keep');
  for(const key of ['weekdays','hoursStart','hoursEnd','start_local','end_local'])assert.equal(key in saved,false);
  const html=followUpPreferencesForm(saved,'America/New_York');
  assert.match(html,/Business timezone: America\/New_York/);assert.match(html,/value="10:15"/);assert.match(html,/value="16:45"/);
  assert.equal((followUpPreferencesForm().match(/name="weekday"[^>]+checked/g)||[]).length,7);
  assert.equal(formPreferences({contactStart:'00:00',contactEnd:'23:59'}).contactStart,'00:00');
});

test('UI rejects overnight, equal and invalid clock times with clear messages',()=>{
  for(const times of [{contactStart:'20:00',contactEnd:'02:00'},{contactStart:'08:00',contactEnd:'08:00'}])
    assert.throws(()=>formPreferences(times),/end must be after contact start.*Overnight windows are not supported/);
  assert.throws(()=>formPreferences({contactEnd:'24:00'}),/between 00:00 and 23:59/);
  assert.throws(()=>formPreferences({weekday:[]}),/at least one weekday/);
});
