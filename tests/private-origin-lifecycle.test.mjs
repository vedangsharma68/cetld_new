import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';
import {privateOriginKeys} from '../ai/private-value-matcher.mjs';

const factory=wires=>options=>new AIProvider({...options,cfAccountId:'local-provenance',cfApiToken:'local-provenance',maxAttempts:1,
 logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({raw:init.body,messages:body.messages});return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}});
const sources=[
 [JSON.stringify({invoice:{customer_name:'Olive Desk',total:7843,due_date:'2027-04-26'}}),['Ask Olive for advice','Ask Desk for advice','send 7843 today','is it due 26 अप्रैल 2027?']],
 [JSON.stringify({quote:'Invoice is from Elm Craft, 5847, due 27 Apr 2027'}),['Ask Elm for advice','Ask Craft for advice','send 5847 today','is it due 27/04/2027?']],
 ['Invoice amount is 5147',['send 5147 today','send ५१४७ today']],
 ['Client is Cedar Works',['Ask Cedar Works for advice','Ask Cedar for advice','Ask Works for advice']],
 ['Invoice due date is 2027-09-23',['is it due 23 Sep 2027?','is it due २३ सितंबर २०२७?']],
 ['Invoice is from Willow Workshop, 8654, due 12 Nov',['Ask Willow Workshop for advice','Ask Willow for advice','Ask Workshop for advice','send 8654 today','send ८६५४ today','is it due November 12?','is it due बारह नवंबर?']],
 ['Receipt from Anurag Sharma, 1250, due 31 October 2026',['Ask Anurag Sharma for advice','Ask Anurag for advice','Ask Sharma for advice','Ask अनुराग for advice','ask शर्मा today','send 1¼ thousand today','send बारह सौ पचास today','is it due ३१ अक्टूबर २०२६?']],
 ['Forwarded: "Invoice belongs to किरण शर्मा, 7931, due 14 Nov"',['Ask किरण for advice','Ask शर्मा for advice','send ७९३१ today','is it due 14/11?']],
 ['Customer is Maple Studio; amount is 9685; due date is 2026-11-15',['Ask Maple for advice','Ask Maple Studio for advice','send 9685 today','is it due 15 नवंबर 2026?']],
];

test('quotation declarations acquire durable provenance before any handler restart: both audiences and every field kind',async t=>{
 for(const audience of ['owner','customer'])await t.test(audience,async t=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});let sequence=0,customer;
 const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory(wires),logger:{error(){}}});};restart();
 const turn=(audience,message)=>audience==='owner'?f.turn(message):customer({...f.scope,message,messageId:'origin-'+(++sequence)});
 try{
  for(const[source,followups]of sources){
   const before=wires.length;await turn(audience,source);assert.equal(wires.length,before,'Private source must stay local');restart();
   for(const message of followups)await t.test(audience+'/'+message,async()=>{const n=wires.length;await turn(audience,message);assert.equal(wires.length,n,JSON.stringify(wires.slice(n)));restart();});
   await turn(audience,'Tell me a joke');assert.equal(wires.length,before+1);assert.doesNotMatch(wires.at(-1).raw,/Willow|8654|८६५४|Anurag|Sharma|1250|किरण|७९३१|Maple|9685/);
  }
  const ordinary=(await f.db.query('select content from whatsapp_provider_memory')).rows;
  assert.ok(ordinary.length);assert.ok(ordinary.every(r=>!/Willow|8654|Anurag|Sharma|किरण|Maple|9685/.test(r.content)));
 }finally{await f.close();}
 });
});

test('private-origin retention belongs to terms, audit history and memory write sinks',async()=>{
 for(const sink of ['document','terms_insert','quoted_document_field','owner_history','customer_history','memory_append','memory_answer','memory_insert','memory_update']){
  const wires=[],f=await fixture({providerFactory:factory(wires)});try{
   const source='Invoice is from Willow Workshop, 8654, due 12 Nov';
   if(sink==='document')await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:source}]);
   if(sink==='terms_insert')await f.db.query("insert into whatsapp_private_invoice_terms(workspace_id,term_hash,term) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'),$2)",[f.scope.workspaceId,source]);
   if(sink==='quoted_document_field')await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:JSON.stringify({invoice:{customer_name:'Willow Workshop',total:8654,due_date:'12 Nov'}})}]);
   if(sink==='owner_history')await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,'origin-write','whatsapp','user',$3)",[f.scope.workspaceId,f.scope.ownerId,source]);
   if(sink==='customer_history')await f.db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,'user',$4)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,source]);
   if(sink==='memory_append'){const m=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience:'owner',messageId:'origin-append'}});await m.read('Hello');await m.append(source,'An ordinary answer');}
   if(sink==='memory_answer'){const m=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience:'owner',messageId:'origin-answer'}});await m.read('Hello');await m.append('Hello',source);}
   if(sink==='memory_update'){await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,'owner','origin-update','user','Hello','ordinary_chat_v1')",[f.scope.workspaceId,f.scope.ownerId,f.scope.phone]);await f.db.query("update whatsapp_provider_memory set content=$1 where source_message_id='origin-update'",[source]);}
   if(sink==='memory_insert')await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,'owner','origin-sql','user',$4,'ordinary_chat_v1')",[f.scope.workspaceId,f.scope.ownerId,f.scope.phone,source]);
   const terms=(await f.db.query('select term from whatsapp_private_invoice_terms')).rows.map(r=>r.term);
   for(const key of ['party:willow','party:workshop','number:8654','date:*-11-12'])assert.ok(terms.includes(key),sink+': '+key);
   assert.equal((await f.db.query("select count(*)::int n from whatsapp_provider_memory where content=$1",[source])).rows[0].n,0,'Source cannot be tagged ordinary: '+sink);
   f.restart();for(const message of ['Ask Willow for advice','send 8654 today','is it due 12 Nov?'])await f.turn(message);assert.equal(wires.length,0,sink);
  }finally{await f.close();}
 }
});

