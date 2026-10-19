import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {businessNameReminderNotice,businessNameReviewNotice} from '../business-name-reminders.mjs';
import {confirmBusinessNameChange,businessNameSavedNotice} from '../followup-preferences-ui.mjs';

test('rename warnings include the count, paused state, and recovery instructions; zero is silent',()=>{
  assert.equal(businessNameReminderNotice(0),'');
  assert.equal(businessNameSavedNotice(0),'');
  assert.equal(businessNameReminderNotice(1),'1 approved reminder will be paused until re-approved in the Conversations tab.');
  assert.equal(businessNameReminderNotice(3,{saved:true}),'3 approved reminders are paused until re-approved in the Conversations tab.');
  assert.match(businessNameSavedNotice(1),/role="status".*1 approved reminder is paused/);
});

for(const count of [0,3])test(`Settings checks the scoped rename count before confirmation (N=${count})`,async()=>{
  const calls=[];
  const client={rpc:async(name,args)=>{
    calls.push({name,args});return {data:{pausedReminderCount:count,updatedAt:'v1'}};
  }};
  const impact=await confirmBusinessNameChange(client,'qa-workspace','QA Old','QA New',text=>{
    assert.equal(calls.length,1);assert.match(text,/3 approved reminders will be paused.*Conversations tab/);
    calls.push('confirmed');return true;
  });
  assert.equal(impact.pausedReminderCount,count);
  assert.equal(calls[0].name,'business_name_change_impact');
  assert.deepEqual(calls[0].args,{p_workspace_id:'qa-workspace',p_business_name:'QA New'});
  assert.equal(calls.length,count?2:1);
});

test('Settings leaves unchanged names alone and cancels a rename before any write',async()=>{
  const fail=()=>assert.fail('unchanged names must not query or confirm');
  assert.equal(await confirmBusinessNameChange({rpc:fail},'qa','QA Old',' QA Old ',fail),null);
  const client={rpc:async()=>({data:{pausedReminderCount:2,updatedAt:'v1'}})};
  assert.equal(await confirmBusinessNameChange(client,'qa','QA Old','QA New',()=>false),false);
  await assert.rejects(confirmBusinessNameChange({rpc:async()=>({error:Error('count unavailable')})},'qa','Old','New',fail),/count unavailable/);
});

test('review notice stays visible until re-approval; Settings and Conversations wire the flow',async()=>{
  const invoice={followup_state:'draft',metadata:{followup_review_reason:'business_name_change'}};
  assert.match(businessNameReviewNotice(invoice),/Needs re-approval after business name change/);
  assert.equal(businessNameReviewNotice({...invoice,followup_state:'approved'}),'');
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const save=app.slice(app.indexOf('async function saveSettings('),app.indexOf('function invoiceForm('));
  assert(save.indexOf('confirmBusinessNameChange(')<save.indexOf("db.rpc('save_business_name_change'"));
  assert(save.indexOf('if(renameImpact===false)return')<save.indexOf("db.rpc('save_business_name_change'"));
  assert.match(app,/businessNameSavedNotice\(state.businessNamePausedReminderCount\)/);
  assert.match(app,/sort\(\(a,b\)=>Number\(Boolean\(businessNameReviewNotice\(b\)\)\)/);
});
