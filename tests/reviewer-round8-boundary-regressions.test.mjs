import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
import {setup} from './fixtures/reviewer-round8-harness.mjs';import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';import {createPrivateChatProvider,PRIVATE_CHAT_REPLY} from '../ai/private-chat.mjs';
const evidence=[];test.after(()=>writeFile('work/r8-boundary-regressions.json',JSON.stringify(evidence,null,2)));
test('fresh private restatements stay local at every production wrapper boundary',async t=>{
 const f=await setup();let n=0;try{await f.retain({total:1250,partyNames:['An Harper','Van Harper','김민수']});
 for(const value of ['Numbers below: 1250,77','Ask An anything','My friend Van called me','김민수에게 연락해줘','send 1¼k today'])for(const audience of ['owner','customer'])for(const surface of ['history','model-response','tool-arguments','tool-result','memory-write'])await t.test(audience+'/'+surface+'/'+value,async()=>{
 await f.clear();const scope={...f.scope,audience,messageId:'r8-boundary-'+(++n)},memory=createPrivateChatMemory({supabase:f.supabase,scope});
 if(surface==='history')await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')",[scope.workspaceId,audience==='owner'?scope.ownerId:null,audience==='customer'?scope.customerId:null,scope.phone,audience,scope.messageId,value]);
 let leg=0;f.setResponse(()=>surface==='model-response'?{content:value}:surface.startsWith('tool-')&&leg++===0?{tool_calls:[{id:'r8-issued',type:'function',function:{name:'probe',arguments:JSON.stringify(surface==='tool-arguments'?{detail:value}:{})}}]}:{content:'An ordinary answer'});
 const p=createPrivateChatProvider({message:'Explain gardening',memory,options:{},providerFactory:f.factory}),tools=[{type:'function',function:{name:'probe',parameters:{type:'object',properties:{detail:{type:'string'}}}}}];p.setTools(tools);const start=f.wires.length;let result,first;
 if(surface==='memory-write'){await memory.read('Hello');await memory.append('Hello',value);}else{first=result=await p.generate({tools});if(surface.startsWith('tool-')&&result.toolCalls.length)result=await p.generate({messages:[{role:'assistant',tool_calls:result.toolCalls},{role:'tool',tool_call_id:'r8-issued',name:'probe',content:JSON.stringify({detail:surface==='tool-result'?value:'ordinary'})}],tools});}
 const rows=(await f.db.query('select role,content from whatsapp_provider_memory where source_message_id=$1 order by id',[scope.messageId])).rows,row={value,audience,surface,first,result,wires:f.wires.slice(start),rows};
 if(['model-response','memory-write'].includes(surface)){
  f.setResponse({content:'An ordinary answer'});const nextMemory=createPrivateChatMemory({supabase:f.supabase,scope:{...scope,messageId:scope.messageId+'-restart'}}),nextProvider=createPrivateChatProvider({message:'Explain soil',memory:nextMemory,options:{},providerFactory:f.factory}),before=f.wires.length;
  row.replay={result:await nextProvider.generate(),wires:f.wires.slice(before)};
 }
 evidence.push(row);
 if(surface==='model-response')assert.equal(result.content,PRIVATE_CHAT_REPLY,JSON.stringify(row));else if(surface==='memory-write')assert.ok(!rows.some(r=>r.content===value),JSON.stringify(row));else assert.ok(row.wires.every(w=>!w.serializedMessages.includes(value)),JSON.stringify(row));
 });}finally{await f.close();}
});
