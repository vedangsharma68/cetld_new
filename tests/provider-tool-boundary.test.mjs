import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {normalizeProviderToolCalls,internalToolEnvelope} from '../ai/tool-calls.mjs';
import {createOwnerMessageHandler,standaloneOwnerGreeting} from '../automation/whatsapp/owner-handler.mjs';
import {ownerReplySafetyIssue,runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope,DEFAULT_NOW,JOHN_CUSTOMER_ID} from './fixtures/owner-chat-battery.mjs';
const tools=[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}];
const raw=String.raw`{"name": "workspaceData", "parameters": {"request": "What\'s John Smith\'s phone?", "operation": "read", "table": "customers"}}`;
const logger={info(){},warn(){},error(){}};
const ok=content=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})});

test('known complete provider envelopes normalize without choosing an operation or weakening arguments',()=>{
 for(const content of [raw,'```json\n'+raw+'\n```',JSON.stringify({tool_calls:[{function:{name:'workspaceData',arguments:'{"operation":"read","table":"customers"}'}}]})]){
  const result=normalizeProviderToolCalls({content,toolCalls:[]},{tools});
  assert.equal(result.content,'');assert.equal(result.toolCalls[0].function.name,'workspaceData');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).operation,'read');
 }
 const literal=JSON.stringify({name:'workspaceData',parameters:{request:String.raw`literal \' stays`}});
 assert.equal(JSON.parse(normalizeProviderToolCalls({content:literal},{tools}).toolCalls[0].function.arguments).request,String.raw`literal \' stays`);
 const native=normalizeProviderToolCalls({content:'',toolCalls:[{name:'workspaceData',parameters:{operation:'read',table:'customers'}}]},{tools});
 assert.equal(native.toolCalls[0].function.name,'workspaceData');
 for(const content of [raw,'Example: '+raw,raw.replace('workspaceData','unknownTool'),raw.replace('read','read\\q'),
  JSON.stringify({operation:'read',table:'customers'}),JSON.stringify({name:'workspaceData',parameters:{},extra:'not a call'})]){
  const result=normalizeProviderToolCalls({content,toolCalls:[]},content===raw?{}:{tools});
  assert.equal(result.content,content);assert.equal(result.toolCalls.length,0);
 }
 assert.equal(normalizeProviderToolCalls({content:raw,toolCalls:[]},{tools,tool_choice:'none'}).content,raw);
 assert.equal(internalToolEnvelope(raw),true);assert.equal(ownerReplySafetyIssue(raw),'internal_tool_protocol');
});

