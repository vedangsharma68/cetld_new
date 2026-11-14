import {mkdir} from 'node:fs/promises';
await mkdir('work',{recursive:true});
import assert from 'node:assert/strict';
import {fixture} from './private-invoice.mjs';
import {AIProvider} from '../../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../../automation/whatsapp/assistant-handler.mjs';
export async function setup(){
 const wires=[];let response={content:'An ordinary answer'},sequence=0,customer;
 const factory=options=>new AIProvider({...options,cfAccountId:'independent-round8',cfApiToken:'independent-round8',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:typeof response==='function'?response():response}]});}});
 const f=await fixture({providerFactory:factory});
 const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 const clear=async()=>{await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);restart();};
 const reset=async()=>{for(const table of ['owner_assistant_turns','whatsapp_conversation_turns','whatsapp_provider_memory','whatsapp_private_invoice_terms'])await f.db.query('delete from '+table+' where workspace_id=$1',[f.scope.workspaceId]);restart();};
 const turn=async(audience,input)=>{const n=wires.length;const result=audience==='owner'?await f.turn(input):await customer({...f.scope,message:input,messageId:'r8-independent-'+(++sequence)});return {audience,input,result,wires:wires.slice(n)};};
 return {...f,wires,factory,restart,clear,reset,turn,setResponse:value=>{response=value;},retain:document=>f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,document]),terms:async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(x=>x.term)};
}
