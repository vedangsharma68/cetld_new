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
function setup(history=[],{plans={},answers={}}={}){
 let action=null,authorized=true,confirmCalls=0,generation=0,id=0;
 const modelCalls=[],toolOutputs=[];
 const store={findInvoices:async()=>invoices,latestInvoiceFile:async invoiceId=>({file_name:invoiceId+'.pdf',mime_type:'application/pdf',bytes:Buffer.from('test')})};
 const customerIds=new Map();
 const customerIdFor=name=>{if(!customerIds.has(name))customerIds.set(name,`00000000-0000-4000-8000-${String(customerIds.size+1).padStart(12,'0')}`);return customerIds.get(name);};
 const rawInvoices=invoices.map(invoice=>({id:invoice.id,workspace_id:scope.workspaceId,customer_id:customerIdFor(invoice.clientName),invoice_number:invoice.invoiceNumber,
  issue_date:'2026-09-01',due_date:'2026-10-15',currency:invoice.currency,total_amount:String(invoice.total.toFixed(2)),amount_paid:String(invoice.amountPaid.toFixed(2)),
  status:invoice.status,notes:invoice.notes||null,metadata:{invoice_direction:'receivable',printed_invoice_number:invoice.invoiceNumber,client_name:invoice.clientName,
   ...(invoice.metadata?.client_phone?{client_phone:invoice.metadata.client_phone}:{})},created_at:'2026-09-01T00:00:00Z',updated_at:invoice.updatedAt}));
 const ownerStore={async query(table,{filters={},limit=100,offset=0}={}){
  let rows=table==='invoices'?[...rawInvoices]:table==='customers'?[...new Map(rawInvoices.map(row=>[row.customer_id,{id:row.customer_id,workspace_id:scope.workspaceId,
    name:row.metadata.client_name||'Customer',company_name:row.metadata.client_name||null,
    email:null,phone:row.metadata.client_phone||null,created_at:row.created_at,updated_at:row.updated_at}])).values()]:[];
  for(const [key,expression] of Object.entries(filters)){
   if(expression.startsWith('eq.'))rows=rows.filter(row=>String(row[key])===expression.slice(3));
   else if(expression.startsWith('in.(')){const values=expression.slice(4,-1).split(',');rows=rows.filter(row=>values.includes(String(row[key])));}
   else if(expression.startsWith('ilike.')){const wanted=expression.slice(6).replaceAll('%','').replaceAll('*','').toLowerCase();rows=rows.filter(row=>String(row[key]||'').toLowerCase().includes(wanted));}
  }
  return rows.slice(offset,offset+limit);
 }};
 const pending={loadPendingActionState:async()=>({generation,id:action?1:null,version:action?1:null,action}),
  storePendingAction:async({action:a,expectedState})=>{if(expectedState.generation!==generation)return null;action=a;id++;generation++;return {id,version:1,action:a}},
  loadPendingAction:async()=>action?{id,version:1,action}:null,
  consumePendingAction:async()=>{if(!action)return null;const old=id;action=null;generation++;return {id:old}}};
 const supabase={from(table){assert.equal(table,'workspace_ai_settings');const q={select(){return q;},eq(){return q;},async maybeSingle(){return {data:null};}};return q;},
  rpc:async(name,args)=>{if(name==='whatsapp_confirm_owner_invoice_action'){assert.ok(args.p_confirmation_message_id);confirmCalls++;return {data:{ok:true,invoiceNumber:'1223113',actionType:action?.type||'owner_invoice_update',duplicate:confirmCalls>1}};}return {data:{ok:false,code:'FEATURE_UNAVAILABLE'}};}};
 const handler=createOwnerMessageHandler({supabase,authorize:async()=>authorized,invoiceStoreFactory:()=>store,ownerStoreFactory:()=>ownerStore,
  pendingActionStoreFactory:()=>pending,historyReader:async()=>history,logger:{error(){}},providerFactory:options=>({async generate({messages,tools}){
   modelCalls.push(messages);
   assert.ok(tools.length>0,'owner model call must include tools');
   const current=messages.filter(item=>item.role==='user').at(-1)?.content||'';
   const plan=plans[current];const priorTool=messages.some(item=>item.role==='tool');
   if(plan?.tool&&!priorTool)return {model:options.primaryModel,content:'',toolCalls:[{id:`plan-${current.length}`,type:'function',function:{name:plan.tool,arguments:JSON.stringify(plan.args||{})}}]};
   toolOutputs.push(...messages.filter(item=>item.role==='tool').map(item=>item.content));
   return {model:options.primaryModel,content:answers[current]||'I can help with that invoice question.'};
  }})});
 const h=async input=>{const result=await handler(input);return result?.answer??result;};
 return {h,get action(){return action},get confirmCalls(){return confirmCalls},get modelCalls(){return modelCalls},get toolOutputs(){return toolOutputs},revoke(){authorized=false},customerIdFor};
}
test('owner reads existing dashboard invoices through a model-selected scoped tool',async()=>{
 const message='which invoices do i have logged';const s=setup([],{plans:{[message]:{tool:'getInvoices',args:{limit:10}}},answers:{[message]:'I found five invoices across five customers.'}});
 const response=await s.h({...scope,message,messageId:'m1'});
 assert.match(response,/five invoices/);assert.equal(s.modelCalls.length,2);
 for(const invoice of invoices){assert.ok(s.toolOutputs.join('\n').includes(invoice.invoiceNumber));assert.ok(s.toolOutputs.join('\n').includes(invoice.clientName))}
});
test('the model selects one numeric invoice and carries its context into a change proposal',async()=>{
 const s=setup([{role:'assistant',content:'Invoice 1223113, MineralTree, total USD 1,725.00'}],{plans:{
  'show invoice 1223113':{tool:'getInvoiceDetails',args:{target:'1223113'}},
  'change its amount to 2000 USD':{tool:'proposeInvoiceChange',args:{target:'1223113',changes:{total:2000}}}},answers:{
  'show invoice 1223113':'Invoice 1223113 is for MineralTree.',
  'change its amount to 2000 USD':'Proposed changing invoice 1223113 for MineralTree to USD 2,000. Reply yes to apply, or cancel.'}});
 assert.match(await s.h({...scope,message:'show invoice 1223113',messageId:'m2'}),/MineralTree/);
 assert.match(await s.h({...scope,message:'change its amount to 2000 USD',messageId:'m3'}),/1223113.*MineralTree/s);
 assert.equal(s.action.invoiceId,'b');assert.equal(s.action.changes.total,2000);
});
test('owner change is a proposal until explicit confirmation, then uses atomic RPC',async()=>{
 const first='change MineralTree amount to 2000 USD',second='yes';const s=setup([],{plans:{
  [first]:{tool:'proposeInvoiceChange',args:{target:'1223113',changes:{total:2000}}},
  [second]:{tool:'confirmPendingOwnerChange'}},answers:{
  [first]:'Proposed changing invoice 1223113 for MineralTree to USD 2,000. Reply yes to apply, or cancel.',
  [second]:'Updated invoice 1223113 for MineralTree.'}});
 assert.match(await s.h({...scope,message:first,messageId:'m4'}),/Reply yes/);
 assert.equal(s.confirmCalls,0);assert.equal(s.action.invoiceId,'b');assert.equal(s.action.expectedUpdatedAt,'v1');
 assert.match(await s.h({...scope,message:second,messageId:'m5'}),/Updated invoice 1223113/);assert.equal(s.confirmCalls,1);
});
test('ambiguous pronouns never select a random invoice; dates must actually exist',async()=>{
 const ambiguous='change its amount to 2000 USD',invalid='change invoice 1223113 due date to 2026-02-30';const s=setup([],{plans:{
  [invalid]:{tool:'proposeInvoiceChange',args:{target:'1223113',changes:{dueDate:'2026-02-30'}}}},answers:{
  [ambiguous]:'Which invoice should I change?',
  [invalid]:'That date is not valid, so I did not change the invoice.'}});
 assert.match(await s.h({...scope,message:ambiguous,messageId:'m6'}),/Which invoice/);
 assert.equal(s.action,null);
 assert.match(await s.h({...scope,message:invalid,messageId:'m7'}),/date is not valid/i);
 assert.equal(s.action,null);assert.ok(s.toolOutputs.some(value=>value.includes('INVALID')));
});
test('owner can propose a payment; revoked binding cannot confirm it',async()=>{
 const message='mark invoice 1223113 paid';const s=setup([],{plans:{[message]:{tool:'proposeInvoicePayment',args:{target:'1223113'}}},answers:{[message]:'Proposed recording the USD 1,725 payment. Reply yes to confirm, or cancel.'}});
 assert.match(await s.h({...scope,message,messageId:'m8'}),/payment.*1,725|1,725.*payment/i);
 assert.equal(s.action.type,'owner_invoice_payment');s.revoke();
 assert.equal(await s.h({...scope,message:'yes',messageId:'m9'}),'');assert.equal(s.confirmCalls,0);
});
test('a list in conversation history is not an unambiguous invoice context',async()=>{
 const message='send me its invoice file';const s=setup([{role:'assistant',content:invoices.map(i=>i.invoiceNumber).join('\n')}],{answers:{[message]:'Which invoice file should I send?'}});
 assert.match(await s.h({...scope,message,messageId:'m10'}),/Which invoice/);assert.equal(s.modelCalls.length,1);
});
test('settings has one simple owner flow, prefilled WhatsApp link, no client attestation or code input',()=>{
 const html=ownerWhatsAppSettings({owner:true,phone:scope.phone,businessName:'CETLD test',verification:{phone:scope.phone,code:'173043',expiresAt:Date.now()+600000}});
 assert.match(html,/Open WhatsApp/);assert.match(html,/LINK%20173043/);
 assert.doesNotMatch(html,/client agreement|name="code"|whatsapp-code|Confirm agreement/);
 assert.match(html,/Send the prefilled message/);
 assert.match(html,/class="owner-whatsapp-verification"/);
 const connected=ownerWhatsAppSettings({owner:true,phone:scope.phone,businessName:'CETLD test'});
 assert.match(connected,/class="owner-whatsapp-status"[^>]*aria-label="WhatsApp connection status"/);
 assert.match(connected,/class="owner-whatsapp-actions" role="group" aria-label="WhatsApp actions"/);
 assert.match(connected,/data-action="owner-disconnect"/);
 assert.match(connected,/class="owner-whatsapp-change"[^>]*><form id="whatsapp-owner-form" class="settings-fields"/);
 assert.match(connected,/Chat with the bot/);assert.match(connected,/Connect a different number/);
 assert.ok(connected.indexOf('owner-whatsapp-status')<connected.indexOf('owner-whatsapp-actions'));
 assert.ok(connected.indexOf('owner-whatsapp-actions')<connected.indexOf('owner-whatsapp-change'));
 assert.match(ownerWhatsAppSettings({owner:true,phone:scope.phone,businessName:'CETLD test'}),/Connected/);
});

