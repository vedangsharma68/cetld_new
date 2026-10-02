import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {parseSettingsRequest,unsupportedAnswer} from '../automation/whatsapp/owner-settings.mjs';

const scope={workspaceId:'w1',ownerId:'o1',customerId:'owner-placeholder',phone:'+919871367051'};
function setup({failWrite=null,changeBetween=false}={}){
 let action=null,row={business_name:'CETLD test',follow_up_preferences:{tone:'professional',maxReminders:3},updated_at:'t1'},writes=[],rpcCalls=0,authorized=true,pid=0;
 const supabase={
  rpc:async()=>{rpcCalls++;throw Error('invoice confirm RPC must not see settings')},
  from(table){
   assert.equal(table,'workspace_settings');
   const q={_u:null,select(){return q},eq(){return q},maybeSingle:async()=>({data:row}),
    update(u){q._u=u;return q},
    then(res){
     if(failWrite)return res({error:{message:failWrite,code:'P0001'}});
     if(q._u){ if(changeBetween||row.updated_at!=='t1')return res({data:[]}); writes.push(q._u);row={...row,...q._u,updated_at:'t2'};return res({data:[row]});}
     return res({data:row});
    }};
   return q;
  }};
 const pending={loadPendingActionState:async()=>({generation:0,id:null,version:null,action}),
  storePendingAction:async({action:a})=>{action=a;pid++;return {id:pid,version:1,action:a}},
  loadPendingAction:async()=>action?{id:pid,version:1,action}:null,
  consumePendingAction:async()=>{if(!action)return null;action=null;return {id:pid}}};
 const h=createOwnerMessageHandler({supabase,authorize:async()=>authorized,pendingActionStoreFactory:()=>pending,
  invoiceStoreFactory:()=>({findInvoices:async()=>[]}),readHistory:async()=>[],providerFactory:()=>{throw Error('no AI')},
  clock:()=>new Date('2026-10-02T08:00:00Z'),logger:null});
 return {h,get row(){return row},get writes(){return writes},get rpcCalls(){return rpcCalls},get action(){return action},bump(){row={...row,updated_at:'t9'}},revoke(){authorized=false}};
}
test('parser reads business name, tone, limits and hours; ignores invoice edits',()=>{
 assert.equal(parseSettingsRequest('change my workspace name to Vedang T').businessName,'Vedang T');
 assert.equal(parseSettingsRequest('rename my business to "Acme Ltd"').businessName,'Acme Ltd');
 assert.equal(parseSettingsRequest('set tone to firm').patch.tone,'firm');
 assert.equal(parseSettingsRequest('make reminders gentle').patch.tone,'gentle');
 assert.equal(parseSettingsRequest('set max reminders to 5').patch.maxReminders,5);
 assert.equal(parseSettingsRequest('set max reminders to 50').error?.includes('1 to 20'),true);
 assert.deepEqual(parseSettingsRequest('set contact hours 9am to 6pm').patch,{contactStart:'09:00',contactEnd:'18:00'});
 assert.match(parseSettingsRequest('set contact hours 6pm to 9am').error,/later end/);
 assert.equal(parseSettingsRequest('change invoice 1001 customer to Acme'),null);
 assert.equal(parseSettingsRequest('which invoices do i have'),null);
});
test('owner number, delivery switches and timezone get specific refusals',()=>{
 assert.match(unsupportedAnswer('change my whatsapp number to +9199'),/owner number.*dashboard/i);
 assert.match(unsupportedAnswer('turn on customer messages'),/delivery.*dashboard/i);
 assert.match(unsupportedAnswer('set timezone to Asia/Dubai'),/timezone.*yet/i);
 assert.equal(unsupportedAnswer('change invoice 1001 currency to USD'),null);
});
test('settings change is a proposal, applies only after yes, and keeps other preferences',async()=>{
 const t=setup();
 const proposal=await t.h({...scope,message:'change my workspace name to Vedang T',messageId:'m1'});
 assert.match(proposal,/Business name: CETLD test → Vedang T/);assert.match(proposal,/Reply yes/);
 assert.equal(t.writes.length,0);
 const done=await t.h({...scope,message:'yes',messageId:'m2'});
 assert.match(done,/^Done\./);assert.equal(t.row.business_name,'Vedang T');assert.equal(t.row.follow_up_preferences.maxReminders,3);
 assert.equal(t.rpcCalls,0);
});
test('preferences merge, cancel leaves settings alone, replay does nothing',async()=>{
 const t=setup();
 await t.h({...scope,message:'set tone to firm',messageId:'m1'});
 assert.match(await t.h({...scope,message:'cancel',messageId:'m2'}),/Canceled/);
 assert.equal(t.row.follow_up_preferences.tone,'professional');
 await t.h({...scope,message:'set tone to firm',messageId:'m3'});
 await t.h({...scope,message:'yes',messageId:'m4'});
 assert.equal(t.row.follow_up_preferences.tone,'firm');assert.equal(t.row.follow_up_preferences.maxReminders,3);
 assert.equal(t.writes.length,1);
});
test('dashboard change between ask and yes blocks the write, and a database error is reported plainly',async()=>{
 const stale=setup();
 await stale.h({...scope,message:'set tone to firm',messageId:'m1'});stale.bump();
 assert.match(await stale.h({...scope,message:'yes',messageId:'m2'}),/changed since you asked/);
 assert.equal(stale.writes.length,0);
 const failing=setup({failWrite:'Invalid tone'});
 await failing.h({...scope,message:'set tone to firm',messageId:'m1'});
 assert.match(await failing.h({...scope,message:'yes',messageId:'m2'}),/could not save that: Invalid tone\. Nothing was changed/);
});
test('a revoked owner binding cannot confirm a pending settings change',async()=>{
 const t=setup();
 await t.h({...scope,message:'set tone to firm',messageId:'m1'});t.revoke();
 assert.equal(await t.h({...scope,message:'yes',messageId:'m2'}),'');
 assert.equal(t.writes.length,0);
});
