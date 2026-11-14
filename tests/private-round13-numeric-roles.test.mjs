import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
import {createPrivateValueMatcher} from '../ai/private-value-matcher.mjs';import {setup} from './fixtures/reviewer-round8-harness.mjs';
const cases=[
 ['I sorted 1250,77 into ascending order',true],['I had carefully sorted 1250,77',true],['Please sort 1250,77',true],['I ranked 1250,77',true],['I arranged 1250,77',true],
 ['I sorted 1250,77 onto a shopping list',true],['Put 1250,77 in ascending order',true],['Place 1250,77 into reverse sequence',true],['1250,77 in that order',true],
 ['I selected 1250,77 for two alternatives',true],['Write 1250,77 as separate entries',true],['I noted 1250,77 as two options',true],['The numbers are 1250,77',true],
 ['Put 1250,77 on the shopping list',false],['Put 1250,77 on a shopping list',false],['Place 1250,77 in the notebook',false],['I placed 1250,77 into two boxes',false],
 ['Put 1250,77 in the numbered list',false],['On the shopping list, put 1250,77',false],['Put on the shopping list 1250,77',false],['The sorted price is 1250,77',false],
 ['The options cost 1250,77',false],['It costs 1250,77',false],['I sorted 2500,77 into ascending order',false],
];
const observations=[];test.after(()=>writeFile('work/r13-numeric-role-evidence.json',JSON.stringify(observations,null,2)));
test('R13 numeric operand cardinality follows predicate valency and complement attachment in both engines',async t=>{
 const f=await setup();try{await f.retain({total:1250});const match=createPrivateValueMatcher(['number:1250']);
 for(const [input,expected]of cases)await t.test(input,async()=>{
  const text=input.toLowerCase(),start=text.indexOf('1250,77')>=0?text.indexOf('1250,77'):text.indexOf('2500,77'),sql=(await f.db.query('select app.private_invoice_number_role($1,$2,$3) role',[text,start+1,start+8])).rows[0].role;
  const actual=match(input);observations.push({surface:'matcher',input,expected,actual,sqlRole:sql});assert.equal(actual,expected,input);
  if(!input.includes('2500,77'))assert.equal(sql===true,expected,JSON.stringify(observations.at(-1)));
 });
 for(const audience of ['owner','customer'])for(const [input,expected]of cases)await t.test(audience+'/'+input,async()=>{
  await f.clear();const row={expected,...await f.turn(audience,input)};observations.push(row);assert.equal(row.wires.length,expected?0:1,JSON.stringify(row));if(!expected)assert.equal(row.wires[0].body.messages.at(-1).content,input);
 });
 }finally{await f.close();}
});