test('quotation party provenance preserves the ordinary name/Indic false-positive controls',async()=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});try{
  await f.turn('Ask Sharma for advice');assert.equal(wires.length,1,'Unretained surname stays ordinary');
  await f.turn('Invoice is from Anurag Sharma, 1250, due 31 Oct 2026');
  await f.turn('Invoice is from किरण, 8654, due 12 Nov');f.restart();
  const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory(wires),logger:{error(){}}});let seq=0;
  for(const audience of ['owner','customer'])for(const message of ['Ask Sharmila for advice','Ask Anuradha for advice','Ask करण for advice','Sharma is a common surname','Explain the etymology of the surname Sharma','is it due 31 Oct 2027?','The numbers are 77,2500']){
   const n=wires.length;await(audience==='owner'?f.turn(message):customer({...f.scope,message,messageId:'ordinary-origin-'+(++seq)}));assert.equal(wires.length,n+1,message);
  }
 }finally{await f.close();}
});


test('history read retains mislabelled origin fields before filtering newer fragments or another restart',async()=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});try{
  // Model an old/corrupt positive row. Current writes cannot make this row:
  // exercise read-side defense independently of the new write guard.
  await f.db.exec('alter table whatsapp_provider_memory disable trigger guard_private_provider_memory');
  for(const [i,content]of ['Invoice is from Willow Workshop, 8654, due 12 Nov','Ask Willow for advice'].entries())await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,'owner',$4,'user',$5,'ordinary_chat_v1')",[f.scope.workspaceId,f.scope.ownerId,f.scope.phone,'old-origin-'+i,content]);
  await f.db.exec('alter table whatsapp_provider_memory enable trigger guard_private_provider_memory');
  await f.turn('Tell me a joke');assert.equal(wires.length,1);assert.doesNotMatch(wires[0].raw,/Willow|8654|12 Nov/);f.restart();
  for(const message of ['Ask Willow for advice','send 8654 today','is it due November 12?'])await f.turn(message);assert.equal(wires.length,1);
 }finally{await f.close();}
});


test('shared declaration routing and SQL origin keys cannot diverge across source forms',async()=>{
 const f=await fixture();try{
  const{privateChatSpans}=await import('../ai/private-chat.mjs');
  const{privateOriginStart}=await import('../ai/private-value-matcher.mjs');
  const variants=[...sources.map(([source])=>source).filter(source=>!source.startsWith('{')),'The invoice was sent by Willow Workshop, 8654, due 12 Nov','My receipt belongs to Willow Workshop, 8654, due 12 Nov','set notes to Invoice is from Willow Workshop, 8654, due 12 Nov','Quoted: "Customer is Anurag Sharma; amount is 1250; due date is 31 Oct 2026"'];
  for(const[source]of sources){const actual=(await f.db.query('select app.private_invoice_has_origin($1) ok',[source])).rows[0].ok;assert.equal(actual,privateOriginStart(source)!==null);}
  for(const source of variants){assert.notEqual(privateOriginStart(source),null);assert.ok(privateChatSpans(source).length);const sql=(await f.db.query('select distinct term from app.private_invoice_origin_aliases($1) term order by term',[source])).rows.map(r=>r.term);assert.deepEqual(sql,privateOriginKeys(source).sort(),source);}
 }finally{await f.close();}
});


test('typed monetary declarations and evidence do not become wildcard dates through provenance closure',async()=>{
 const wires=[],f=await fixture({providerFactory:factory(wires)});try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{printedEvidence:{total:'Total: 31.10'},notes:'amount is 12.50',invoice:{total:'31.10',amount:'12.50'}}]);
  const keys=(await f.db.query('select term from whatsapp_private_invoice_terms')).rows.map(r=>r.term);
  assert.ok(keys.includes('number:31.1'));assert.ok(keys.includes('number:12.5'));assert.ok(!keys.includes('date:*-10-31'));assert.ok(!keys.includes('date:*-05-12'));
  await f.turn('is it due 31 Oct 2027?');await f.turn('is it due 12 May 2027?');assert.equal(wires.length,2);
  for(const source of ['Total: 31.10','amount is 12.50']){const actual=(await f.db.query('select distinct term from app.private_invoice_origin_aliases($1) term order by term',[source])).rows.map(r=>r.term);assert.deepEqual(actual,privateOriginKeys(source).sort());}
 }finally{await f.close();}
});
