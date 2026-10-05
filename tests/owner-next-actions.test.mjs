import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerNextButtons,verifyOwnerNextButton,normalizeOwnerNextActionRef,planOwnerNextActions,runOwnerNextAction,NEXT_ACTION_STALE_REPLY} from '../automation/whatsapp/owner-next-actions.mjs';
import {createOwnerReplyStore} from '../automation/whatsapp/owner-reply-store.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
const workspaceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',phone='+919871367051',ownerId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope={workspaceId,phone,ownerId,messageId:'wamid.test',message:'Show invoice'};
const now=new Date('2026-10-04T10:00:00Z'),clock=()=>now,env={WHATSAPP_APP_SECRET:'isolated-next-actions-secret'};
const invoice={id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',workspace_id:workspaceId,invoice_number:'INV-1',status:'sent',total_amount:100,amount_paid:0,updated_at:now.toISOString(),created_at:now.toISOString(),deleted_at:null,custom_fields:{}};
const customer={id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',workspace_id:workspaceId,name:'John Smith',updated_at:now.toISOString()};
const reference=(choices=[{action:'edit_details',title:'Edit details',table:'invoices',id:invoice.id,updatedAt:invoice.updated_at}])=>({v:1,key:randomUUID(),expiresAt:new Date(now.getTime()+1800000).toISOString(),choices});
function database(overrides={}) {
 const tables={invoices:[structuredClone(invoice)],customers:[structuredClone(customer)],invoice_files:[],whatsapp_messages:[],...overrides},calls=[];
 const db={tables,calls,from(table){let filters=[],take=100,start=0;const call={table,filters:[]};calls.push(call);
 const q={select(){return q},eq(k,v){call.filters.push([k,v]);filters.push(r=>k.includes('->>')?r[k.split('->>')[0]]?.[k.split('->>')[1]]===v:k==='customer.name'?r.customer?.name===v:r[k]===v);return q},is(k,v){filters.push(r=>(r[k]??null)===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},gt(k,v){filters.push(r=>r[k]>v);return q},ilike(k,v){filters.push(r=>String(k==='customer.name'?r.customer?.name:r[k]).toLowerCase().includes(String(v).replaceAll('%','').toLowerCase()));return q},order(){return q},limit(n){take=n;return q},range(a,b){start=a;take=b-a+1;return q},
 upsert(row){if(!tables[table].some(r=>r.workspace_id===row.workspace_id&&r.idempotency_key===row.idempotency_key))tables[table].push(structuredClone(row));return q},
 maybeSingle:async()=>({data:rows()[0]||null}),then(a,b){return Promise.resolve({data:rows()}).then(a,b)}};
 const rows=()=>(tables[table]||[]).filter(r=>filters.every(f=>f(r))).slice(start,start+take);return q},rpc:async()=>({data:{ok:false}})};return db;
}
const stored=(ref,extras={})=>({workspace_id:workspaceId,phone,audience:'owner',direction:'outbound',kind:'normal',status:'accepted',body:'Invoice details',idempotency_key:'reply:original',owner_next_action_ref:ref,...extras});
const mint=ref=>createOwnerNextButtons({scope,reference:ref,env,clock});
const options=db=>({supabase:db,scope,authorize:async()=>true,clock,env});

test('next-action IDs are opaque, scoped, immutable, expiry bound and separate from approval tokens',()=>{
 const ref=reference(),button=mint(ref)[0];
 assert(!button.id.includes(invoice.id));assert(button.id.length<256);assert.equal(verifyOwnerNextButton({id:button.id,scope,reference:ref,env,clock}).action,'edit_details');
 const reordered={choices:ref.choices.map(c=>({id:c.id,title:c.title,updatedAt:c.updatedAt,table:c.table,action:c.action})),expiresAt:ref.expiresAt,key:ref.key,v:1};
 assert.deepEqual(mint(reordered),mint(ref),'JSONB property reordering preserves tokens');
 for(const input of [{scope:{...scope,workspaceId:randomUUID()}},{scope:{...scope,phone:'+12025550123'}},{reference:{...ref,choices:[{...ref.choices[0],id:randomUUID()}]}},{id:button.id.slice(0,-1)+'!'},{id:'oab1.invalid'},{clock:()=>new Date(now.getTime()+1800000)},{env:{}}])assert.equal(verifyOwnerNextButton({id:button.id,scope,reference:ref,env,clock,...input}),null);
});
test('unsupported actions, scope injection, excess/long/duplicate labels cannot become buttons',()=>{
 for(const ref of [reference([{action:'delete_everything',title:'Delete'}]),reference([{...reference().choices[0],workspaceId:randomUUID()}]),reference([{action:'find_invoice',title:'X'.repeat(21)}]),reference(Array(4).fill({action:'find_invoice',title:'Find invoice'})),reference([{action:'find_invoice',title:'Find'},{action:'find_invoice',title:'Find'}])])assert.equal(normalizeOwnerNextActionRef(ref),null);
});
test('verified invoice results offer only supported current actions and file availability',async()=>{
 const db=database(),context={params:{operation:'read',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-1'}]},result:{ok:true,readOnly:true,rows:[{invoice_number:'INV-1'}]}};
 assert.deepEqual((await planOwnerNextActions({...options(db),context})).choices.map(c=>c.title),['Edit details','Record payment']);
 db.tables.invoice_files=[{id:randomUUID(),workspace_id:workspaceId,invoice_id:invoice.id}];
 assert.deepEqual((await planOwnerNextActions({...options(db),context})).choices.map(c=>c.title),['View INV-1','Edit details','Record payment']);
 db.tables.invoices[0].status='paid';db.tables.invoices[0].amount_paid=100;
 assert.deepEqual((await planOwnerNextActions({...options(db),context})).choices.map(c=>c.title),['View INV-1']);
 assert.equal(await planOwnerNextActions({...options(db),context,pending:true}),null);
 assert.equal(await planOwnerNextActions({...options(db),context:{...context,result:{ok:false,code:'DENIED'}}}),null);
 assert(db.calls.filter(c=>['invoices','invoice_files'].includes(c.table)).every(c=>c.filters.some(([k,v])=>k==='workspace_id'&&v===workspaceId)));
});
test('ambiguous customer names become explicit scoped record choices without repeating a write',async()=>{
 const db=database({customers:[customer,{...customer,id:randomUUID(),name:'John Jones'}]});
 const context={params:{operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'John'}],values:{phone:'+12025550123'}},result:{ok:false,code:'AMBIGUOUS'}};
 const ref=await planOwnerNextActions({...options(db),context});
 assert.equal(ref.choices.length,2);assert(ref.choices.every(c=>c.action==='select'));assert(!JSON.stringify(ref).includes('+12025550123'));
 const button=mint(ref)[1];db.tables.whatsapp_messages=[stored(ref)];let request;
 const result=await runOwnerNextAction({...options(db),scope:{...scope,interactionId:button.id},tools:{execute:async(name,args)=>{request=args;return {ok:true,rows:[{name:'John Jones'}]}}}});
 assert.equal(request.operation,'read');assert.equal(request.filters[0].value,ref.choices[1].id);assert.match(result.answer,/John Jones/);
});

test('the linked owner contact never receives an edit shortcut',async()=>{
 const db=database(),context={params:{operation:'read',table:'customers',filters:[{column:'name',operator:'eq',value:'John Smith'}]},result:{ok:true,readOnly:true,rows:[{name:'John Smith'}]}};
 assert.equal(await planOwnerNextActions({...options(db),scope:{...scope,customerId:customer.id},context}),null);
 db.tables.customers[0].metadata={whatsapp_owner:true};
 assert.equal(await planOwnerNextActions({...options(db),context}),null);
 const ref=reference([{action:'edit_details',title:'Edit details',table:'customers',id:customer.id,updatedAt:customer.updated_at}]);db.tables.whatsapp_messages=[stored(ref)];
 assert.equal((await runOwnerNextAction({...options(db),scope:{...scope,interactionId:mint(ref)[0].id},tools:{execute(){throw Error('Protected contact')}}})).answer,NEXT_ACTION_STALE_REPLY);
});
test('ambiguous customer invoice references offer invoice selection, never select another tenant',async()=>{
 const db=database({invoices:[{...invoice,customer:{name:'John Smith'}},{...invoice,id:randomUUID(),invoice_number:'INV-2',customer:{name:'John Smith'}},{...invoice,id:randomUUID(),workspace_id:randomUUID(),invoice_number:'FOREIGN',customer:{name:'John Smith'}}]});
 const ref=await planOwnerNextActions({...options(db),context:{params:{operation:'update',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'John Smith'}]},result:{ok:false,code:'AMBIGUOUS'}}});
 assert.equal(ref.choices.length,2);assert(!JSON.stringify(ref).includes('FOREIGN'));assert(ref.choices.every(c=>c.table==='invoices'));
});
test('edit/payment taps start information gathering and cannot approve or post any change',async()=>{
 const ref=reference([{action:'record_payment',title:'Record payment',table:'invoices',id:invoice.id,updatedAt:invoice.updated_at}]),db=database({whatsapp_messages:[stored(ref)]});let calls=0;
 const input={...options(db),scope:{...scope,interactionId:mint(ref)[0].id},tools:{execute(){calls++;throw Error('No mutation tool allowed')}}};
 assert.match((await runOwnerNextAction(input)).answer,/Nothing has been recorded/);assert.equal(calls,0);assert.equal(db.tables.invoices[0].amount_paid,0);
 assert.match((await runOwnerNextAction({...input,pending:true})).answer,/finish or cancel/);
 db.tables.invoices[0].updated_at='2026-10-04T10:01:00Z';assert.equal((await runOwnerNextAction(input)).answer,NEXT_ACTION_STALE_REPLY);
});
test('Edit details opens a scoped menu; amount choice explains historical payment protection and due date remains editable',async()=>{
 const ref=reference(),db=database({whatsapp_messages:[stored(ref)]});
 const first=await runOwnerNextAction({...options(db),scope:{...scope,interactionId:mint(ref)[0].id},tools:{execute(){throw Error('Menu actions never write directly')}}});
 assert.match(first.answer,/Choose which details to edit/);assert.deepEqual(first.buttons.map(button=>button.title),['Amount','Due date','Other fields']);
 const nested=first.ownerNextActionRef;assert.equal(nested.choices[0].id,invoice.id);assert(nested.choices.every(choice=>choice.table==='invoices'));
 db.tables.whatsapp_messages.push(stored(nested,{idempotency_key:'reply:invoice-edit-menu'}));
 db.tables.payments=[{id:randomUUID(),workspace_id:workspaceId,invoice_id:invoice.id}];
 const amount=await runOwnerNextAction({...options(db),scope:{...scope,interactionId:first.buttons[0].id},tools:{execute(){throw Error('Amount history must block writes')}}});
 assert.match(amount.answer,/payment or reversal history is attached/);
 const due=await runOwnerNextAction({...options(db),scope:{...scope,interactionId:first.buttons[1].id},tools:{execute(){throw Error('Due date tap only asks a question')}}});
 assert.match(due.answer,/new due date/);assert.equal(db.tables.invoices[0].total_amount,100);assert.equal(db.tables.invoices[0].amount_paid,0);
});
test('deleted/foreign records, expired choices, spoofed IDs and revoked bindings never execute a tool',async()=>{
 const ref=reference(),button=mint(ref)[0];
 for(const change of [{invoices:[{...invoice,deleted_at:now.toISOString()}]},{invoices:[{...invoice,workspace_id:randomUUID()}]},{whatsapp_messages:[stored(ref,{workspace_id:randomUUID()})]},{whatsapp_messages:[stored(ref,{phone:'+12025550123'})]}]){
  const db=database({whatsapp_messages:[stored(ref)],...change});const response=await runOwnerNextAction({...options(db),scope:{...scope,interactionId:button.id},tools:{execute(){throw Error('Must not run')}}});assert.equal(response.answer,NEXT_ACTION_STALE_REPLY);
 }
 let auth=0;const db=database({whatsapp_messages:[stored(ref)]});assert.equal((await runOwnerNextAction({...options(db),scope:{...scope,interactionId:button.id},authorize:async()=>++auth<3,tools:{execute(){throw Error('Revoked')}}})).answer,NEXT_ACTION_STALE_REPLY);
 for(const extra of [{clock:()=>new Date(now.getTime()+1800000)},{scope:{...scope,interactionId:button.id.slice(0,-1)+'!'}},{scope:{...scope,interactionId:'ons1.'+randomUUID()+'.0.'+'x'.repeat(43)}}])assert.equal((await runOwnerNextAction({...options(db),scope:{...scope,interactionId:button.id},...extra,tools:{execute(){throw Error('Invalid capability')}}})).answer,NEXT_ACTION_STALE_REPLY);
});
test('durable replies preserve first choices through interruption, canonical save and duplicate webhook replay',async()=>{
 const db=database(),store=createOwnerReplyStore({supabase:db,env,clock}),ref=reference();
 const first=await store.save(scope,{answer:'Current invoice details.',ownerNextActionRef:ref,buttons:mint(ref)});
 assert.deepEqual(first.buttons,mint(ref));assert(!JSON.stringify(db.tables.whatsapp_messages).includes(first.buttons[0].id));
 const retry=await store.save(scope,{answer:'A different draft.',ownerNextActionRef:reference()});assert.equal(retry.answer,first.answer);assert.deepEqual(retry.buttons,first.buttons);
 assert.deepEqual((await store.find(scope)).buttons,first.buttons);
 const expired=await createOwnerReplyStore({supabase:db,env,clock:()=>new Date(now.getTime()+1800000)}).find(scope);assert.equal(expired.answer,first.answer);assert.equal(expired.buttons,undefined);
 assert.equal(await store.find({...scope,messageId:'different-new-turn'}),null);
});
test('same click webhook replays its response without a model call',async()=>{
 const ref=reference(),db=database({whatsapp_messages:[stored(ref)]}),store=createOwnerReplyStore({supabase:db,env,clock});let modelCalls=0;
 const handler=createOwnerMessageHandler({supabase:db,env,clock,authorize:async()=>true,replyStore:store,
  pendingActionStoreFactory:()=>({loadPendingAction:async()=>null,loadPendingActionState:async()=>({generation:0})}),
  lifecycleFactory:()=>({loadPendingDelete:async()=>({ok:true,pending:false})}),historyReader:async()=>[],ownerStoreFactory:()=>({}),
  providerFactory:()=>{modelCalls++;throw Error('A tap must not construct a provider')},logger:{info(){},warn(){},error(){}}});
 const click={...scope,interactionId:mint(ref)[0].id,messageId:'wamid.click',message:'Edit details'};
 const first=await handler(click),retry=await handler(click);assert.match(first.answer,/Choose which details to edit/);assert.deepEqual(first.buttons.map(button=>button.title),['Amount','Due date','Other fields']);assert.equal(retry.answer,first.answer);assert.deepEqual(retry.buttons,first.buttons);assert.equal(retry.replayed,true);assert.equal(modelCalls,0);
});
test('a typed read adds contextual choices without an additional model call; failed receipt save removes them',async()=>{
 for(const failed of [false,true]){
  const db=database();let agentCalls=0,providerCalls=0;
  const handler=createOwnerMessageHandler({supabase:db,env,clock,authorize:async()=>true,
   replyStore:failed?{find:async()=>null,save:async()=>{throw Error('Isolated receipt failure')}}:createOwnerReplyStore({supabase:db,env,clock}),
   pendingActionStoreFactory:()=>({loadPendingAction:async()=>null,loadPendingActionState:async()=>({generation:0})}),
   lifecycleFactory:()=>({loadPendingDelete:async()=>({ok:true,pending:false})}),historyReader:async()=>[],
   ownerStoreFactory:()=>({workspaceId,userId:ownerId,role:'owner',query:async()=>[]}),providerFactory:()=>{providerCalls++;return {}},
   agentFactory:async({tools})=>{agentCalls++;const result=await tools.execute('workspaceData',{operation:'read',table:'invoices',columns:['invoice_number','total_amount','amount_paid','status'],filters:[{column:'invoice_number',operator:'eq',value:'INV-1'}]});assert.equal(result.ok,true);return {answer:'Invoice INV-1 has an outstanding balance of 100.'}},logger:{info(){},warn(){},error(){}}});
  const output=await handler(scope);assert.equal(agentCalls,1);assert.equal(providerCalls,1);assert.match(output.answer,/INV-1/);
  assert.deepEqual(output.buttons?.map(b=>b.title),failed?undefined:['Edit details','Record payment']);
 }
});
test('long replies preserve typed chat without creating invalid interactive bodies',async()=>{
 const db=database(),store=createOwnerReplyStore({supabase:db,env,clock}),ref=reference();
 const result=await store.save(scope,{answer:'x'.repeat(1025),ownerNextActionRef:ref,buttons:mint(ref)});assert.equal(result.buttons,undefined);assert.equal(result.answer.length,1025);
});

test('legacy invoice request cannot suppress persisted John phone choices or safe repeated taps; real and unknown approvals still block',async()=>{
 for(const type of ['owner_invoice_request','owner_workspace_data_change','owner_invoice_payment','invoice_review_draft','future_unknown_action']){
  const pending={id:14,version:1,action:{type},created_at:'2026-10-02T09:33:49Z',consumed_at:null};
  const before=structuredClone(pending),db=database({customers:[{...customer,phone:'+919818685252'}]});
  let agentCalls=0,providerCalls=0;
  db.rpc=async()=>{throw Error('This read and information-gathering tap cannot mutate a pending action or business record')};
  const handler=createOwnerMessageHandler({supabase:db,env,clock,authorize:async()=>true,
   replyStore:createOwnerReplyStore({supabase:db,env,clock}),
   pendingActionStoreFactory:()=>({loadPendingAction:async()=>pending,loadPendingActionState:async()=>({generation:1,id:14,version:1,action:pending.action})}),
   lifecycleFactory:()=>({loadPendingDelete:async()=>({ok:true,pending:false})}),historyReader:async()=>[],
   ownerStoreFactory:()=>({workspaceId,userId:ownerId,role:'owner',query:async()=>[]}),providerFactory:()=>{providerCalls++;return {}},
   agentFactory:async({tools})=>{agentCalls++;const result=await tools.execute('workspaceData',{operation:'read',table:'customers',columns:['phone'],filters:[{column:'name',operator:'eq',value:'John Smith'}]});assert.equal(result.ok,true);return {answer:"John Smith's phone number is +919818685252."}},logger:{info(){},warn(){},error(){}}});
  const output=await handler({...scope,message:'What is John Smith’s phone?'});
  assert.equal(agentCalls,1);assert.equal(providerCalls,1);assert.deepEqual(pending,before);
  if(type!=='owner_invoice_request'){assert.equal(output.buttons,undefined);continue;}
  assert.deepEqual(output.buttons.map(b=>b.title),['Edit details']);
  assert.equal(db.tables.whatsapp_messages[0].owner_next_action_ref.choices[0].id,customer.id);
  const click={...scope,messageId:'wamid.legacy-click',message:'Edit details',interactionId:output.buttons[0].id};
  const first=await handler(click),repeated=await handler(click);
  assert.match(first.answer,/field and new value/);assert.equal(repeated.answer,first.answer);assert.equal(repeated.replayed,true);
  assert.equal(agentCalls,1);assert.equal(providerCalls,1);assert.deepEqual(pending,before);
  assert.equal(db.tables.customers[0].phone,'+919818685252');
 }
});
test('view-file click uses existing scoped tool and restores identical media after interrupted delivery',async()=>{
 const fileId=randomUUID(),media={id:fileId,file_name:'invoice.pdf',mime_type:'application/pdf',bytes:Buffer.from('isolated fixture')};
 const ref=reference([{action:'view_file',title:'View INV-1',table:'invoices',id:invoice.id,updatedAt:invoice.updated_at}]),db=database({whatsapp_messages:[stored(ref)]});
 const output=await runOwnerNextAction({...options(db),scope:{...scope,interactionId:mint(ref)[0].id},tools:{execute:async(name,args)=>{assert.equal(args.operation,'sendFile');assert.equal(args.filters[0].value,invoice.id);return {ok:true,available:true,invoiceNumber:'INV-1'}},getMedia:()=>media}});
 assert.equal(output.media,media);
 const store=createOwnerReplyStore({supabase:db,env,clock,mediaReader:async()=>media});await store.save({...scope,messageId:'file-click'},output);
 assert.equal((await store.find({...scope,messageId:'file-click'})).media.id,fileId);
 db.tables.invoices[0].updated_at='2026-10-04T10:01:00Z';await assert.rejects(store.find({...scope,messageId:'file-click'}),/changed/);
});
test('overview suggestions execute only bounded supported reads through real workspace tools',async()=>{
 const db=database(),ref=await planOwnerNextActions({...options(db),context:{params:{operation:'read',table:'invoices'},result:{ok:true,readOnly:true,rows:[{invoice_number:'INV-1'},{invoice_number:'INV-2'}]}}});
 assert.deepEqual(ref.choices.map(c=>c.title),['Unpaid invoices','Recent invoices','Find invoice']);db.tables.whatsapp_messages=[stored(ref)];
 const tools=createOwnerWorkspaceTools({...options(db),pending:{},botPreferences:{confirmationMode:'buttons'},ownerStore:{workspaceId,userId:ownerId,role:'owner',query:async()=>[]},invoiceStoreFactory:()=>({})});
 const output=await runOwnerNextAction({...options(db),scope:{...scope,interactionId:mint(ref)[0].id},tools});assert.match(output.answer,/INV-1/);assert.equal(db.tables.invoices[0].amount_paid,0);
});

test('next-action migration keeps receipts bounded, owner-only and separate from approval capabilities',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create schema app;create role anon;create role authenticated;create role service_role;
   create table public.whatsapp_messages(id bigint generated always as identity primary key,workspace_id uuid not null,phone text not null,direction text,audience text,kind text,owner_action_ref jsonb);
   alter table public.whatsapp_messages enable row level security;
   grant select on public.whatsapp_messages to authenticated;grant select,insert,update on public.whatsapp_messages to service_role;`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261004094307_owner_next_actions.sql',import.meta.url),'utf8'));
  const ref=reference();const insert=(r,extras={})=>db.query(`insert into public.whatsapp_messages(workspace_id,phone,direction,audience,kind,owner_next_action_ref,owner_action_ref) values($1,$2,$3,$4,$5,$6,$7)`,[workspaceId,phone,extras.direction||'outbound',extras.audience||'owner','normal',r,extras.approval||null]);
  await insert(ref);
  for(const r of [reference([{action:'unsupported',title:'Wrong'}]),reference([{action:'find_invoice',title:'x'.repeat(21)}]),{...reference(),choices:[]},{...reference(),expiresAt:'not a date'},{...reference(),key:null},{...reference(),v:null},{...reference(),expiresAt:'infinity'}])await assert.rejects(insert(r));
  await assert.rejects(db.query(`insert into public.whatsapp_messages(workspace_id,phone,direction,audience,kind,owner_reply_media_ref) values($1,$2,'outbound','owner','normal',$3)`,[workspaceId,phone,{invoiceId:null,fileId:randomUUID(),invoiceUpdatedAt:now.toISOString()}]));
  await assert.rejects(insert(reference(),{direction:'inbound'}));await assert.rejects(insert(reference(),{audience:'customer'}));await assert.rejects(insert(reference(),{approval:{pendingId:1,pendingVersion:1}}));
  await assert.rejects(insert(ref),'duplicate receipt key must not identify two replies');
  await db.exec('set role authenticated');await assert.rejects(insert(reference()),/permission denied/);
 }finally{await db.close();}
});
