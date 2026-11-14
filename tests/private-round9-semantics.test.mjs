import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fixture} from './fixtures/private-invoice.mjs';
import {createPrivateValueMatcher,privateNumberKeys,privateOriginKeys,privateOriginStart,privateFieldKeys,privatePartyKeys} from '../ai/private-value-matcher.mjs';
import {invoiceReadQuestion} from '../automation/whatsapp/private-invoice-read.mjs';
import {privateChatTopic} from '../ai/private-chat.mjs';
import {retainReceivablesResult} from '../invoice/receivables.mjs';

test('whole-clause number roles survive arbitrary nominal modifiers and preserve scalar agreement',()=>{
 const match=createPrivateValueMatcher(['number:1250']);
 for(const adjective of ['','red ','quoted ','previously quoted ','unusual green '])for(const noun of ['prices','numbers','options','measurements'])for(const frame of [label=>`The ${label} below (INR): 1250,77`,label=>`1250,77 are the ${label}`,label=>`Both ${label} below include 1250,77`]){
  const input=frame(adjective+noun);assert.equal(match(input),true,input);assert.equal(match(input.replace('1250','2500')),false,input);
 }
 for(const input of ['The price comes to 1250,77','It costs 1250,77','Put 1250,77 on the shopping list','1250,77 is the decimal price','The price shown below is 1250,77'])assert.equal(match(input),false,input);
 const probe=spawnSync(process.execPath,['--input-type=module','-e',`import {createPrivateValueMatcher,privatePartyKeys} from './ai/private-value-matcher.mjs';const match=createPrivateValueMatcher(['number:1250',...privatePartyKeys('An Harper')]);for(let i=0;i<1000;i++){match('Numbers below: 1250,77');match.ordinary('My friend An enjoys hiking');}console.log(JSON.stringify({peakRssKiB:process.resourceUsage().maxRSS}));`],{encoding:'utf8',env:{PATH:process.env.PATH,TMPDIR:'/tmp'}});
 const generated=spawnSync(process.execPath,['scripts/generate-private-language-model.mjs','--check'],{encoding:'utf8',env:{PATH:process.env.PATH,TMPDIR:'/tmp'}});assert.equal(generated.status,0,generated.stderr);
 assert.equal(probe.status,0,probe.stderr);assert.ok(JSON.parse(probe.stdout).peakRssKiB<=100*1024,probe.stdout);

});

test('registered homographs use nominal roles across unrestricted objects, predicates and appositions',()=>{
 for(const name of ['An','Van','May','Will']){
  const match=createPrivateValueMatcher(privatePartyKeys(name+' Harper'));
  for(const input of [`Ask ${name} anything`,`My neighbour ${name} enjoys pottery`,`${name} studies botany`,`${name}'s unusual proposal worked`,`I consulted ${name} yesterday`,`Ask ${name.toLowerCase()} for guidance`])assert.equal(match.ordinary(input),true,input);
 }
 const match=createPrivateValueMatcher(['An Harper','Van Harper','May Harper'].flatMap(privatePartyKeys));
 for(const input of ['An old red apple','An updated report','Ask an expert anything','We travel by van','We use a blue delivery van','The van starts smoothly','May I ask a question?','May you explain botany','Van Gogh painted flowers'])assert.equal(match.ordinary(input),false,input);
 const lexical=createPrivateValueMatcher(['New Harper','Draft Harper','Rose Harper'].flatMap(privatePartyKeys));
 for(const name of ['New','Draft','Rose'])for(const input of [`Ask ${name} for advice`,`${name} called me`,`The artist ${name} is here`])assert.equal(lexical.ordinary(input),true,input);
 for(const input of ['New features are useful','Draft a bedtime story','A rose is red'])assert.equal(lexical.ordinary(input),false,input);
 const inferred=createPrivateValueMatcher(privateOriginKeys('I will invoice the new creative team soon'));
 for(const input of ['Tell me about the new creative team soon','New features are useful'])assert.equal(inferred.ordinary(input),false,input);
});

test('registered native names use grapheme identity and lexical boundaries without script branches',()=>{
 for(const [name,privateText,other] of [['김민수','김민수에게 연락해줘','박지훈에게 연락해줘'],['さくら','さくらさんに連絡して','たろうさんに連絡して'],['李王','请联系李王','请联系王李'],['محمد','اتصل بمحمد','اتصل بعلي']]){
  const match=createPrivateValueMatcher(privatePartyKeys(name));for(const input of [`The artist ${name} called me`,`My friend ${name} is here`])assert.equal(match.ordinary(input),true,input);assert.equal(match.ordinary(privateText),true,privateText);assert.equal(match.ordinary(other),false,other);
 }
 const one=createPrivateValueMatcher(privatePartyKeys('王'));for(const value of ['请联系王','Ask 王 for advice'])assert.equal(one.ordinary(value),true);for(const value of ['讲一个国王的故事','国王的宫殿是什么样？'])assert.equal(one.ordinary(value),false);
});

test('fractional operators compose with all magnitude spellings and native cardinal operands',()=>{
 for(const [value,forms] of [[1250,['1¼k','1¼ k','1¼ thousand','सवा हजार']],[2250,['सवा दो हजार']],[1500,['1½k','डेढ़ हजार','साढ़े हजार']],[2500,['2½k','ढाई हजार']],[750,['पौने हजार']],[1250000,['1¼m','सवा million']],[1.5,['डेढ़']],[2.5,['ढाई']],[1.25,['सवा']]]){
  const match=createPrivateValueMatcher(['number:'+value]);for(const form of forms){assert.equal(match('send '+form+' today'),true,form);assert.equal(createPrivateValueMatcher(['number:'+(value+1)])('send '+form+' today'),false,form);}
 }
});

