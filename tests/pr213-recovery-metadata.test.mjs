import test from 'node:test';import assert from 'node:assert/strict';import {syncInvoiceRow} from '../automation/invoice-sync.mjs';import {invoiceSyncPersistence} from '../automation/invoice-sync-store.mjs';import {signupWithInvite} from '../signup-invite.mjs';
test('credential recovery restores only sync-owned fields and preserves a concurrent reminder approval',async()=>{
 let row={id:'i',workspace_id:'w',customer_id:'c',status:'draft',currency:'INR',total_amount:50,metadata:{invoice_direction:'receivable',approved_reminder_text:'Old review',bookkeeping_sync_status:'failed',bookkeeping_sync_error:'TOKEN_REFRESH_FAILED',bookkeeping_sync_attempts:0,bookkeeping_sync_next_at:'2020-01-01T00:00:00Z'},last_sync_error:'TOKEN_REFRESH_FAILED',sync_status:'failed'};
 const store={workspaceId:'w',userId:'o',getAssistantInvoice:async()=>structuredClone(row),...invoiceSyncPersistence({read:async()=>structuredClone(row),patch:async(_,patch)=>row={...row,...patch}})};
 const result=await syncInvoiceRow({store,row:structuredClone(row),invoice:{direction:'receivable',clientName:'Customer',currency:'INR',total:50},accounting:{syncInvoice(){assert.fail('No provider call')},prepareInvoiceSync:async()=>{
  row={...row,metadata:{...row.metadata,approved_reminder_text:'New approved reminder',approved_reminder_delivery:{body:'New approved reminder'},approved_preferences_updated_at:'2026-11-21T00:00:00Z'}};
  throw Object.assign(Error('Connection missing after refresh'),{code:'ACCOUNTING_NOT_CONNECTED'});
 }}});
 assert.equal(result.sync.status,'failed');assert.equal(result.sync.retryable,true);assert.equal(row.metadata.bookkeeping_sync_error,'TOKEN_REFRESH_FAILED');assert.equal(row.metadata.bookkeeping_sync_attempts,0);assert.equal(row.metadata.bookkeeping_sync_next_at,'2020-01-01T00:00:00Z');assert.equal(row.metadata.approved_reminder_text,'New approved reminder');assert.equal(row.metadata.approved_reminder_delivery.body,'New approved reminder');assert.equal(row.metadata.approved_preferences_updated_at,'2026-11-21T00:00:00Z');
});
test('legacy code input never enters GoTrue, and its in-memory signup response contains no credential',async()=>{
 const code='original-consumable-code';let request;
 const client={rpc:async name=>name==='signup_invite_status'?{data:{version:2,accountInvites:true,tenantInvites:true,identityCredentialScrub:true}}:{data:{ok:true,schemaVersion:2,ticket:'one-use-ticket'}},auth:{signUp:async input=>{
  request=input;return {data:{user:{user_metadata:input.options.data,identities:[{identity_data:{...input.options.data}}]},session:{user:{identities:[{identity_data:{...input.options.data}}]}}},error:null};
 }}};
 const result=await signupWithInvite(client,{email:'invitee@example.test',password:'fixture-password',options:{data:{signup_invite_code:code,full_name:'Kept'}}});
 assert.ok(!JSON.stringify(request).includes(code));assert.equal(request.options.data.signup_invite_ticket,'one-use-ticket');assert.ok(!JSON.stringify(result).includes(code));assert.ok(!JSON.stringify(result).includes('signup_invite_'));assert.equal(result.data.user.user_metadata.full_name,'Kept');assert.equal(result.error,null);
});
