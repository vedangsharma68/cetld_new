import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope,DEFAULT_NOW,JOHN_CUSTOMER_ID} from './fixtures/owner-chat-battery.mjs';
import {CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';

const phone='+919818685252';
const readPhone={operation:'read',table:'customers',columns:['phone'],filters:[{column:'name',operator:'eq',value:'John Smith'}]};
const call=(name,args,id)=>({model:CF_PRIMARY_MODEL,toolCalls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('model question, John phone and repeated John phone cannot let a later config call replace the current business answer',async()=>{
 const db=createOwnerChatDatabase();
 db.tables.customers.find(row=>row.id===JOHN_CUSTOMER_ID).phone=phone;
 db.tables.whatsapp_pending_actions.push({id:14,version:1,...scope,workspace_id:scope.workspaceId,customer_id:scope.customerId,
  created_at:'2026-10-02T09:33:49Z',consumed_at:null,action:{type:'owner_invoice_request'}});
 const before=structuredClone({customers:db.tables.customers,invoices:db.tables.invoices,payments:db.tables.payments,pending:db.tables.whatsapp_pending_actions});
 let turn=0,generations=0,plans=0;const seen=[];
 const handler=createOwnerMessageHandler({supabase:db.supabase,env:{WHATSAPP_APP_SECRET:'isolated-topic-regression'},authorize:async()=>true,
  clock:()=>new Date(DEFAULT_NOW.getTime()+turn*30000),logger:{info(){},warn(){},error(){}},providerFactory:()=>{
   const thisTurn=turn;let round=0;
   return {async generate(request){
    round++;generations++;seen.push({turn:thisTurn,round,request});
    if(thisTurn===0)return round===1?call('getAIProviderConfiguration',{},'model'):{model:CF_PRIMARY_MODEL,content:`Primary: ${CF_PRIMARY_MODEL}.`};
    if(thisTurn===1)return round===1?call('workspaceData',readPhone,'phone-read'):{model:CF_PRIMARY_MODEL,content:`John Smith's phone number is ${phone}.`};
    if(round===1)return call('workspaceData',{},'invalid');
    if(round===2)return call('workspaceData',{request:'Which model are you using?'},'planned-phone-read');
    if(round===3)return call('getAIProviderConfiguration',{},'off-topic-config');
    assert.equal(request.tools,undefined,'after a completed read, off-topic config must lead to a tool-free final answer');
    return {model:CF_PRIMARY_MODEL,content:`John Smith's phone number is ${phone}.`};
   },async generateStructured({messages}){
    plans++;assert.equal(messages.at(-1).role,'user');assert.equal(messages.at(-1).content,"What's John Smith's phone?");
    assert(messages.at(-2).content.includes('Which model are you using?'),'stale model paraphrase must be a hint only');
    return {data:readPhone};
   }};
  }});
 const answers=[];
 for(turn=0;turn<3;turn++){
  const message=turn===0?'Which model are you using?':"What's John Smith's phone?",messageId='topic-turn-'+turn;
  db.tables.whatsapp_messages.push({id:'in-'+turn,workspace_id:scope.workspaceId,phone:scope.phone,audience:'owner',direction:'inbound',
   kind:'text',status:'received',created_at:new Date(DEFAULT_NOW.getTime()+turn*30000).toISOString(),provider_message_id:messageId,body:message});
  const result=await handler({...scope,message,messageId});answers.push(result);
  const beforeReplay=generations;
  assert.equal((await handler({...scope,message,messageId})).answer,result.answer);assert.equal(generations,beforeReplay);
 }
 assert.match(answers[0].answer,/Primary:/);assert.equal(answers[0].buttons,undefined);
 for(const answer of answers.slice(1)){
  assert.match(answer.answer,new RegExp(phone.replace('+','\\+')));assert.doesNotMatch(answer.answer,/Primary:|Fallback:|This turn used/);
  assert.deepEqual(answer.buttons?.map(row=>row.title),['Edit details']);
 }
 const choices=db.tables.whatsapp_messages.filter(row=>row.owner_next_action_ref).map(row=>row.owner_next_action_ref.choices);
 assert.equal(choices.length,2);assert(choices.every(rows=>rows[0].id===JOHN_CUSTOMER_ID));
 assert.equal(plans,1);assert.equal(generations,8);
 for(const item of seen.filter(item=>item.turn===2&&item.round<=3)){
  assert.equal(item.request.messages.at(-1).role,'system');
  assert(item.request.messages.at(-1).content.includes("What's John Smith's phone?"));
 }
 assert.deepEqual({customers:db.tables.customers,invoices:db.tables.invoices,payments:db.tables.payments,pending:db.tables.whatsapp_pending_actions},before);
 db.assertScopedReads();
});

test('configuration capability remains generic, and current-turn anchors guide a business answer after interruption',async()=>{
 let configReads=0,calls=0;
 const staleCall={id:'interrupted-config',type:'function',function:{name:'getAIProviderConfiguration',arguments:'{}'}};
 const result=await runOwnerAgent({message:"What's John Smith's phone?",tools:{definitions:[{type:'function',function:{name:'getAIProviderConfiguration'}}],
  async execute(){configReads++;return {ok:true,readOnly:true,primaryModel:CF_PRIMARY_MODEL}}},checkpoint:{version:1,phase:'work',
   transcript:[{role:'user',content:"What's John Smith's phone?"},{role:'assistant',tool_calls:[staleCall],content:''}],
   pendingToolCalls:[{call:staleCall,name:'getAIProviderConfiguration',args:{}}]},
  provider:{async generate({messages,tools}){
   calls++;assert.equal(tools,undefined);
   assert(messages.some(item=>item.role==='system'&&item.content.includes("What's John Smith's phone?")));
   return {model:CF_PRIMARY_MODEL,content:"I haven't looked up John's phone yet. Please ask again so I can check it."};
  }}});
 assert.equal(configReads,1);assert.equal(calls,1);assert.equal(result.plannerFailure,undefined);
 assert.doesNotMatch(result.answer,/Primary:|Fallback:/);
});
