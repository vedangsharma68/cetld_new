import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {planOwnerNextActions} from '../automation/whatsapp/owner-next-actions.mjs';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope,DEFAULT_NOW,JOHN_CUSTOMER_ID} from './fixtures/owner-chat-battery.mjs';
import {CF_PRIMARY_MODEL} from '../ai/provider.mjs';
const clock=()=>DEFAULT_NOW,phone='+919818685252';
const env={WHATSAPP_APP_SECRET:'isolated-unfiltered-actions',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:scope.phone,
 WHATSAPP_ACCESS_TOKEN:'isolated-fake-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_GRAPH_API_VERSION:'v24.0'};
const logger={info(){},warn(){},error(){}};
function fixtures(){
 const db=createOwnerChatDatabase();
 db.tables.customers.find(row=>row.id===JOHN_CUSTOMER_ID).phone=phone;
 for(const name of ['Mary Johnson','Alice Brown','Ava Lee','Bob Jones','Jane Doe'])
  db.tables.customers.push({id:randomUUID(),workspace_id:scope.workspaceId,name,phone:'+12025550123',updated_at:DEFAULT_NOW.toISOString(),metadata:{}});
 db.tables.whatsapp_pending_actions.push({id:14,version:1,workspace_id:scope.workspaceId,customer_id:scope.customerId,phone:scope.phone,
  created_at:'2026-10-02T09:33:49Z',consumed_at:null,action:{type:'owner_invoice_request'}});
 return db;
}
const call=(args,id)=>({model:CF_PRIMARY_MODEL,toolCalls:[{id,type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}]});

test('seven-row unfiltered read persists John choices and reaches native outbound transport; a repeated tap makes no model call or mutation',async()=>{
 const db=fixtures(),before=structuredClone({customers:db.tables.customers,invoices:db.tables.invoices,payments:db.tables.payments,pending:db.tables.whatsapp_pending_actions});
 let generations=0,plans=0,providers=0;
 const handler=createOwnerMessageHandler({supabase:db.supabase,env,clock,logger,authorize:async()=>true,
  providerFactory:()=>{providers++;return {async generate({tools}){
   generations++;
   if(generations===1)return call({},'invalid');
   if(generations<=3)return call({request:generations===2?'Find John Smith phone':'Look up John Smith customer phone'},'all-customers-'+generations);
   assert.equal(tools,undefined);return {model:CF_PRIMARY_MODEL,content:`John Smith’s phone number is ${phone}. 📞`};
  },async generateStructured(){plans++;return {data:{operation:'read',table:'customers',columns:['name','phone']}}}}}
 });
 const messageId='unfiltered-phone',message="What's John Smith's phone?";
 const answer=await handler({...scope,messageId,message});
 assert.deepEqual(answer.buttons?.map(row=>row.title),['Edit details']);assert.equal(generations,4);assert.equal(plans,2);
 const receipt=db.tables.whatsapp_messages.find(row=>row.idempotency_key==='reply:'+messageId);
 assert.equal(receipt.owner_next_action_ref.choices[0].id,JOHN_CUSTOMER_ID);
 assert.equal(db.readCalls.filter(row=>row.table==='customers'&&row.columns.includes('phone')).some(row=>!row.filters.some(filter=>/^name=/.test(filter))),true);
 const requests=[];
 const outbound=createWhatsAppOutbound({supabase:db.supabase,env,clock,logger,authorizeInboundReply:async()=>({allowed:true}),
  fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({messages:[{id:'wamid.mock-native'}]})}}});
 const sent=await outbound.sendServiceReply({workspaceId:scope.workspaceId,to:scope.phone,body:answer.answer,buttons:answer.buttons,
  audience:'owner',kind:'normal',businessName:'Northstar Studio',messageId,lastInboundAt:DEFAULT_NOW.toISOString()});
 assert.equal(sent.status,'accepted');assert.equal(requests.length,1);assert.equal(requests[0].type,'interactive');
 assert.equal(requests[0].interactive.action.buttons[0].reply.title,'Edit details');
 assert.equal(requests[0].interactive.action.buttons[0].reply.id,answer.buttons[0].id);assert.equal(receipt.status,'accepted');
 const click={...scope,messageId:'unfiltered-click',message:'Edit details',interactionId:answer.buttons[0].id};
 const first=await handler(click),repeat=await handler(click);
 assert.match(first.answer,/field and new value/);assert.equal(repeat.answer,first.answer);assert.equal(repeat.replayed,true);
 assert.equal(providers,1);assert.equal(generations,4);
 assert.deepEqual({customers:db.tables.customers,invoices:db.tables.invoices,payments:db.tables.payments,pending:db.tables.whatsapp_pending_actions},before);
 db.assertScopedReads();
});

test('explicit full names and compact names choose only their scoped read record; duplicates require selection',async()=>{
 const db=fixtures(),records=db.tables.customers.filter(row=>row.workspace_id===scope.workspaceId);
 const context={params:{operation:'read',table:'customers'},result:{ok:true,readOnly:true,rows:records.map(row=>({phone:row.phone})),truncated:false},records};
 for(const message of ["What's John Smith's phone?",'Show JohnSmith contact details']){
  const ref=await planOwnerNextActions({supabase:db.supabase,scope:{...scope,message},context,clock,authorize:async()=>true});
  assert.deepEqual(ref.choices.map(row=>row.id),[JOHN_CUSTOMER_ID]);
 }
 const duplicate={...records[0],id:randomUUID(),name:'John Smith'};
 const ref=await planOwnerNextActions({supabase:db.supabase,scope:{...scope,message:'John Smith'},clock,authorize:async()=>true,
  context:{...context,records:[...records,duplicate]}});
 assert.equal(ref.choices.length,2);assert(ref.choices.every(row=>row.action==='select'));
});

test('unfiltered suggestions cannot infer targets from substring, model reply, truncated data or protected owner contacts',async()=>{
 const db=fixtures(),records=db.tables.customers.filter(row=>row.workspace_id===scope.workspaceId);
 const context={params:{operation:'read',table:'customers'},result:{ok:true,readOnly:true,rows:records.map(row=>({phone:row.phone}))},records};
 for(const message of ['List customers','What is his phone?','Read JohnSmithson','Read Mary John'])
  assert.equal(await planOwnerNextActions({supabase:db.supabase,scope:{...scope,message},context,clock,authorize:async()=>true}),null);
 for(const input of [{context:{...context,result:{...context.result,truncated:true}}},{scope:{...scope,message:'Northstar Owner'}},{authorize:async()=>false}])
  assert.equal(await planOwnerNextActions({supabase:db.supabase,scope:{...scope,message:'John Smith'},context,clock,authorize:async()=>true,...input}),null);
});
