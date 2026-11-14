// Independent reviewer specification. All assertions and test bodies preserved; only imports and evidence-file hook adapted.
import test from 'node:test';
import assert from 'node:assert/strict';

import {fixture} from './fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {privateChatTopic} from '../ai/private-chat.mjs';
const evidence=[];
async function setup(){
 const wires=[];let reply='A safe ordinary answer';
 const factory=options=>new AIProvider({...options,cfAccountId:'independent-r5',cfApiToken:'independent-r5',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:reply}}]});}});
 const f=await fixture({providerFactory:factory});let customer,n=0;const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 const turn=async(a,m)=>{const result=a==='owner'?await f.turn(m):await customer({...f.scope,message:m,messageId:'independent-r5-'+(++n)});return result?.answer??result;};
 return {...f,wires,turn,restart,setReply:value=>{reply=value;},terms:async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term)};
}
test('common comma lists are contained without a literal list-noun allowlist',async t=>{
 const f=await setup();try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:1250}]);const terms=await f.terms();assert.ok(terms.includes('number:1250'));
  for(const audience of ['owner','customer'])for(const input of ['Choose between 1250,77,2500','The figures are 1250,77'])await t.test(audience+'/'+input,async()=>{const before=f.wires.length,result=await f.turn(audience,input),row={kind:'numeric-list',audience,terms,input,result,wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row.wires.map(w=>w.body.messages)));});
  for(const audience of ['owner','customer'])for(const input of ['Put 1250,77 on the shopping list','Choose between 77,2500,100'])await t.test('unrelated/'+audience+'/'+input,async()=>{const before=f.wires.length,result=await f.turn(audience,input),row={kind:'numeric-control',audience,terms,input,result,wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,1);assert.equal(row.wires[0].body.messages.at(-1).content,input);});
 }finally{await f.close();}
});
test('a linguistic discussion must not exempt another clause referring to a private party',async t=>{
 const f=await setup();try{
  const c=(await f.db.query("insert into customers(workspace_id,name) values($1,'Anurag Sharma') returning id",[f.scope.workspaceId])).rows[0];await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R5-INDEPENDENT-NAMES',43,'INR','draft')",[f.scope.workspaceId,c.id]);const terms=await f.terms();assert.ok(terms.includes('party:sharma'));
  for(const audience of ['owner','customer'])for(const input of ['Is Sharma coming tomorrow? Explain the etymology of that surname.','Sharma was here yesterday; what is the meaning of this surname?'])await t.test(audience+'/'+input,async()=>{const before=f.wires.length,result=await f.turn(audience,input),row={kind:'linguistic-exemption',audience,terms,input,result,wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row.wires.map(w=>w.body.messages)));});
  for(const audience of ['owner','customer'])for(const [input,expected]of [['Is Sharma coming tomorrow?',0],['Explain the etymology of the surname Sharma',1]])await t.test('control/'+audience+'/'+input,async()=>{const before=f.wires.length,result=await f.turn(audience,input),row={kind:'name-control',audience,input,result,wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,expected);});
 }finally{await f.close();}
});
test('a nested serialized invoice quotation is retained before restart and rejected by the memory guard',async t=>{
 const f=await setup();try{
  for(const [audience,name,amount]of [['owner','Birch Works',6847],['customer','Moss Craft',7936]]){
   const source=JSON.stringify({quote:JSON.stringify({invoice:{customer_name:name,total:amount,due_date:'2027-07-16'}})});
   const before=f.wires.length,first=await f.turn(audience,source);assert.equal(f.wires.length,before,'Original private source must stay local');f.restart();
   const sqlOrigin=(await f.db.query('select app.private_invoice_has_origin($1) ok',[source])).rows[0].ok,terms=await f.terms();
   const rows=await f.db.query(`insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance)
    values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1') returning id,content`,[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience,'nested-origin-'+audience,source]);
   const originRow={kind:'nested-origin-guard',audience,source,first,privateTopic:privateChatTopic(source),sqlOrigin,terms,insertedMemoryRows:rows.rows};evidence.push(originRow);
   await t.test('memory guard/'+audience,()=>assert.equal(rows.rows.length,0,JSON.stringify(originRow)));
   for(const input of ['Ask '+name+' for advice','send '+amount+' today'])await t.test(audience+'/'+input,async()=>{const start=f.wires.length,result=await f.turn(audience,input),row={kind:'nested-origin-followup',audience,source,terms,input,result,wires:f.wires.slice(start)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row.wires.map(w=>w.body.messages)));});
  }
 }finally{await f.close();}
});
test('articles in a linked company name must not taint unrelated ordinary requests or model answers',async t=>{
 const f=await setup();try{
  const input='What is the capital of France?';for(const audience of ['owner','customer']){const before=f.wires.length;await f.turn(audience,input);assert.equal(f.wires.length,before+1,'Before invoice, this is ordinary provider chat');}
  const c=(await f.db.query("insert into customers(workspace_id,name) values($1,'The Cedar Studio') returning id",[f.scope.workspaceId])).rows[0];await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R5-INDEPENDENT-ARTICLE',43,'INR','draft')",[f.scope.workspaceId,c.id]);const terms=await f.terms();f.restart();
  for(const audience of ['owner','customer'])await t.test('ordinary current/'+audience,async()=>{const start=f.wires.length,result=await f.turn(audience,input),row={kind:'party-article-current',audience,terms,input,result,wires:f.wires.slice(start)};evidence.push(row);assert.equal(row.wires.length,1);});
  f.setReply('Birds enjoy the sunshine.');for(const audience of ['owner','customer'])await t.test('ordinary model answer/'+audience,async()=>{const start=f.wires.length,result=await f.turn(audience,'Tell me a joke'),row={kind:'party-article-response',audience,terms,input:'Tell me a joke',modelReply:'Birds enjoy the sunshine.',result,wires:f.wires.slice(start)};evidence.push(row);assert.equal(result,'Birds enjoy the sunshine.');});
 }finally{await f.close();}
});
