import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixture} from '../tests/fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
const evidence=[];
test.after(async()=>{await mkdir('work',{recursive:true});await writeFile('work/r6-date-variants.json',JSON.stringify(evidence,null,2));});
async function setup(){
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'independent-r6',cfApiToken:'independent-r6',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});
 let customer,n=0;const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 return {...f,wires,restart,turn:async(a,m)=>{const r=a==='owner'?await f.turn(m):await customer({...f.scope,message:m,messageId:'r6-independent-'+(++n)});return r?.answer??r;},terms:async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term)};
}

test('ordinary typographic date separators remain known-private date restatements',async t=>{
 const f=await setup();try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{dueDate:'2026-10-31'}]);
  for(const audience of ['owner','customer'])for(const input of ['Is it due 31–Oct–2026?','Is it due 31‑Oct‑2026?','Is it due 31–10–26?','Is it due 2026‑10‑31?','Is it due 31 October 2026?'])await t.test(audience+'/'+input,async()=>{const before=f.wires.length,result=await f.turn(audience,input),row={kind:'date-separator',audience,input,result,terms:await f.terms(),wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row.wires));});
  for(const audience of ['owner','customer'])await t.test('other-year/'+audience,async()=>{const input='Is it due 31–Oct–2027?',before=f.wires.length,result=await f.turn(audience,input);evidence.push({kind:'date-control',audience,input,result,wires:f.wires.slice(before)});assert.equal(f.wires.length,before+1);});
 }finally{await f.close();}
});