test('the model keeps an explicitly targeted invoice while changing its customer',async()=>{
 const message='change its customer to Shiv Engineering';const s=setup([{role:'assistant',content:'Invoice 1223113, MineralTree'}],{plans:{
  [message]:{tool:'proposeInvoiceChange',args:{target:'1223113',changes:{clientName:'Shiv Engineering'}}}},answers:{
  [message]:'Proposed changing invoice 1223113 customer to Shiv Engineering. Reply yes to apply, or cancel.'}});
 assert.match(await s.h({...scope,message,messageId:'rename'}),/1223113.*Shiv Engineering/);
 assert.equal(s.action.invoiceId,'b');assert.equal(s.action.changes.clientName,'Shiv Engineering');
});
test('the model can resolve a follow-up name from prior context without local keyword routing',async()=>{
 const message='MineralTree';const s=setup([{role:'user',content:'change its amount to 2000 USD'},{role:'assistant',content:'Which invoice do you mean?'}],{plans:{
  [message]:{tool:'proposeInvoiceChange',args:{target:'1223113',changes:{total:2000}}}},answers:{
  [message]:'Proposed changing invoice 1223113 for MineralTree to USD 2,000. Reply yes to apply, or cancel.'}});
 assert.match(await s.h({...scope,message,messageId:'select'}),/1223113.*MineralTree/);
 assert.equal(s.action.invoiceId,'b');
});


