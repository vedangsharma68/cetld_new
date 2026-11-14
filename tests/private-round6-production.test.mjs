import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,png} from './fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';
import {createPrivateChatProvider,privateChatTopic,PRIVATE_CHAT_REPLY} from '../ai/private-chat.mjs';
import {decodePrivateJSON,privateOriginDocuments,privateOriginKeys,privateFieldKeys,privatePartyKeys,privateNumberKeys} from '../ai/private-value-matcher.mjs';

const providerFactory=(wires,reply)=>options=>new AIProvider({...options,cfAccountId:'synthetic-round6',cfApiToken:'synthetic-round6',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{
 assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({body,serializedMessages:JSON.stringify(body.messages)});
 return Response.json({choices:[{message:reply(body)}]});
}});
const nested=(name='Birch Works',amount=6847)=>JSON.stringify({quote:JSON.stringify({invoice:{customer_name:name,total:amount,due_date:'2027-07-16'}})});
const boundaries=['history','model-response','tool-arguments','tool-result','memory-write'];
const samples=['The figures are 1,250.00','Choose between 1250,77,2500',Array.from({length:33},(_,i)=>String(600+i)).join(','),'1250,77,2500','The figures are 1250,77','Is Sharma coming tomorrow? Explain the etymology of that surname.','Sharma was here yesterday; what is the meaning of this surname?',
 'Ask Green1 for advice','Ask 李 for advice','Ask 𠀀 for advice','one point two five trillion','one lakh crore','one million million','one thousand billion',nested(),...['\u200b','\ufeff','\u0085','\u00a0'].map(prefix=>prefix+nested())];

test('round6 all decoded privacy boundaries use production memory, real provider serialization and actual SQL retention',async t=>{
 const f=await fixture();let n=0;
 try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:1250,amount:1250000000000,balance:1000000000000,privateListMember:600,partyNames:['Anurag Sharma','Green1 Materials LLC','李 王','𠀀 王']}]);
  for(const audience of ['owner','customer'])for(const surface of boundaries)for(const value of samples)await t.test(audience+'/'+surface+'/'+value,async()=>{
   await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);
   const scope={...f.scope,audience,messageId:'r6-'+(++n)},memory=createPrivateChatMemory({supabase:f.supabase,scope}),wires=[];let leg=0;
   if(surface==='history')await f.db.query(`insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance)
    values($1,$2,$3,$4,$5,$6,'user',$7,'ordinary_chat_v1')`,[scope.workspaceId,audience==='owner'?scope.ownerId:null,audience==='customer'?scope.customerId:null,scope.phone,audience,'legacy-'+scope.messageId,value]);
   const provider=createPrivateChatProvider({message:'Tell me about gardening',memory,options:{},providerFactory:providerFactory(wires,()=>surface==='model-response'?{content:value}:surface.startsWith('tool-')&&leg++===0?{tool_calls:[{id:'issued-r6',type:'function',function:{name:'probe',arguments:JSON.stringify(surface==='tool-arguments'?{detail:value}:{})}}]}:{content:'An ordinary answer'})});
   const tools=[{type:'function',function:{name:'probe',parameters:{type:'object',properties:{detail:{type:'string'}}}}}];provider.setTools(tools);
   if(surface==='memory-write'){await memory.read('Hello');await memory.append(value,'An ordinary answer');await memory.append('Hello',value);assert.equal(wires.length,0);}
   else{
    let reply=await provider.generate({tools});
    if(surface==='tool-result'){assert.equal(reply.toolCalls.length,1);reply=await provider.generate({tools,messages:[{role:'assistant',tool_calls:reply.toolCalls},{role:'tool',tool_call_id:'issued-r6',name:'probe',content:JSON.stringify({detail:value})}]});assert.equal(wires.length,1);}
    if(['model-response','tool-arguments','tool-result'].includes(surface)){assert.equal(reply.content,PRIVATE_CHAT_REPLY);assert.deepEqual(reply.toolCalls,[]);}
    if(surface==='history')assert.deepEqual(wires[0].body.messages.map(m=>m.content),[wires[0].body.messages[0].content,'Tell me about gardening']);
   }
   assert.ok(wires.every(w=>!w.serializedMessages.includes(value)),JSON.stringify(wires));
   const rows=(await f.db.query('select content from whatsapp_provider_memory where workspace_id=$1 and source_message_id=$2',[scope.workspaceId,scope.messageId])).rows;
   assert.ok(rows.every(row=>row.content!==value),JSON.stringify(rows));
   assert.ok(rows.every(row=>!memory.containsPrivate(row.content)),JSON.stringify(rows));
  });
 }finally{await f.close();}
});

