import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
import {mergeWhatsAppMessages} from '../conversations-ui.mjs';
import {ownerWhatsAppSettings} from '../owner-whatsapp-ui.mjs';

const scope={workspaceId:'00000000-0000-4000-8000-000000000001',ownerId:'00000000-0000-4000-8000-000000000002',customerId:'owner-placeholder',phone:'+919871367051'};
const invoices=[
 {id:'a',invoiceNumber:'INV-005',clientName:'Green1 Materials LLC',currency:'USD',total:1564,amountPaid:1564,status:'paid',updatedAt:'v1',metadata:{}},
 {id:'b',invoiceNumber:'1223113',clientName:'MineralTree',currency:'USD',total:1725,amountPaid:0,status:'draft',updatedAt:'v1',metadata:{}},
 {id:'c',invoiceNumber:'1001',clientName:'App Revolution',currency:'USD',total:1650,amountPaid:1650,status:'paid',updatedAt:'v1',metadata:{}},
 {id:'d',invoiceNumber:'GST-3425-26',clientName:'Shiv Engineering',currency:'INR',total:4490,amountPaid:0,status:'draft',updatedAt:'v1',metadata:{}},
 {id:'e',invoiceNumber:'INV-20260929-72FCD5',clientName:'facebook.com',currency:'INR',total:50000,amountPaid:0,status:'draft',updatedAt:'v1',metadata:{}}
];
function setup(history=[]){
 let action=null,authorized=true,confirmCalls=0;
 const store={findInvoices:async()=>invoices,latestInvoiceFile:async id=>({file_name:id+'.pdf',mime_type:'application/pdf',bytes:Buffer.from('test')})};
 const pending={loadPendingActionState:async()=>({generation:0,id:null,version:null,action}),
  storePendingAction:async({action:a})=>{action=a;return {id:1,version:1,action:a}},
  loadPendingAction:async()=>action?{id:1,version:1,action}:null,
  consumePendingAction:async()=>{action=null;return {id:1}}};
 const h=createOwnerMessageHandler({supabase:{from(){throw Error('Unexpected database access')},rpc:async(name,args)=>{
   assert.equal(name,'whatsapp_confirm_owner_invoice_action');assert.ok(args.p_confirmation_message_id);confirmCalls++;return {data:{ok:true,invoiceNumber:'1223113',actionType:action?.type||'owner_invoice_update',duplicate:confirmCalls>1}}}},
  authorize:async()=>authorized,invoiceStoreFactory:()=>store,pendingActionStoreFactory:()=>pending,
  readHistory:async()=>history,providerFactory:()=>{throw Error('Deterministic requests must survive AI outage')}});
 return {h,get action(){return action},get confirmCalls(){return confirmCalls},revoke(){authorized=false}};
}
test('owner sees existing dashboard invoices across all five customers without AI',async()=>{
 const {h}=setup();const response=await h({...scope,message:'which invoices do i have logged',messageId:'m1'});
 for(const invoice of invoices){assert.ok(response.includes(invoice.invoiceNumber));assert.ok(response.includes(invoice.clientName))}
});
test('owner targets a numeric invoice and a follow-up refers to that exact invoice',async()=>{
 const {h}=setup([{role:'assistant',content:'Invoice 1223113 — MineralTree\nTotal: USD 1,725.00'}]);
 assert.match(await h({...scope,message:'show invoice 1223113',messageId:'m2'}),/MineralTree/);
 assert.match(await h({...scope,message:'change its amount to 2000 USD',messageId:'m3'}),/1223113.*MineralTree/s);
});
test('owner change is a proposal until explicit confirmation, then uses atomic RPC',async()=>{
 const s=setup();assert.match(await s.h({...scope,message:'change MineralTree amount to 2000 USD',messageId:'m4'}),/Reply yes/);
 assert.equal(s.confirmCalls,0);assert.equal(s.action.invoiceId,'b');assert.equal(s.action.expectedUpdatedAt,'v1');
 assert.match(await s.h({...scope,message:'yes',messageId:'m5'}),/Updated invoice 1223113/);assert.equal(s.confirmCalls,1);
});
test('ambiguous pronouns never select a random invoice; dates must actually exist',async()=>{
 const s=setup();assert.match(await s.h({...scope,message:'change its amount to 2000 USD',messageId:'m6'}),/Which invoice/);
 assert.equal(s.action.type,'owner_invoice_request');assert.equal(s.action.invoiceId,undefined);
 assert.match(await s.h({...scope,message:'change invoice 1223113 due date to 2026-02-30',messageId:'m7'}),/valid date/i);
});
test('owner can propose a payment; revoked binding cannot confirm it',async()=>{
 const s=setup();assert.match(await s.h({...scope,message:'mark invoice 1223113 paid',messageId:'m8'}),/payment.*1,725|1,725.*payment/i);
 assert.equal(s.action.type,'owner_invoice_payment');s.revoke();
 assert.equal(await s.h({...scope,message:'yes',messageId:'m9'}),'');assert.equal(s.confirmCalls,0);
});
test('a list in conversation history is not an unambiguous invoice context',async()=>{
 const s=setup([{role:'assistant',content:invoices.map(i=>i.invoiceNumber).join('\n')}]);
 assert.match(await s.h({...scope,message:'send me its invoice file',messageId:'m10'}),/Which invoice/);
});
test('settings has one simple owner flow, prefilled WhatsApp link, no client attestation or code input',()=>{
 const html=ownerWhatsAppSettings({owner:true,phone:scope.phone,businessName:'CETLD test',verification:{phone:scope.phone,code:'173043',expiresAt:Date.now()+600000}});
 assert.match(html,/Open WhatsApp/);assert.match(html,/LINK%20173043/);
 assert.doesNotMatch(html,/client agreement|name="code"|whatsapp-code|Confirm agreement/);
 assert.match(html,/Send the prefilled message/);
 assert.match(ownerWhatsAppSettings({owner:true,phone:scope.phone,businessName:'CETLD test'}),/Connected/);
});

