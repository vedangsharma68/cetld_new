// Independent reviewer evidence, copied into the release glob. Assertions unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,png} from './fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {privateFieldKeys} from '../ai/private-value-matcher.mjs';
const evidence=[];
async function setup(){
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'local-review',cfApiToken:'local-review',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'A safe ordinary answer'}}]});}});
 const f=await fixture({providerFactory:factory});let i=0,customer;
 const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};restart();
 const turn=(audience,message)=>audience==='owner'?f.turn(message):customer({...f.scope,message,messageId:'independent-r4-'+(++i)});
 return {...f,ownerTurn:f.turn,wires,turn,restart};
}
test('ordinary stored currency and number-word combinations retain equivalent numeric keys',async t=>{
 const f=await setup();try{
  for(const [stored,amount] of [['twelve fifty rupees','1250'],['Rs 1.25 lakh','125000']]){
   await f.ownerTurn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
   const correction=await f.turn('owner','set notes to '+stored);
   const pending=await f.pending.loadInvoiceReview(f.scope);
   assert.equal(pending.action.invoice.notes,stored);
   await f.turn('owner','cancel');f.restart();
   const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term);
   for(const audience of ['owner','customer'])await t.test(`${stored}/${audience}`,async()=>{
    const input='send '+amount+' today',before=f.wires.length,result=await f.turn(audience,input);
    const row={kind:'currency-number-composition',audience,stored,input,correction,pending,terms,result,wires:f.wires.slice(before)};evidence.push(row);
    assert.equal(row.wires.length,0,'Private restatement reached HTTP: '+JSON.stringify(row.wires.map(w=>w.body.messages)));
   });
  }
 }finally{await f.close();}
});
test('ordinary invoice quotation paraphrases retain fields across restart',async t=>{
 const f=await setup();try{
  for(const [audience,name,amount] of [['owner','Willow Workshop','8654'],['customer','Maple Studio','9685']]){
   const quotation=`This invoice is from ${name}, ${amount}, due 12 Nov`;
   const before=f.wires.length,first=await f.turn(audience,quotation);f.restart();
   const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term);
   const firstWires=f.wires.slice(before);
   for(const input of [`Ask ${name} for advice`,`send ${amount} today`])await t.test(`${audience}/${input}`,async()=>{
    const start=f.wires.length,result=await f.turn(audience,input),row={kind:'quotation-provenance',audience,quotation,first,firstWires,terms,input,result,wires:f.wires.slice(start)};evidence.push(row);
    assert.equal(row.wires.length,0,'Previously supplied invoice field reached HTTP: '+JSON.stringify(row.wires.map(w=>w.body.messages)));
   });
  }
 }finally{await f.close();}
});
test('SQL retention and JavaScript field construction agree on symbol-bearing names',async t=>{
 const f=await setup();try{
  for(const value of ['Acme+','C++','A+ Studio','Acme $ Sons','Acme©'])await t.test(value,async()=>{
   const sql=(await f.db.query('select distinct term from app.private_invoice_term_aliases($1) term order by term',[value])).rows.map(r=>r.term),js=[...privateFieldKeys(value)].sort();
   evidence.push({kind:'key-parity',value,sql,js});assert.deepEqual(sql,js);
  });
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:'C++'}]);
  const before=f.wires.length,result=await f.turn('owner','Explain C'),wires=f.wires.slice(before);
  evidence.push({kind:'symbol-overblock',stored:'C++',input:'Explain C',result,wires});
  await t.test('unrelated programming language C reaches provider',()=>assert.equal(wires.length,1));
 }finally{await f.close();}
});
test('ordinary regional number words and formal given names remain private restatements',async t=>{
 const f=await setup();try{
  const c=(await f.db.query("insert into customers(workspace_id,name) values($1,'Anurag Sharma') returning id",[f.scope.workspaceId])).rows[0];
  await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R4-LANGUAGE',1250,'INR','draft')",[f.scope.workspaceId,c.id]);
  const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term);
  for(const audience of ['owner','customer'])for(const input of ['send बारह सौ पचास today','Ask Anurag for advice','The amounts are 1250,77','send 1¼ thousand today'])await t.test(`${audience}/${input}`,async()=>{
   const before=f.wires.length,result=await f.turn(audience,input),row={kind:'ordinary-language-name',audience,stored:{amount:1250,name:'Anurag Sharma'},input,terms,result,wires:f.wires.slice(before)};evidence.push(row);
   assert.equal(row.wires.length,0,'Ordinary private restatement reached HTTP: '+JSON.stringify(row.wires.map(w=>w.body.messages)));
  });
  for(const audience of ['owner','customer'])for(const input of ['The price is 1250,77','The numbers are 77,2500'])await t.test(`unrelated control/${audience}/${input}`,async()=>{
   const before=f.wires.length,result=await f.turn(audience,input),row={kind:'ordinary-controls',audience,input,result,wires:f.wires.slice(before)};evidence.push(row);assert.equal(row.wires.length,1);assert.equal(row.wires[0].body.messages.at(-1).content,input);
  });
 }finally{await f.close();}
});