test('round6 structured origin traversal, key construction and header-role continuation agree byte-for-byte with SQL',async()=>{
 const f=await fixture();try{
  const corpus=['1250,77,2500','1250 77','1,250.00','1250,77','Rs.1,250/-',Array.from({length:33},(_,i)=>String(100+i)).join(','),nested(),JSON.stringify({wrapper:[{other:JSON.stringify([JSON.stringify({invoice:{total:5318}})])}]}),'ordinary text',JSON.stringify({question:'ordinary gardening'}),
   'Here is the bill, Anurag Sharma, 1250, due 31 Oct 2026','Forwarded: Here is the bill,, Anurag Sharma,1250,due 31 Oct 2026',
   'The Cedar Studio','A Green1 Materials','Saar Cedar','Sar Cedar','Noor Cedar','Nor Cedar','𠀀 王','𐐀 王','𠀀𠀁 王','李 王','किरण','करण','कमल','कोमल',
   'one lakh crore','two lakh crore','one million million','one billion million two hundred','one crore one lakh','one point two five trillion','one and a quarter trillion','twelve hundred billion','one billion two hundred million',
   ...['thousand','lakh','crore','million','billion','trillion','quadrillion','quintillion'].flatMap(scale=>['one','twelve fifty','one point two five','one and a quarter','1.25'].map(head=>head+' '+scale))];
  for(const outer of ['', 'Notes: ', 'Set notes to ', 'Forwarded: '])for(const header of ['Here is the bill','This invoice is from','Customer is'])for(const separator of [', ', ',, ', '; ', '\n'])corpus.push(outer+header+separator+'Anurag Sharma,1250,due 31 Oct 2026');
  corpus.push(...['\u200b','\ufeff','\u0085','\u00a0','\u2060'].flatMap(prefix=>[prefix+nested(),JSON.stringify({quote:prefix+nested()})]));
  for(const value of corpus){
   for(const enumeration of [false,true]){const actual=(await f.db.query('select distinct term from app.private_invoice_numeric_candidates($1,$2) term order by term',[value,enumeration])).rows.map(row=>row.term);assert.deepEqual(actual,[...new Set(privateNumberKeys(value,enumeration))].sort(),'number candidates/'+enumeration+'/'+value);}
   for(const [sqlFunction,js]of[['private_invoice_term_aliases',privateFieldKeys],['private_invoice_party_aliases',privatePartyKeys],['private_invoice_origin_aliases',privateOriginKeys]]){
    const sql=(await f.db.query(`select distinct term from app.${sqlFunction}($1) term order by term`,[value])).rows.map(row=>row.term);
    assert.deepEqual(sql,[...new Set(js(value))].sort(),sqlFunction+'/'+value);
   }
   const sql=(await f.db.query('select app.private_invoice_has_origin($1) yes',[value])).rows[0].yes;
   const expected=[...privateOriginDocuments(value)],actual=(await f.db.query('select value from app.private_invoice_origin_documents(to_jsonb($1::text),0) value',[value])).rows.map(row=>row.value);
   assert.deepEqual(actual,expected,'decoded origin documents/'+value);
   assert.equal(sql,expected.length>0,'origin predicate/'+value);
   if(sql)assert.equal(privateChatTopic(value),true,'routing/'+value);
  }
  // Compatibility normalization of decoded values must not rewrite JSON syntax.
  const source=JSON.stringify({invoice:{notes:'Use ＂quotes＂ inside strings',total:5318}});
  assert.equal(decodePrivateJSON(source).invoice.notes,'Use ＂quotes＂ inside strings');
  const docs=(await f.db.query('select value from app.private_invoice_origin_documents(to_jsonb($1::text),0) value',[source])).rows;
  assert.equal(docs[0].value.invoice.notes,decodePrivateJSON(source).invoice.notes);
 }finally{await f.close();}
});

