import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {fixture} from './fixtures/private-invoice.mjs';
import {privateOriginKeys,privateOriginStart,privateNumberKeys,privatePartyKeys,createPrivateValueMatcher} from '../ai/private-value-matcher.mjs';

const evidence=[];test.after(()=>writeFile('work/r10-invariant-evidence.json',JSON.stringify(evidence,null,2)));
test('typed source cardinality and rational operands have identical SQL and JS projections',async()=>{
 const f=await fixture({recording:true});try{
  const check=async(kind,input,fn,keys,args=[input])=>{const sql=(await f.db.query('select distinct k from app.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') k order by k',args)).rows.map(x=>x.k),js=[...new Set(keys)].sort();assert.deepEqual(sql,js,input);evidence.push({kind,input,keys:sql});return sql;};
  for(const [whole,denominator,magnitude]of [[1,4,'thousand'],[2,2,'k'],[3,4,'million'],[0,2,'thousand']]){
   const input=`Invoice: amount ${whole} 1/${denominator} ${magnitude}`,keys=await check('rational',input,'private_invoice_origin_aliases',privateOriginKeys(input));
   const amount=(whole+1/denominator)*(magnitude==='million'?1000000:1000),match=createPrivateValueMatcher(keys);assert.equal(match('send '+amount+' today'),true,input);assert.equal(createPrivateValueMatcher(['number:'+(amount+1)])(`send ${whole} 1/${denominator} ${magnitude} today`),false,input);
  }
  for(const input of ['Invoice: amounts 1250,77','Invoice: quoted prices 1250,77','Invoice: amounts 1250,77 respectively']){
   const keys=await check('collection-origin',input,'private_invoice_origin_aliases',privateOriginKeys(input));const match=createPrivateValueMatcher(keys);assert.equal(match('send 1250 today'),true,input);assert.equal(match('send 77 today'),true,input);assert.equal(match('send 1251.77 today'),false,input);
  }
  for(const count of [40,1100]){
   const value='1250,77,'+Array.from({length:count},(_,i)=>String(101+i)).join(','),keys=await check('collection-graph',value,'private_invoice_numeric_candidates',privateNumberKeys(value,true),[value,true]),match=createPrivateValueMatcher(keys);
   for(const amount of [101,100+count])assert.equal(match('send '+amount+' today'),true);assert.equal(match('send 1251.77 today'),false);
   const origin='Invoice: amounts '+value;await check('collection-origin-graph',origin,'private_invoice_origin_aliases',privateOriginKeys(origin));
  }
  for(const separator of [', ','; ','\n',', and '])for(const verb of ['billed','paid','have paid']){
   const input='I '+verb+' Alder Finch 6847'+separator+'Brook Rowan 2749'+separator+'Cedar Marsh 3971',keys=await check('participant-sequence',input,'private_invoice_origin_aliases',privateOriginKeys(input)),match=createPrivateValueMatcher(keys);
   for(const [name,amount]of [['Alder',6847],['Brook',2749],['Cedar',3971]]){assert.equal(match('Ask '+name+' for advice'),true,input);assert.equal(match('send '+amount+' today'),true,input);}
  }
  {const input='I paid Alder Brook Cedar Finch Harbor Marsh Rowan Willow 6847',keys=await check('complete-participant',input,'private_invoice_origin_aliases',privateOriginKeys(input));const match=createPrivateValueMatcher(keys);assert.equal(match('send 6847 today'),true);assert.equal(match('Ask Willow for advice'),true);}
  for(const input of ['I received 3 books from Alder Finch','I paid attention in class','I have paid attention today','I will invoice you later']){assert.equal(privateOriginStart(input),null,input);await check('ordinary-origin-control',input,'private_invoice_origin_aliases',[]);}
 }finally{await f.close();}
});
test('native attachment respects lexical onset and personal morphology in both directions',()=>{
 for(const [name,privateForms,ordinary]of [['김',['김님에게 연락해줘','김씨에게 연락해줘'],['김치가 맛있어요']],['राम',['Ask राम for advice'],['आराम करो','आराम करना जरूरी है']],['李王',['请联系李王'],['请联系王李']],['王',['请联系王'],['国王的宫殿是什么样？']]]){
  const match=createPrivateValueMatcher(privatePartyKeys(name));for(const text of privateForms)assert.equal(match.ordinary(text),true,text);for(const text of ordinary)assert.equal(match.ordinary(text),false,text);
 }
});
