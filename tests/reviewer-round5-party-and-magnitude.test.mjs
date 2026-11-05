// Independent reviewer specification. All assertions and test bodies preserved; only imports and evidence-file hook adapted.
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';import {AIProvider} from '../ai/provider.mjs';import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';import {privatePartyKeys} from '../ai/private-value-matcher.mjs';
const evidence=[];
async function setup(){const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'r5-party-magnitude',cfApiToken:'r5-party-magnitude',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'A safe ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});let n=0;const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});return {...f,wires,turn:(a,m)=>a==='owner'?f.turn(m):customer({...f.scope,message:m,messageId:'r5-party-magnitude-'+(++n)}),terms:async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term)};}
test('previously reported ordinary large-magnitude amount wording remains contained',async t=>{
 const f=await setup();try{
  for(const [i,amount]of [1250000000000,1000000000000].entries())await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,$3,$4,'INR','draft')",[f.scope.workspaceId,f.scope.customerId,'R5-LARGE-'+i,amount]);const terms=await f.terms();assert.ok(terms.includes('number:1250000000000'));assert.ok(terms.includes('number:1000000000000'));
  for(const audience of ['owner','customer'])for(const input of ['send one point two five trillion today','send one lakh crore today'])await t.test(audience+'/'+input,async()=>{const before=f.wires.length,result=await f.turn(audience,input),row={kind:'ordinary-large-magnitude',audience,terms,input,result,wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row.wires.map(w=>w.body.messages)));});
 }finally{await f.close();}
});
test('formal party components with digits or one native character remain recognized',async t=>{
 const f=await setup();try{
  for(const [i,[name,components]]of [['Green1 Materials LLC',['Green1']],['李 王',['李','王']],['𠀀 王',['𠀀']]].entries()){
   const c=(await f.db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[f.scope.workspaceId,name])).rows[0];await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,$3,43,'INR','draft')",[f.scope.workspaceId,c.id,'R5-COMPONENT-'+i]);const terms=await f.terms();
   for(const audience of ['owner','customer'])for(const part of components)await t.test(audience+'/'+part,async()=>{const input='Ask '+part+' for advice',before=f.wires.length,result=await f.turn(audience,input),row={kind:'formal-component',audience,stored:name,terms,input,result,wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row.wires.map(w=>w.body.messages)));});
  }
 }finally{await f.close();}
});
test('SQL and JavaScript party-key construction agree for supplementary-plane letters',async t=>{
 const f=await setup();try{
  for(const value of ['𠀀 王','𐐀 王','𠀀𠀁 王'])await t.test(value,async()=>{const sql=(await f.db.query('select distinct term from app.private_invoice_party_aliases($1) term',[value])).rows.map(r=>r.term).sort(),js=[...new Set(privatePartyKeys(value))].sort();evidence.push({kind:'supplementary-party-parity',value,sql,js});assert.deepEqual(sql,js);});
 }finally{await f.close();}
});