test('round6 actual service_role writes retain nested private documents and reject ordinary-memory provenance, inserts and updates',async()=>{
 const f=await fixture();try{
  for(const audience of ['owner','customer'])for(const prefix of ['', '\u200b','\ufeff','\u0085','\u00a0']){
   await f.db.exec('begin;set local role service_role');
   try{
    assert.equal((await f.db.query('select current_user name')).rows[0].name,'service_role');
    const source=prefix+nested(),args=[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience];
    const insert=await f.db.query(`insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance)
     values($1,$2,$3,$4,$5,'role-guard','user',$6,'ordinary_chat_v1') returning id`,[...args,source]);assert.equal(insert.rows.length,0);
    assert.equal((await f.db.query("select exists(select 1 from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:6847') yes",[f.scope.workspaceId])).rows[0].yes,true);
   }finally{await f.db.exec('commit');}
   // UPDATE is deliberately not a service-role capability. Owner seeding proves
   // the trigger remains authoritative for privileged legacy row updates too.
   const row=(await f.db.query(`insert into whatsapp_provider_memory(workspace_id,owner_id,customer_id,phone,audience,source_message_id,role,content,provenance)
    values($1,$2,$3,$4,$5,$6,'user','Ordinary gardening','ordinary_chat_v1') returning id`,[f.scope.workspaceId,audience==='owner'?f.scope.ownerId:null,audience==='customer'?f.scope.customerId:null,f.scope.phone,audience,'legacy-'+audience+prefix])).rows[0];
   assert.equal((await f.db.query('update whatsapp_provider_memory set content=$1 where id=$2 returning id',[prefix+nested('Moss Craft',7936),row.id])).rows.length,0);
   assert.equal((await f.db.query('select content from whatsapp_provider_memory where id=$1',[row.id])).rows[0].content,'Ordinary gardening');
   assert.equal((await f.db.query("select exists(select 1 from whatsapp_private_invoice_terms where workspace_id=$1 and term='party:moss') yes",[f.scope.workspaceId])).rows[0].yes,true);
  }
 }finally{await f.close();}
});

test('round6 decoded source provenance survives every retention sink and handler reconstruction for both audiences',async t=>{
 for(const [sink,kind] of ['terms','owner-audit','customer-audit','provider-memory','memory-append'].flatMap(sink=>['structured','composed-header'].map(kind=>[sink,kind])))await t.test(sink+'/'+kind,async t=>{
  const wires=[],factory=providerFactory(wires,()=>({content:'An ordinary answer'})),f=await fixture({providerFactory:factory});
  try{
   const source=kind==='composed-header'?'Notes: Here is the bill, Anurag Sharma,6847,due 16 Jul 2027':'\u200b\ufeff\u0085\u00a0'+JSON.stringify({quote:JSON.stringify({packet:[JSON.stringify({invoice:{customer_name:'Anurag Sharma',total:6847,due_date:'2027-07-16'}})]})});
   if(sink==='terms')await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:source}]);
   if(sink==='owner-audit')await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,'r6-source','whatsapp','user',$3)",[f.scope.workspaceId,f.scope.ownerId,source]);
   if(sink==='customer-audit')await f.db.query('insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content) values($1,$2,$3,\'user\',$4)',[f.scope.workspaceId,f.scope.customerId,f.scope.phone,source]);
   if(sink==='provider-memory')assert.equal((await f.db.query("insert into whatsapp_provider_memory(workspace_id,owner_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,$3,'owner','r6-source','user',$4,'ordinary_chat_v1') returning id",[f.scope.workspaceId,f.scope.ownerId,f.scope.phone,source])).rows.length,0);
   if(sink==='memory-append'){const memory=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience:'customer',messageId:'r6-source'}});await memory.read('Hello');await memory.append(source,'An ordinary answer');}
   const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
   for(const term of ['party:anurag','party:sharma','number:6847','date:2027-07-16'])assert.ok(terms.includes(term),sink+'/'+term);
   for(const audience of ['owner','customer'])for(const message of ['Ask Anurag Sharma for advice','Ask Anurag for advice','Ask शर्मा for advice','send 6847 today','send ६८४७ today','is it due 16 Jul 2027?','is it due १६ जुलाई २०२७?'])await t.test(audience+'/'+message,async()=>{
    f.restart();const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});
    const before=wires.length;if(audience==='owner')await f.turn(message);else await customer({...f.scope,message,messageId:'r6-restart-'+message});
    assert.equal(wires.length,before,JSON.stringify(wires.slice(before)));
   });
   assert.equal((await f.db.query('select count(*)::int n from whatsapp_provider_memory')).rows[0].n,0);
  }finally{await f.close();}
 });
});

