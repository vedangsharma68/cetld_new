import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOwnerPhone,PHONE_FORMAT_GUIDANCE} from '../automation/whatsapp/owner-phone.mjs';
import {verifyOwnerContactRecovery} from './fixtures/owner-contact-recovery.mjs';
test('owner contact normalization handles India and E.164 without changing sender normalization',()=>{
 for(const value of ['9818685252','98186 85252','+91 98186-85252','+919818685252'])assert.equal(normalizeOwnerPhone(value),'+919818685252');
 assert.equal(normalizeOwnerPhone('+1 202-555-0108'),'+12025550108');
 for(const value of ['12345','1234567890','919818685252','abc+919818685252','++919818685252',''])assert.throws(()=>normalizeOwnerPhone(value),{message:PHONE_FORMAT_GUIDANCE});
});
test('owner contact and business recovery works through native SQL and production handler',verifyOwnerContactRecovery);

test('reminder failure reasons and contact windows survive confirmation errors',async()=>{
 const {ownerReminderFailure,createOwnerReminderRuntime}=await import('../automation/whatsapp/owner-reminders.mjs');
 assert.match(ownerReminderFailure('missing_contact').message,/Send it with the country code, like \+919818685252\./);
 assert.match(ownerReminderFailure('missing_consent').message,/Get their OK, then tell me/);
 assert.match(ownerReminderFailure('business_name_required').message,/tell me the name and I'll store it/);
 assert.equal(ownerReminderFailure('REPLAY_MISMATCH').code,'REPLAY_MISMATCH');
 const query={select(){return this;},eq(){return this;},async maybeSingle(){return {data:{default_timezone:'Asia/Kolkata',follow_up_preferences:{contactStart:'10:00',contactEnd:'17:00',allowedWeekdays:[1,2,3,4,5]}}};}};
 const runtime=createOwnerReminderRuntime({supabase:{from:()=>query,rpc:async()=>({data:{ok:false,code:'contact_hours'}})},scope:{workspaceId:'workspace',ownerId:'owner',phone:'+12025550107'},authorize:async()=>true});
 const result=await runtime.decide({pending:{id:1,version:1,action:{type:'owner_reminder_approval',snapshot:{customer:{name:'John Smith'}}}},decision:'confirm'});
 assert.equal(result.code,'contact_hours');assert.match(result.message,/10:00-17:00 \(Asia\/Kolkata\)/);assert.match(result.message,/Mon, Tue, Wed, Thu, Fri/);
 assert.equal(runtime.getReply(),result.message);
});

test('the owner model receives the live business profile as context data',async()=>{
 const {runOwnerAgent}=await import('../automation/whatsapp/owner-agent.mjs');
 const businessProfile={business_name:'John Studio',owner_email:'owner@example.test',currency:'INR',timezone:'Asia/Kolkata'};
 let inspected=false;
 await runOwnerAgent({message:'Hello',businessProfile,tools:{definitions:[],execute:async()=>({ok:true})},provider:{generate:async({messages})=>{
   const context=JSON.parse(messages.filter(m=>m.role==='system')[1].content);
   assert.deepEqual(context.businessProfile,businessProfile);inspected=true;
   return {content:'Hello.',toolCalls:[]};
 }}});
 assert.equal(inspected,true);
});