test('a replacement customer name cannot select a different customer invoice',async()=>{
 const s=setup([{role:'assistant',content:'Invoice 1223113 — MineralTree'}]);
 assert.match(await s.h({...scope,message:'change its customer to Shiv Engineering',messageId:'rename'}),/1223113 — MineralTree/);
 assert.equal(s.action.invoiceId,'b');assert.equal(s.action.changes.clientName,'Shiv Engineering');
});
test('a customer name resumes an ambiguous change without choosing the replacement amount as the target',async()=>{
 const s=setup();await s.h({...scope,message:'change its amount to 2000 USD',messageId:'ambiguous'});
 assert.match(await s.h({...scope,message:'MineralTree',messageId:'select'}),/1223113 — MineralTree/);
 assert.equal(s.action.invoiceId,'b');
});


test('customer file lookup cannot fetch another customer invoice or touch its storage',async()=>{
 let storageReads=0;
 const filters=[];
 const supabase={from(table){assert.equal(table,'invoices');const q={select(){return q},eq(key,value){filters.push([key,value]);return q},limit(){return {data:[]}}};return q},
  storage:{from(){storageReads++;throw Error('Must not read storage')}}};
 const store=createWhatsAppInvoiceStore({supabase,workspaceId:scope.workspaceId,customerId:'customer-one'});
 await assert.rejects(store.latestInvoiceFile('other-invoice'),/invoice scope violation/);
 assert.ok(filters.some(([k,v])=>k==='workspace_id'&&v===scope.workspaceId));
 assert.ok(filters.some(([k,v])=>k==='customer_id'&&v==='customer-one'));
 assert.ok(filters.some(([k,v])=>k==='id'&&v==='other-invoice'));assert.equal(storageReads,0);
});


test('the dashboard verification poll refreshes the connected phone immediately',async()=>{
 const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
 const poll=source.slice(source.indexOf('let ownerVerifyTimer=null;'),source.indexOf("document.addEventListener('submit',async event=>{",source.indexOf('let ownerVerifyTimer=null;')));
 const state={user:{id:'owner'},workspace:{id:'ws'},settings:{whatsapp_owner_phone:null},ownerVerify:{workspaceId:'ws',expiresAt:Date.now()+600000}};
 let tick,renders=0;
 const db={rpc:async()=>({data:'linked'}),from(table){assert.equal(table,'workspace_settings');const q={select(){return q},eq(key,value){assert.equal(key,'workspace_id');assert.equal(value,'ws');return q},single:async()=>({data:{whatsapp_owner_phone:'+919871367051',business_name:'CETLD test'}})};return q}};
 runInNewContext(poll+';startOwnerVerifyPoll();',{state,db,Date,render(){renders++},toast(){},setInterval(fn){tick=fn;return 1},clearInterval(){}});
 await tick();assert.equal(state.settings.whatsapp_owner_phone,'+919871367051');assert.equal(state.ownerVerify,null);assert.equal(renders,1);
});


test('dashboard history uses a stable precise cursor and refresh retains previously loaded pages',async()=>{
 const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function loadWhatsAppMessages('),source.indexOf('function ownerNumberForm()'));
 const stamp='2026-10-02T01:00:00.123456+00:00';
 const state={user:{id:'owner'},workspace:{id:'ws'},settings:{},whatsappHasMore:true,
  whatsappMessages:Array.from({length:125},(_,i)=>({id:String(125-i),created_at:stamp,status:'accepted'}))};
 let request=0,filter;
 const db={from(table){assert.equal(table,'whatsapp_messages');const q={select(){return q},eq(){return q},or(value){filter=value;return q},order(){return q},limit:async()=>({data:++request===1?[]:[{id:'126',created_at:stamp,status:'sent'},{id:'125',created_at:stamp,status:'read'}]})};return q}};
 const context={state,db,Date,mergeWhatsAppMessages};
 await runInNewContext(fn+';loadWhatsAppMessages(true);',context);
 assert.equal(filter,`created_at.lt.${stamp},and(created_at.eq.${stamp},id.lt.1)`);
 assert.equal(state.whatsappMessages.length,125);assert.equal(state.whatsappHasMore,false);
 await runInNewContext(fn+';loadWhatsAppMessages();',context);
 assert.equal(state.whatsappMessages.length,126);assert.equal(state.whatsappMessages.at(-1).id,'1');
 assert.equal(state.whatsappMessages.find(row=>row.id==='125').status,'read');assert.equal(state.whatsappHasMore,false);
});


test('dashboard older messages accept actual UUID message IDs used by the production schema',async()=>{
 const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function loadWhatsAppMessages('),source.indexOf('function ownerNumberForm()'));
 const id='bbaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',stamp='2026-10-02T01:00:00.123456+00:00';
 const state={user:{id:'owner'},workspace:{id:'ws'},settings:{},whatsappHasMore:true,whatsappMessages:[{id,created_at:stamp}]};
 let filter;
 const db={from(){const q={select(){return q},eq(){return q},or(value){filter=value;return q},order(){return q},limit:async()=>({data:[]})};return q}};
 await runInNewContext(fn+';loadWhatsAppMessages(true);',{state,db,Date,mergeWhatsAppMessages});
 assert.equal(filter,`created_at.lt.${stamp},and(created_at.eq.${stamp},id.lt.${id})`);
 assert.equal(state.whatsappMessagesError,'');assert.equal(state.whatsappHasMore,false);
});