test('round6 party specificity preserves Latin vowel identity and Indic name distinctions at the actual HTTP boundary',async t=>{
 const wires=[],factory=providerFactory(wires,()=>({content:'Birds enjoy the sunshine.'})),f=await fixture({providerFactory:factory});let sequence=0;
 try{
  for(const [stored,other]of [['Saar Cedar','Sar'],['Noor Cedar','Nor'],['किरण शर्मा','करण'],['कमल शर्मा','कोमल']]){
   const customer=(await f.db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[f.scope.workspaceId,stored])).rows[0];
   await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,$3,43,'INR','draft')",[f.scope.workspaceId,customer.id,'R6-IDENTITY-'+(++sequence)]);
   for(const audience of ['owner','customer'])await t.test(audience+'/'+stored+' != '+other,async()=>{
    f.restart();const handler=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});
    const turn=message=>audience==='owner'?f.turn(message):handler({...f.scope,message,messageId:'r6-identity-'+(++sequence)});
    const before=wires.length;await turn('Ask '+other+' for advice');assert.equal(wires.length,before+1);
    assert.equal(wires.at(-1).body.messages.at(-1).content,'Ask '+other+' for advice');
    await turn('Ask '+stored.split(' ')[0]+' for advice');assert.equal(wires.length,before+1);
   });
  }
 }finally{await f.close();}
});

test('round6 numeric interpretations never discard a private whole value; retain lists without inventing members in a stored decimal',async()=>{
 for(const stored of [{total:1250.77},{notes:'1250,77,2500'}]){
  const wires=[],factory=providerFactory(wires,()=>({content:'An ordinary answer'})),f=await fixture({providerFactory:factory});let sequence=0;
  try{
   await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,stored]);
   const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
   assert.ok(terms.includes('number:1250.77'));
   if(stored.total)assert.ok(!terms.includes('number:1250'),'A stored decimal is atomic, never its integer prefix');
   else for(const value of [1250,77,2500])assert.ok(terms.includes('number:'+value));
   for(const uploaded of [false,true]){
    if(uploaded){await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});await f.turn('cancel');}
    f.restart();const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});
    for(const audience of ['owner','customer']){
     const turn=message=>audience==='owner'?f.turn(message):customer({...f.scope,message,messageId:'r6-number-'+(++sequence)});
     for(const message of ['Choose between 1250,77,2500','The figures are 1250,77','The price is 1250,77','send 1250.77 today']){const before=wires.length;await turn(message);assert.equal(wires.length,before,JSON.stringify(wires.slice(before)));}
     const ordinary=stored.total?'send 1250 today':'send 7513 today',before=wires.length;await turn(ordinary);assert.equal(wires.length,before+1);assert.equal(wires.at(-1).body.messages.at(-1).content,ordinary);
    }
   }
  }finally{await f.close();}
 }
});

test('round6 long numeric runs stay local without consuming an independent ordinary clause with an unrelated number',async()=>{
 const wires=[],f=await fixture();try{
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:1250,privateListMember:600}]);
  for(const audience of ['owner','customer']){
   const memory=createPrivateChatMemory({supabase:f.supabase,scope:{...f.scope,audience,messageId:'numeric-bound-'+audience}}),run=Array.from({length:33},(_,i)=>String(600+i)).join(',');
   const message='Help me plan a walk for 2 people; '+run;
   const provider=createPrivateChatProvider({memory,message,options:{},providerFactory:providerFactory(wires,()=>({content:'An ordinary answer'}))});
   const before=wires.length;await provider.generate();assert.equal(wires.length,before+1);
   assert.equal(wires.at(-1).body.messages.at(-1).content,'Help me plan a walk for 2 people');
   assert.ok(!wires.at(-1).serializedMessages.includes(run));
  }
 }finally{await f.close();}
});