test('customer file lookup cannot fetch another customer invoice or touch its storage',async()=>{
 let storageReads=0;
 const filters=[];
 const supabase={from(table){assert.equal(table,'invoices');const q={select(){return q},eq(key,value){filters.push([key,value]);return q},is(key,value){filters.push([key,`is.${value}`]);return q},limit(){return {data:[]}}};return q},
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
test('settings capability questions are answered by the model rather than a route shortcut',async()=>{
 const {h,modelCalls}=setup();
 for(const message of ['update my timezone','change my whatsapp number to +919800000000','turn on customer messages']){
  const reply=await h({...scope,message,messageId:'s'+message.length});
  assert.match(reply,/invoice|WhatsApp|workspace/i);
 }
 assert.equal(modelCalls.length,3);
});
test('customer contact details are read through the model-selected scoped tools',async()=>{
 const list=[{id:'x',invoiceNumber:'INV-2026-0002',printedInvoiceNumber:'US-001',clientName:'John Smith',currency:'USD',total:154.06,amountPaid:0,status:'draft',updatedAt:'v1',metadata:{}},
  {id:'y',invoiceNumber:'INV-2026-0003',clientName:'John Smith',currency:'USD',total:10,amountPaid:0,status:'draft',updatedAt:'v1',metadata:{client_phone:'+919818685252'}},
  {id:'z',invoiceNumber:'1001',clientName:'App Revolution',currency:'CHF',total:5,amountPaid:0,status:'draft',updatedAt:'v1',metadata:{}}];
 const pending={loadPendingActionState:async()=>({generation:0,id:null,version:null,action:null}),loadPendingAction:async()=>null};
 const customerIds=new Map([['John Smith','00000000-0000-4000-8000-000000000001'],['App Revolution','00000000-0000-4000-8000-000000000002']]);
 const ownerStore={async query(table){
  if(table==='invoices')return list.map(i=>({id:i.id,workspace_id:scope.workspaceId,customer_id:customerIds.get(i.clientName),invoice_number:i.invoiceNumber,
   issue_date:'2026-09-01',due_date:'2026-10-01',currency:i.currency,total_amount:String(i.total),amount_paid:String(i.amountPaid),status:i.status,notes:null,
   metadata:{printed_invoice_number:i.printedInvoiceNumber||i.invoiceNumber,invoice_direction:'receivable'},created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z'}));
  if(table==='customers')return list.map(i=>({id:customerIds.get(i.clientName),workspace_id:scope.workspaceId,name:i.clientName,company_name:i.clientName,
   email:null,phone:i.metadata.client_phone||null,created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z'}));
  return [];
 }};
 let modelCalls=0;
 const handler=createOwnerMessageHandler({supabase:{from(table){if(table==='workspace_ai_settings')return {select(){return this},eq(){return this},maybeSingle:async()=>({data:null})};throw Error('unexpected db read')},rpc:async()=>({data:{ok:false,code:'FEATURE_UNAVAILABLE'}})},authorize:async()=>true,
  ownerStoreFactory:()=>ownerStore,invoiceStoreFactory:()=>({findInvoices:async()=>list}),pendingActionStoreFactory:()=>pending,historyReader:async()=>[],
  providerFactory:options=>({async generate({messages,tools}){modelCalls++;assert.ok(tools.length);const hadTool=messages.some(m=>m.role==='tool');
   if(!hadTool)return {model:options.primaryModel,content:'',toolCalls:[{id:'contact-read',type:'function',function:{name:'getInvoices',arguments:'{"limit":10}'}}]};
   return {model:options.primaryModel,content:'John Smith’s saved WhatsApp number is +919818685252.'};}})});
 const h=async input=>{const result=await handler(input);return result?.answer??result;};
 assert.match(await h({...scope,message:'what is johns number?',messageId:'q'}),/\+919818685252/);assert.equal(modelCalls,2);
 assert.doesNotMatch(await h({...scope,message:'show invoice number 1001',messageId:'q2'}),/Contact for/);
});
test('owner questions skip the off-topic keyword filter and reach the model',async()=>{
 const {answerWorkspaceQuestion}=await import('../ai/assistant.mjs');
 let calls=0;const provider={generate:async()=>{calls++;return {toolCalls:[],model:'m'}}};
 await answerWorkspaceQuestion({provider,store:{query:async()=>[]},message:'what is johns number?',ownerMode:true});
 assert.equal(calls,1);
 await answerWorkspaceQuestion({provider,store:{query:async()=>[]},message:'what is johns number?'});
 assert.equal(calls,1);
});
