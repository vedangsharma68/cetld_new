import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixture} from '../tests/fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
const evidence=[];
test.after(async()=>{await mkdir('work',{recursive:true});await writeFile('work/r6-long-list.json',JSON.stringify(evidence,null,2));});
async function setup(){
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'independent-r6',cfApiToken:'independent-r6',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});
 let customer,n=0;const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 return {...f,wires,restart,turn:async(a,m)=>{const r=a==='owner'?await f.turn(m):await customer({...f.scope,message:m,messageId:'r6-independent-'+(++n)});return r?.answer??r;},terms:async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term)};
}

test('ordinary unrelated 33-member lists remain usable after an invoice term is retained',async t=>{
 const f=await setup();try{
  const input=n=>'Find the smallest among '+Array.from({length:n},(_,i)=>String(101+i)).join(',');
  for(const audience of ['owner','customer']){const before=f.wires.length;await f.turn(audience,input(33));assert.equal(f.wires.length,before+1,'Unretained list is ordinary before an invoice');}
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:1250}]);f.restart();
  for(const audience of ['owner','customer'])for(const count of [32,33])await t.test(audience+'/'+count,async()=>{const text=input(count),before=f.wires.length,result=await f.turn(audience,text),row={kind:'unrelated-long-list',audience,count,input:text,result,terms:await f.terms(),wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,1,JSON.stringify(row));});
 }finally{await f.close();}
});
