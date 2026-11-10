import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
import {setup} from './fixtures/reviewer-round8-harness.mjs';
const evidence=[];test.after(()=>writeFile('work/r8-independent-regressions.json',JSON.stringify(evidence,null,2)));
test('fresh list grammatical frames preserve every stored member and unrelated decimal controls',async t=>{
 const f=await setup();try{await f.retain({total:1250});
for(const audience of ['owner','customer'])for(const [input,privateTurn]of [
 ['Numbers below: 1250,77',true],['Values (INR): 1250,77',true],['1250,77 are the options',true],['Both 1250,77 are due',true],['A list of 1250,77',true],['Either 1250,77',true],['The amounts = 1250,77',true],['Choose one: 1250,77',true],
 ['Numbers below: 2500,77',false],['1250,77 is the decimal price',false],['Put 1250,77 on the shopping list',false],['Try 100, 2500 and 77',false],
 ['send 1¼k today',true],['send 1¼ k today',true],['send 1¼ thousand today',true],['send 1.25k today',true],['send 1½k today',false],['send 2½k today',false],
 ['send सवा हजार today',true],['send डेढ़ हजार today',false],['send ढाई हजार today',false],['send बारह सौ पचास today',true],
 ])await t.test(audience+'/'+input,async()=>{await f.clear();const row={kind:'enumeration',privateTurn,terms:await f.terms(),...await f.turn(audience,input)};evidence.push(row);assert.equal(row.wires.length,privateTurn?0:1,JSON.stringify(row));});
 }finally{await f.close();}
});
test('personal homographs remain protected in noun phrases, objects and finite predicates while vehicles pass',async t=>{
 const f=await setup();try{for(const [stored,cases]of [
 ['An Harper',[['Ask An anything',true],['An loves hiking',true],['An enjoys music',true],['My friend An called me',true],['An is coming tomorrow',true],['An apple is tasty',false],['Ask an expert anything',false]]],
 ['Van Harper',[['The artist Van called me',true],['My friend Van is here',true],['Ask Van anything',true],['Van likes pasta',true],['The van starts smoothly',false],['We use a blue delivery van',false]]],
 ['May Harper',[['May enjoys hiking',true],['My friend May called me',true],['May is coming tomorrow',true],['May I ask a question?',false],['May you explain gardening',false]]],
 ['김민수',[['김민수에게 연락해줘',true],['김민수는 어디에 있나요?',true],['Ask 김민수 for advice',true],['박지훈에게 연락해줘',false]]],
 ['さくら',[['さくらさんに連絡して',true],['Ask さくら for advice',true],['たろうさんに連絡して',false]]],
 ['王',[['请联系王',true],['Ask 王 for advice',true],['讲一个国王的故事',false],['国王的宫殿是什么样？',false],['请联系李',false]]],
 ]){await f.reset();const c=(await f.db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[f.scope.workspaceId,stored])).rows[0];await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,$3,43,'INR','draft')",[f.scope.workspaceId,c.id,'R8-'+stored]);
for(const audience of ['owner','customer'])for(const [input,privateTurn]of cases)await t.test(audience+'/'+stored+'/'+input,async()=>{await f.clear();const row={kind:'party',stored,privateTurn,terms:await f.terms(),...await f.turn(audience,input)};evidence.push(row);assert.equal(row.wires.length,privateTurn?0:1,JSON.stringify(row));});
 }}finally{await f.close();}
});
test('ordinary supplied invoice event paraphrases retain fields through reconstruction',async t=>{
 const f=await setup();try{for(const source of ['I charged Alder Finch 6847','Alder Finch owes me 6847','Payment from Alder Finch: 6847','Received 6847 from Alder Finch','I billed Alder Finch 6847','Invoice: Alder Finch, amount 6847. Due 16 July 2027'])for(const audience of ['owner','customer']){
await f.reset();const row={kind:'source',source,...await f.turn(audience,source)};evidence.push(row);await t.test(audience+'/'+source+'/source',()=>assert.equal(row.wires.length,0,JSON.stringify(row)));
f.restart();for(const input of ['send 6847 today','Ask Alder for advice'])await t.test(audience+'/'+source+'/'+input,async()=>{await f.clear();const row={kind:'followup',source,terms:await f.terms(),...await f.turn(audience,input)};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));});
 }}finally{await f.close();}
});