test('every event and coordinated argument has matching SQL/JS provenance, irrespective of watermark size',async()=>{
 const f=await fixture({recording:true});try{
  for(const count of [2,4,12])for(const separator of ['. ','; ','\n',', and ']){
   const entries=Array.from({length:count},(_,i)=>({party:`Harbor${String.fromCharCode(65+i)} Rowan${String.fromCharCode(65+i)}`,amount:6001+i}));
   const source=separator===', and '?'I billed '+entries.map(x=>`${x.party} ${x.amount}`).join(separator):entries.map(x=>`I billed ${x.party} ${x.amount}`).join(separator);
   const js=[...new Set(privateOriginKeys(source))].sort(),sql=(await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k);assert.deepEqual(sql,js,source);
   const match=createPrivateValueMatcher(sql);for(const entry of entries){assert.equal(match(`send ${entry.amount} today`),true);assert.equal(match('Ask '+entry.party.split(' ')[0]+' for guidance'),true,source);}
  }
  const stem='I billed Alder Finch 6847, and Brook Rowan 2749. Notes: ';
  for(const length of [3992,3993,3994,3997,4000,4001,8000]){
   const source=(stem+'design work '.repeat(1000)).slice(0,length-1)+'x';
   const js=[...new Set(privateOriginKeys(source))].sort(),sql=(await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k);assert.deepEqual(sql,js,String(length));
   const match=createPrivateValueMatcher(sql);for(const input of ['send 6847 today','send 2749 today','Ask Brook for guidance'])assert.equal(match(input),true,String(length)+input);
  }
  for(const source of ['I billed Alder','I invoiced Van','I billed May','I billed An','I billed Alder. I billed May']){
   const js=[...new Set(privateOriginKeys(source))].sort(),sql=(await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k);assert.deepEqual(sql,js,source);assert.equal(createPrivateValueMatcher(sql).ordinary('Ask '+source.split(' ').at(-1)+' for advice'),true,source);
  }
  for(const source of ['Are invoices numbered sequentially?','My bills are confusing','I will invoice you later','I will invoice you alone','Have invoices always been numbered?','I received an ordinary letter','I received 3 books from Alder Finch','I charged the batteries today']){
   assert.equal(privateOriginStart(source),null,source);assert.deepEqual(privateOriginKeys(source),[],source);assert.equal((await f.db.query('select app.private_invoice_has_origin($1) yes',[source])).rows[0].yes,false,source);
  }
 }finally{await f.close();}
});

test('complete long numeric graphs retain cross-row paths; incomplete graphs fail closed',async()=>{
 const f=await fixture({recording:true});try{
  for(const count of [1100,2200])for(const wrap of [value=>value,value=>'A supporting description '+value+' ends here']){
   const source=wrap(Array.from({length:count},(_,i)=>String(101+i)).join(','));
   const js=privateFieldKeys(source).sort(),sql=(await f.db.query('select distinct k from app.private_invoice_term_aliases($1) k order by k',[source])).rows.map(x=>x.k);assert.deepEqual(sql,js);
   assert.ok(sql.every(key=>key.length<=4000));const match=createPrivateValueMatcher(sql);for(const value of [101,1073,100+count])assert.equal(match('send '+value+' today'),true);
   assert.equal(match('send 1040.1041 today'),true,'Grouping path crosses a storage-row boundary');assert.equal(match('send 987654321 today'),false);
  }
  const keys=privateNumberKeys(Array.from({length:1100},(_,i)=>String(101+i)).join(','));assert.throws(()=>createPrivateValueMatcher(keys.slice(1)),{code:'CHAT_MEMORY_UNAVAILABLE'});
  const large='1'.repeat(150000),largeJS=privateFieldKeys(large).sort(),largeSQL=(await f.db.query('select distinct k from app.private_invoice_term_aliases($1) k order by k',[large])).rows.map(x=>x.k);assert.deepEqual(largeSQL,largeJS);assert.ok(largeSQL.every(key=>key.length<=4000));
 }finally{await f.close();}
});

test('computed-fact capture is typed, durable and required before disclosure',async()=>{
 const f=await fixture({recording:true});try{
  const result={ok:true,readOnly:true,operation:'read',table:'invoices',truncated:false,offset:0,rows:[1301,2473].map(total_amount=>({status:'draft',currency:'INR',total_amount,amount_paid:0}))};let calls=0;
  await retainReceivablesResult(result,async text=>{calls++;await f.db.query('select app.retain_private_origin_terms($1,$2)',[f.scope.workspaceId,text]);return true;});assert.ok(calls>0);
  const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(x=>x.term);assert.ok(terms.includes('number:3774'));assert.ok(!terms.includes('draft'));
  await assert.rejects(retainReceivablesResult(result,async()=>false),/PRIVATE_RESULT_RETENTION_UNAVAILABLE/);
 }finally{await f.close();}
});

test('financial word senses route consistently without person or ordinary-topic exceptions',()=>{
 for(const person of ['Nye','Gates','Harper','Rowan']){const text=`Is Bill ${person} a scientist?`;assert.equal(invoiceReadQuestion(text),false);assert.equal(privateChatTopic(text),false);}
 for(const text of ["What does 'paid attention' mean?",'Explain why the balance of an ecosystem matters','Explain the balance of a painting','Tell me about work-life balance']){assert.equal(invoiceReadQuestion(text),false,text);assert.equal(privateChatTopic(text),false,text);}
 for(const text of ['balance','What is my balance?','Show unpaid invoices','Is it paid?'])assert.equal(invoiceReadQuestion(text),true,text);
});
