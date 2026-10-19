import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {brandedReminder,reminderBody} from '../automation/preferences.mjs';
import {businessNameReminderNotice,businessNameReminderPauseCount,businessNameReviewNotice} from '../followup-preferences-ui.mjs';

for(const count of [0,1,6])test(`shared rename notice before and after saving, N=${count}`,()=>{
 for(const saved of [false,true]){
  const text=businessNameReminderNotice(count,{saved});
  if(!count)assert.equal(text,'');
  else {assert.match(text,new RegExp(`^${count} approved reminder`));assert.match(text,/paused.*re-approve.*Conversations tab/);}
 }
});
test('impact count is workspace scoped, skipped for unchanged names, and fails closed',async()=>{
 const calls=[],client={rpc:async(name,args)=>{calls.push({name,args});return {data:3}}};
 assert.equal(await businessNameReminderPauseCount(client,'w1','Old','Old'),0);
 assert.equal(await businessNameReminderPauseCount(client,'w1','Old',null),0);assert.equal(calls.length,0);
 assert.equal(await businessNameReminderPauseCount(client,'w1','Old','New'),3);
 assert.deepEqual(calls,[{name:'business_name_reminder_pause_count',args:{p_workspace_id:'w1'}}]);
 await assert.rejects(businessNameReminderPauseCount({rpc:async()=>({error:Error('unavailable')})},'w','A','B'),/unavailable/);
});
test('review notice clears on explicit re-approval',()=>{
 const invoice={followup_state:'paused',reminder_review_reason:'business_name_changed'};
 assert.match(businessNameReviewNotice(invoice),/Needs re-approval after business name change/);
 assert.equal(businessNameReviewNotice({...invoice,followup_state:'approved'}),'');
});

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
for(const [nextName,count,confirm,expectedWrites] of [['New',3,false,0],['New',3,true,3],['New',0,true,3],['Old',3,true,3]])
test(`dashboard save ${nextName}, N=${count}, confirm=${confirm}`,async()=>{
 const calls=[],notices=[],errors=[],writes=[];
 const state={demo:false,workspace:{id:'w1'},settings:{business_name:'Old'},user:{id:'o1',email:'qa@example.test'},profile:{},aiSettings:{primary_model:'model',fallback_model:null}};
 const client={rpc:async(name,args)=>{calls.push({name,args});return {data:count}},from(table){const q={upsert(){writes.push(table);return q},update(){writes.push(table);return q},eq(){return q},select(){return q},single:async()=>({data:table==='workspace_settings'?{business_name:nextName}:{}})};return q},auth:{updateUser:async()=>({data:{user:state.user}})}};
 const context={state,db:client,businessNameReminderPauseCount,businessNameReminderNotice,
  window:{confirm:message=>{notices.push(message);assert.equal(writes.length,0);return confirm}},
  FormData:class{get(key){return {full_name:'QA Owner',business_name:nextName,default_currency:'INR',default_timezone:'UTC'}[key]}},
  AI_MODELS:[['model']],AI_FALLBACK_MODELS:[],CURRENCIES:[['INR']],readAIModelPickerValues:()=>({primary_model:'model',fallback_model:null}),
  profileFromUser:()=>({initials:'QA'}),loadData:async()=>{},render(){},toast:message=>notices.push(message),showError:(_form,error)=>errors.push(error)};
 vm.createContext(context);
 vm.runInContext(app.slice(app.indexOf('async function saveSettings('),app.indexOf('\nasync function ',app.indexOf('async function saveSettings(')+1)),context);
 const submit={disabled:false};await context.saveSettings({preventDefault(){},currentTarget:{querySelector:()=>submit}});
 assert.deepEqual(errors,[]);assert.equal(writes.length,expectedWrites);assert.equal(submit.disabled,false);
 if(nextName==='Old'){assert.equal(calls.length,0);assert.ok(notices.every(n=>!n.includes('paused')))}
 else if(count){assert.match(notices[0],/3 approved reminders.*will be paused/);if(confirm)assert.match(state.businessNameReminderNotice,/3 approved reminders are paused.*Conversations tab/)}
 else assert.ok(notices.every(n=>!n.includes('paused')));
});

test('Conversations re-review prepares the new business identity instead of the saved old draft',()=>{
 const context={money:()=> '100.00',remaining:()=>100,day:()=> '19 Oct 2026',state:{settings:{business_name:'QA New Studio',follow_up_preferences:{}}},businessNameReviewNotice,brandedReminder,reminderBody};
 vm.createContext(context);
 vm.runInContext(app.slice(app.indexOf('function reminder(x)'),app.indexOf('\nfunction conversations()')),context);
 const draft=context.reminder({followup_state:'paused',reminder_review_reason:'business_name_changed',number:'QA-1',client:'QA Customer',reminder_text:'Hi, this is QA Old Studio. Invoice QA-1 has an update.\n\nQA Old Studio'});
 assert.match(draft,/QA New Studio/);assert.doesNotMatch(draft,/QA Old Studio/);
});