test('real Cloudflare adapter handles the exact malformed live envelope through scoped planner, durable receipt and native buttons',async()=>{
 const db=createOwnerChatDatabase(),phone='+919818685252';
 db.tables.customers.find(row=>row.id===JOHN_CUSTOMER_ID).phone=phone;
 const before=structuredClone({customers:db.tables.customers,invoices:db.tables.invoices,payments:db.tables.payments});
 const env={WHATSAPP_APP_SECRET:'isolated-provider-boundary',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:scope.phone,
  WHATSAPP_ACCESS_TOKEN:'isolated-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_GRAPH_API_VERSION:'v24.0'};
 let generations=0;
 const handler=createOwnerMessageHandler({supabase:db.supabase,env,logger,clock:()=>DEFAULT_NOW,authorize:async()=>true,
  providerFactory:()=>new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger,
   fetchImpl:async(_url,init)=>{
    generations++;const wire=JSON.parse(init.body);
    if(generations===1){assert(wire.tools.length);return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message:{content:'',tool_calls:[{id:'invalid-first',type:'function',function:{name:'workspaceData',arguments:'{}'}}]}}]})};}
    if(generations===2){assert(wire.messages.some(row=>row.role==='tool'&&JSON.parse(row.content).code==='INVALID'));return ok(raw);}
    if(generations===3){assert.equal(wire.response_format.type,'json_schema');assert.equal(wire.messages.at(-1).content,"What's John Smith's phone?");
     return ok(JSON.stringify({operation:'read',table:'customers',columns:['name','phone'],filters:[{column:'name',operator:'eq',value:'JohnSmith'}]}));}
    assert(wire.messages.some(row=>row.role==='tool'&&JSON.parse(row.content).rows?.some(record=>record.phone===phone)));
    return ok(`John Smith's phone number is ${phone}.`);
   }})});
 const input={...scope,messageId:'real-adapter-phone',message:"What's John Smith's phone?"};
 const result=await handler(input);assert.equal(result.plannerFailure,undefined);assert.match(result.answer,/\+919818685252/);
 assert.equal(generations,4);assert.deepEqual(result.buttons.map(row=>row.title),['Edit details']);
 const receipt=db.tables.whatsapp_messages.find(row=>row.idempotency_key==='reply:'+input.messageId);
 assert.equal(receipt.body,result.answer);assert.equal(receipt.owner_next_action_ref.choices[0].id,JOHN_CUSTOMER_ID);
 assert.equal((await handler(input)).replayed,true);assert.equal(generations,4);
 let wire;
 const outbound=createWhatsAppOutbound({supabase:db.supabase,env,logger,clock:()=>DEFAULT_NOW,authorizeInboundReply:async()=>({allowed:true}),
  fetchImpl:async(_url,init)=>{wire=JSON.parse(init.body);return {ok:true,json:async()=>({messages:[{id:'wamid.isolated-boundary'}]})}}});
 const sent=await outbound.sendServiceReply({workspaceId:scope.workspaceId,to:scope.phone,body:result.answer,buttons:result.buttons,audience:'owner',
  kind:'normal',businessName:'Northstar Studio',messageId:input.messageId,lastInboundAt:DEFAULT_NOW.toISOString()});
 assert.equal(sent.status,'accepted',JSON.stringify(sent));assert.equal(wire.type,'interactive');assert.equal(wire.interactive.action.buttons[0].reply.id,result.buttons[0].id);
 assert.deepEqual({customers:db.tables.customers,invoices:db.tables.invoices,payments:db.tables.payments},before);db.assertScopedReads();
});

test('protocol text in a tools-off final round is repaired, never executed or returned',async()=>{
 let executions=0,calls=0;
 const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',logger,maxAttempts:1,
  fetchImpl:async(_url,init)=>{calls++;assert.equal(JSON.parse(init.body).tools,undefined);return ok(calls===1?raw:'I could not verify that phone number.');}});
 const result=await runOwnerAgent({provider,message:"What's John's phone?",tools:{definitions:tools,async execute(){executions++;throw Error('No final execution');}},
  checkpoint:{version:1,phase:'final',transcript:[{role:'user',content:"What's John's phone?"}]}});
 assert.equal(executions,0);assert.equal(calls,2);assert.equal(result.answer,'I could not verify that phone number.');assert.equal(result.plannerFailure,undefined);
});

test('standalone greetings are authorized, saved and replayed without model/context calls; mixed requests use the model',async()=>{
 const db=createOwnerChatDatabase();let providers=0,contexts=0,allowed=true;
 const handler=createOwnerMessageHandler({supabase:db.supabase,env:{},logger,clock:()=>DEFAULT_NOW,authorize:async()=>allowed,
  historyReader:async()=>{contexts++;return []},providerFactory:()=>{providers++;return {async generate(){return {content:'How can I help?'}}}}});
 for(const [index,message]of ['Hi','HOW ARE YOU?','What do you do?'].entries()){
  const input={...scope,messageId:'greeting-'+index,message};const result=await handler(input);
  assert(result.answer);assert.equal(result.agentDiagnostics.rounds,0);assert.equal((await handler(input)).replayed,true);
 }
 assert.equal(providers,0);assert.equal(contexts,0);
 allowed=false;assert.equal(await handler({...scope,messageId:'denied-greeting',message:'Hi'}),'');
 allowed=true;
 for(const message of ['Hi, update John’s phone','How are you? Show invoices','What do you do with John’s invoice?','Hi\nDelete invoice'])assert.equal(standaloneOwnerGreeting(message),null);
 const mixed=await handler({...scope,messageId:'mixed-greeting',message:'Hi, what can you help with?'});
 assert.equal(providers,1);assert.equal(contexts,1);assert.equal(mixed.answer,'How can I help?');
});
