import test from 'node:test';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
import {fixture} from '../tests/fixtures/private-invoice.mjs';import {AIProvider} from '../ai/provider.mjs';import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';import {createPrivateChatProvider,PRIVATE_CHAT_REPLY} from '../ai/private-chat.mjs';
const evidence=[];test.after(async()=>{await mkdir('work',{recursive:true});await writeFile('work/r6-boundary-regressions.json',JSON.stringify(evidence,null,2));});
test('new ordinary classes stay contained at every production privacy boundary',async t=>{
 const f=await fixture({recording:true});let n=0;
 try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:1250,partyNames:['Van Harper'],dueDate:'2026-10-31'}]);
  for(const [kind,value]of [['enumeration','The amounts are: 1250,77'],['formal-function-word','Ask Van for advice'],['date-separator','31–Oct–2026']])for(const audience of ['owner','customer'])for(const surface of ['history','model-response','tool-arguments','tool-result','memory-write'])await t.test(kind+'/'+audience+'/'+surface,async()=>{
   await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);
   const scope={...f.scope,audience,messageId:'r6-boundary-'+(++n)},memory=createPrivateChatMemory({supabase:f.supabase,scope}),wires=[];let leg=0;
   if(surface==='history')await f.db.query(`insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')`,[scope.workspaceId,audience==='owner'?scope.ownerId:null,audience==='customer'?scope.customerId:null,scope.phone,audience,scope.messageId,value]);
   const tools=[{type:'function',function:{name:'probe',parameters:{type:'object',properties:{detail:{type:'string'}}}}}],p=createPrivateChatProvider({message:'Tell me about gardening',memory,options:{},providerFactory:options=>new AIProvider({...options,cfAccountId:'r6-independent-boundary',cfApiToken:'r6-independent-boundary',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});const message=surface==='model-response'?{content:value}:surface.startsWith('tool-')&&leg++===0?{tool_calls:[{id:'r6-issued',type:'function',function:{name:'probe',arguments:JSON.stringify(surface==='tool-arguments'?{detail:value}:{})}}]}:{content:'An ordinary answer'};return Response.json({choices:[{message}]});}})});p.setTools(tools);
   let result,first;
   if(surface==='memory-write'){await memory.read('Hello');await memory.append('Hello',value);}
   else{result=await p.generate({tools});first=result;if(surface.startsWith('tool-')&&result.toolCalls.length)result=await p.generate({messages:[{role:'assistant',tool_calls:result.toolCalls},{role:'tool',tool_call_id:'r6-issued',name:'probe',content:JSON.stringify(surface==='tool-result'?{detail:value}:{detail:'ordinary'})}],tools});}
   const rows=(await f.db.query('select role,content from whatsapp_provider_memory where source_message_id=$1 order by id',[scope.messageId])).rows;evidence.push({kind,value,audience,surface,first,result,wires,memory:rows});
   if(surface==='model-response')assert.equal(result.content,PRIVATE_CHAT_REPLY);
   else if(surface==='memory-write')assert.ok(!rows.some(r=>r.content===value),JSON.stringify(rows));
   else assert.ok(wires.every(w=>!w.serializedMessages.includes(value)),JSON.stringify(wires));
  });
 }finally{await f.close();}
});
