import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createPrivateChatProvider,PRIVATE_CHAT_REPLY} from '../ai/private-chat.mjs';
import {createPrivateChatMemory} from '../ai/private-chat-memory.mjs';
import {normalizePrivateValue,createPrivateValueMatcher} from '../ai/private-value-matcher.mjs';
import {createOwnerMessageHandler as fixtureHandler} from './fixtures/owner-engine.mjs';
import {createOwnerMessageHandler as productionHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {fixture,png} from './fixtures/private-invoice.mjs';

const terms=['1250','anurag','2026-10-31','INV-2026-0142'];
const cases=[
  'The amounts are 1250, 77','The amounts are 1250, 2500','The pair is 1250 77',
  'Forwarded: "The amounts are 1250, 77"','31/10/26','31.10.26','10/31/26','31/10','31.10','10-31',
  'one thousand, two hundred and fifty','one thousand two hundred & fifty','1.25k',
  'INV–2026–0142','INV 2026 0142','INV/2026/0142','१,२५०','١٢٥٠','١٬٢٥٠','١٢٥٠٫٠٠',
  'one point two five thousand','one and a quarter thousand','twelve and a half hundred',
  'Quoted: "one thousand,\ntwo hundred and fifty"','1\ufe0f250','1\u034f250','one two five zero',
];
function boundary({stored=terms,history=[],response='A safe answer'}={}){
  const payloads=[],writes=[];
  const supabase={from(table){const q={select(){return q},eq(){return q},order(){return q},
    async limit(){return {data:history}},async range(){return {data:table==='whatsapp_private_invoice_terms'?stored.map(term=>({term})):[]}},async insert(rows){writes.push(...rows);return {data:null}}};return q;}};
  const memory=createPrivateChatMemory({supabase,scope:{workspaceId:'w',ownerId:'o',audience:'owner',phone:'+123',messageId:'m'}});
  const provider=message=>createPrivateChatProvider({message,memory,options:{},providerFactory:()=>({async generate(request){payloads.push(JSON.parse(JSON.stringify(request.messages)));return typeof response==='function'?response(request):{content:response};}})});
  return {provider,memory,payloads,writes};
}
for(const message of cases)test('production boundary excludes F1/F2/F6 restatement: '+message,async()=>{
  const h=boundary();assert.equal((await h.provider(message).generate()).content,PRIVATE_CHAT_REPLY);assert.deepEqual(h.payloads,[]);assert.deepEqual(h.writes,[]);
});
for(const message of ['77, 2500','The pair is 77 2500','1,2500','12500','top up 100','we are 100 people coming','2027-10-31','31 Oct 2025','31/10/27','31.10.25','10/31/25','is it due next Friday?'])test('production control stays provider-bound: '+message,async()=>{
  const h=boundary();await h.provider(message).generate();assert.equal(h.payloads.length,1);assert.equal(h.payloads[0].at(-1).content,message);
});
test('F1 grouped values are not split, lists are segmented, and unrelated tokens remain ordinary',async()=>{
  for(const stored of [['1'],['250']]){
    const h=boundary({stored});await h.provider('send 1 250 today').generate();assert.equal(h.payloads.length,1);
  }
  const h=boundary();await h.provider('The amounts are 1 250, 77').generate();await h.provider('The pair is 1 250 77').generate();assert.deepEqual(h.payloads,[]);
});
test('F3 currency-symbol and signed/parenthesized raw retention canonicalizes in both directions',async()=>{
  for(const raw of ['₹1,250','₹1.250,00','$1250','€1 250','£1’250.00','(1250)','-1250']){
    const h=boundary({stored:[raw]});await h.provider('send 1250 today').generate();assert.deepEqual(h.payloads,[],raw);
    const reverse=boundary({stored:['1250']});await reverse.provider('send '+raw+' today').generate();assert.deepEqual(reverse.payloads,[],raw);
  }
});
test('F7 decoded JSON values are screened at every shared boundary, including nested tool arguments/results and responses',async()=>{
  for(const privateValue of ['1\n250','31/\n10/26','31\nOct\n2026','one thousand, two hundred & fifty','INV/2026/0142']){
    const response=boundary({response:()=>({toolCalls:[{id:'issued',function:{name:'lookup',arguments:'{}'}}]})});
    const provider=response.provider('Explain gardening');provider.setTools([{type:'function',function:{name:'lookup'}}]);
    const first=await provider.generate({tools:[{function:{name:'lookup'}}]});
    const reply=await provider.generate({messages:[{role:'assistant',tool_calls:first.toolCalls},{role:'tool',tool_call_id:'issued',content:JSON.stringify({nested:[{detail:privateValue}]})}]});
    assert.equal(reply.content,PRIVATE_CHAT_REPLY);assert.equal(response.payloads.length,1);
    const argument=boundary({response:()=>({toolCalls:[{id:'bad',function:{name:'lookup',arguments:JSON.stringify({nested:{value:privateValue}})}}]})});
    const p=argument.provider('Explain gardening');p.setTools([{type:'function',function:{name:'lookup'}}]);
    assert.deepEqual((await p.generate({tools:[{function:{name:'lookup'}}]})).toolCalls,[]);
    const history=boundary({history:[{id:1,role:'user',provenance:'ordinary_chat_v1',content:JSON.stringify({value:privateValue})}]});
    await history.provider('Hello').generate();assert.equal(history.payloads[0].length,2);
    const output=boundary({response:JSON.stringify({value:privateValue})});assert.equal((await output.provider('Hello').generate()).content,PRIVATE_CHAT_REPLY);assert.deepEqual(output.writes,[]);
    const current=boundary();await current.provider(JSON.stringify({value:privateValue})).generate();assert.deepEqual(current.payloads,[]);
    await current.memory.read('Hello');await current.memory.append('Hello',JSON.stringify({value:privateValue}));assert.deepEqual(current.writes,[]);
  }
});
test('F9 mixed ordinary clauses are general and independently understandable, not an intent allowlist',async()=>{
  for(const ordinary of ['Help me plan a walk','Can you suggest a lentil recipe','What ingredients make a good soup','Which ingredients make a good soup','Where can I go for a walk','Write a packing checklist for a mountain trip']){
    const h=boundary();const reply=await h.provider(ordinary+'; The amounts are 1250, 77').generate();
    assert.match(reply.content,/A safe answer/);assert.equal(h.payloads[0].at(-1).content,ordinary);assert.deepEqual(h.writes.map(row=>row.content),[ordinary,'A safe answer']);
  }
  for(const message of ['1250; do it tomorrow','1250; explain that instead']){const h=boundary();await h.provider(message).generate();assert.deepEqual(h.payloads,[]);}
});

test('F1-F3/F6/F8/F9 actual owner and customer handlers share the production boundary',async()=>{
  const f=await fixture({recording:true});const payloads=[];try{
    await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,terms]);
    const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,
      providerFactory:()=>({async generate(request){payloads.push(JSON.parse(JSON.stringify(request.messages)));return {content:'A safe answer'};}})});
    for(const [i,message] of cases.entries()){
      const before=f.providerRecord.calls;assert.equal((await f.turn(message)).answer,PRIVATE_CHAT_REPLY,message);assert.equal(f.providerRecord.calls,before);
      const count=payloads.length;assert.equal(await customer({...f.scope,messageId:'private-'+i,message}),PRIVATE_CHAT_REPLY,message);assert.equal(payloads.length,count);
    }
    for(const [i,message] of ['77, 2500','2027-10-31','31 Oct 2025','31/10/27','top up 100','Help me plan a walk; 1250, 77'].entries()){
      const ownerBefore=f.providerRecord.calls;assert.match((await f.turn(message)).answer,/Summary/);assert.equal(f.providerRecord.calls,ownerBefore+1);
      assert.equal(f.providerRecord.requests.at(-1).messages.at(-1).content,message.includes(';')?'Help me plan a walk':message);
      await customer({...f.scope,messageId:'ordinary-'+i,message});assert.equal(payloads.at(-1).at(-1).content,message.includes(';')?'Help me plan a walk':message);
    }
  }finally{await f.close();}
});

test('F4/F5 invoice insert/update and migration backfill retain linked customer fields without needing a customer UPDATE',async()=>{
  const f=await fixture({recording:true});try{
    const customer=(await f.db.query("insert into customers(workspace_id,name,company_name,email,phone) values($1,'İlker','Dotted Company','ilker@example.test','+14155558888') returning id",[f.scope.workspaceId])).rows[0];
    const insert=await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'INV-RETENTION-91',1250,'INR','draft') returning id",[f.scope.workspaceId,customer.id]);
    const retained=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
    for(const value of ['ilker','dotted company','ilker@example.test','+14155558888'])assert.ok(retained.includes(value),value);
    for(const message of ['Tell me about İlker','Tell me about Ilker','Tell me about ılker','Tell me about I\u0307lker','Dotted Company']){
      const before=f.providerRecord.calls;await f.turn(message);assert.equal(f.providerRecord.calls,before,message);
    }
    // A second, already-existing customer is retained when reassigned, too.
    const second=(await f.db.query("insert into customers(workspace_id,name,company_name) values($1,'Second Recipient','Second Company') returning id",[f.scope.workspaceId])).rows[0];
    await f.db.query('update invoices set customer_id=$1 where id=$2',[second.id,insert.rows[0].id]);
    const updated=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
    assert.ok(updated.includes('second recipient'));assert.ok(updated.includes('second company'));assert.ok(updated.includes('ilker'));
    await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'INV-RETENTION-92',1250,'INR','draft')",[f.scope.workspaceId,customer.id]);
    // Execute the exact migration backfill bytes, not a hand-written substitute.
    const {readFile}=await import('node:fs/promises');const migration=await readFile(new URL('../supabase/migrations/20261101120327_private_whatsapp_chat_memory.sql',import.meta.url),'utf8');
    const statement=migration.slice(migration.indexOf('select app.retain_private_invoice_terms(i.workspace_id'),migration.indexOf('-- Reversible'));
    await f.db.query('delete from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId]);await f.db.exec(statement);
    assert.equal(createPrivateValueMatcher((await f.db.query('select term from whatsapp_private_invoice_terms')).rows.map(row=>row.term))('Tell me about Second Company'),true);
    const before=f.providerRecord.calls;await f.turn('Tell me about İlker');assert.equal(f.providerRecord.calls,before,'exact original dotted-I name stays local after actual backfill');
  }finally{await f.close();}
});

test('F5 SQL/JS caseless/mark/whitespace/native-digit semantics and alias grammar stay identical',async()=>{
  const f=await fixture({recording:true});try{
    const corpus=['İlker','Ilker','ılker','I\u0307lker','I\u0345lker','Élodie','E\u0301LODIE','Straße','STRASSE','ΟΣ','ος','a\u0085b','a\u00a0b','a\u200bb','a\u200db','१२५०','١٢٥٠','𝟙𝟚𝟝𝟘'];
    const rows=(await f.db.query('select input,app.private_invoice_normalize(input) normalized from unnest($1::text[]) input',[corpus])).rows;
    for(const {input,normalized} of rows)assert.equal(normalized,normalizePrivateValue(input),input);
    for(const raw of ['₹1.250,00','$1250','€1 250','£1250.00','-1250','(1250)','1.25k','one thousand, two hundred & fifty','one point two five thousand','one and a quarter thousand','twelve and a half hundred','١٬٢٥٠','١٢٥٠٫٠٠','31/10/26','31.10','10-31','31 Oct 2025','INV–2026–0142']){
      const aliases=(await f.db.query('select app.private_invoice_term_aliases($1) term',[raw])).rows.map(row=>row.term);
      for(const current of [...cases,'2025-10-31','2027-10-31','2026-10-31','1250','12500','INV/2026/0142']){
        assert.equal(createPrivateValueMatcher(aliases)(current),createPrivateValueMatcher([raw])(current),JSON.stringify({raw,current,aliases}));
      }
    }
    const pivot=createPrivateValueMatcher(['2069-10-31','1970-11-01']);assert.equal(pivot('31/10/69'),true);assert.equal(pivot('1/11/70'),true);
    for(const fn of ['private_invoice_normalize','private_invoice_number_aliases','private_invoice_word_number_aliases','private_invoice_term_aliases','private_invoice_evidence_aliases']){
      const meta=(await f.db.query("select provolatile,prosecdef,proconfig from pg_proc where oid=$1::regprocedure",['app.'+fn+'(text)'])).rows[0];
      assert.equal(meta.provolatile,'i');assert.equal(meta.prosecdef,false);assert.deepEqual(meta.proconfig,['search_path=""']);
      for(const role of ['anon','authenticated','service_role'])assert.equal((await f.db.query("select has_function_privilege($1,$2,'execute') allowed",[role,'app.'+fn+'(text)'])).rows[0].allowed,false);
    }
  }finally{await f.close();}
});

test('F10 both menus remain deterministic-local before/after upload with exhausted Cloudflare, either extraction flag',async()=>{
  const f=await fixture({recording:true,navigation:true});try{
    const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,
      providerFactory:()=>assert.fail('Customer menu cannot construct a provider, including during exhaustion')});
    for(const flag of [undefined,'offline']){
      if(flag===undefined)delete f.routeEnv.EXTRACTION_ROUTE;else f.routeEnv.EXTRACTION_ROUTE=flag;f.restart();
      for(const after of [false,true]){
        if(after)await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
        const before=f.providerRecord.calls;assert.match((await f.turn('menu')).answer,/Choose an invoice lookup|Finish or cancel/);assert.equal(f.providerRecord.calls,before);
        assert.match(await customer({...f.scope,messageId:'menu-'+flag+'-'+after,message:'menu'}),/outstanding balance/);
      }
    }
  }finally{await f.close();}
});

test('F11 fixture and production share the identical privacy request path for private/ordinary/mixed turns',async()=>{
  const f=await fixture({recording:true});try{
    await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,terms]);
    const observed=[];
    for(const factory of [fixtureHandler,productionHandler]){
      const payloads=[];const handler=factory({supabase:f.supabase,authorize:async()=>true,replyStore:null,logger:{info(){},warn(){},error(){}},
        providerFactory:()=>({async generate(request){payloads.push(JSON.parse(JSON.stringify(request.messages)));return {content:'A safe answer'};}})});
      const before=payloads.length;assert.equal((await handler({...f.scope,messageId:'paired-'+observed.length,message:'Explain 1250'})).answer,PRIVATE_CHAT_REPLY);assert.equal(payloads.length,before);
      assert.match((await handler({...f.scope,messageId:'mixed-pair-'+observed.length,message:'Help me plan a walk; 1250, 77'})).answer,/A safe answer/);
      assert.equal(payloads.at(-1).at(-1).content,'Help me plan a walk');observed.push(payloads.at(-1).at(-1));
    }
    assert.deepEqual(observed[0],observed[1]);
    execFileSync(process.execPath,['scripts/generate-private-value-unicode.mjs','--check']);
    execFileSync(process.execPath,['scripts/generate-private-value-sql.mjs','--check']);
  }finally{await f.close();}
});

test('F3 local OCR evidence and owner notes retain currency-symbol aliases before later chat',async()=>{
  const f=await fixture({recording:true});try{
    f.setPrinted('Invoice No: PRIVATE-RAW\nBill to: Anurag\nInvoice Date: 2026-10-20\nDue Date: 2026-10-31\nTotal: ₹1.250,00');
    await f.turn('We issued this invoice',{media:{bytes:png,mimeType:'image/png'}});
    const beforeCorrection=f.providerRecord.calls;
    const earlyTerms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
    assert.ok(earlyTerms.includes('number:1250'),'raw labelled evidence must retain the amount before any correction');
    await f.turn('Explain 1250');assert.equal(f.providerRecord.calls,beforeCorrection);
    await f.turn('set notes to ₹1.250,00');
    const aliases=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
    assert.ok(aliases.includes('number:1250'));const before=f.providerRecord.calls;
    await f.turn('Explain 1250');assert.equal(f.providerRecord.calls,before);
  }finally{await f.close();}
});

test('F7 actual owner agent forwards an ordinary issued result but blocks decoded newline values before a second request',async()=>{
  const f=await fixture({recording:true});try{
    await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,terms]);
    for(const detail of ['blue','1\n250','31/\n10/26']){
      const requests=[];const handler=productionHandler({supabase:f.supabase,replyStore:null,authorize:async()=>true,logger:{info(){},warn(){},error(){}},
        toolsFactory:()=>({definitions:[{type:'function',function:{name:'getAIProviderConfiguration',parameters:{type:'object'}}}],async execute(){return {ok:true,detail};}}),
        providerFactory:()=>({async generate(request){requests.push(JSON.parse(JSON.stringify(request.messages)));return requests.length===1?
          {content:'',toolCalls:[{id:'issued',type:'function',function:{name:'getAIProviderConfiguration',arguments:'{}'}}]}:{content:'A safe answer'};}})});
      await handler({...f.scope,message:'Which model is running?',messageId:'tool-newline-'+detail});
      assert.equal(requests.length,detail==='blue'?2:1,detail);
      if(detail!=='blue')assert.doesNotMatch(JSON.stringify(requests),/1250|1\\n250|31\/\\n10/);
    }
  }finally{await f.close();}
});

test('web Assistant uses the same real boundary, decoded memory and fail-closed private store without UI changes',async()=>{
  const {createAIHandler}=await import('../ai/routes.mjs');
  const f=await fixture({recording:true});try{
    await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,terms]);
    const requests=[];const store={role:'owner',workspaceId:f.scope.workspaceId,userId:f.scope.ownerId,
      getSettings:async()=>({primary_model:'@cf/meta/llama-3.3-70b-instruct-fp8-fast'}),query:async()=>[],
      privateChatMemory:({messageId})=>createPrivateChatMemory({supabase:f.supabase,scope:{workspaceId:f.scope.workspaceId,ownerId:f.scope.ownerId,audience:'owner',phone:'web:'+f.scope.ownerId,messageId}})};
    const handler=createAIHandler({authorize:async()=>store,providerFactory:()=>({async generate(request){requests.push(JSON.parse(JSON.stringify(request.messages)));return {content:'A safe answer'};}})});
    const call=async message=>{const response={setHeader(){},status(code){this.code=code;return this},json(data){this.data=data;return this}};
      await handler({method:'POST',query:{action:'assistant'},body:{workspaceId:f.scope.workspaceId,message,history:[{role:'user',content:'1250 PRIVATE-CALLER-TRANSCRIPT'}]}},response);return response;};
    for(const message of ['Explain 1250','The amounts are 1250, 77','31/10/26']){const before=requests.length;const result=await call(message);assert.equal(result.code,200);assert.equal(requests.length,before);}
    const reply=await call('Help me plan a walk; 1250, 77');assert.equal(reply.code,200);assert.equal(requests.at(-1).at(-1).content,'Help me plan a walk');
    assert.doesNotMatch(JSON.stringify(requests),/1250|PRIVATE-CALLER-TRANSCRIPT/);
    delete store.privateChatMemory;const before=requests.length;const failed=await call('Tell me about astronomy');assert.equal(failed.code,200);assert.equal(failed.data.readOnly,true);assert.match(failed.data.answer,/try|unavailable|couldn.t|can.t/i);assert.equal(requests.length,before);
  }finally{await f.close();}
});

test('private spans prevent splitting known fields into ordinary fragments, including overlaps and Unicode folds',async()=>{
  for(const stored of ['Help me plan a walk; 750','Company One, Branch Two','İlker\nCompany']){
    const h=boundary({stored:[stored,'750']});await h.provider(stored+'; 750').generate();assert.deepEqual(h.payloads,[],stored);
  }
  const h=boundary({stored:['Company One, Branch Two']});
  await h.provider('Help me plan a walk; Company One, Branch Two').generate();assert.equal(h.payloads[0].at(-1).content,'Help me plan a walk');
  const comma=boundary();await comma.provider('Help me plan a walk, 1250').generate();assert.equal(comma.payloads[0].at(-1).content,'Help me plan a walk');
  const fresh=boundary();await fresh.provider('Set notes to New Private, Company Ltd').generate();assert.deepEqual(fresh.payloads,[]);
  const prefix=boundary();await prefix.provider('Help me plan a walk; set notes to New Private, Company Ltd').generate();assert.equal(prefix.payloads[0].at(-1).content,'Help me plan a walk');
  const exception=boundary();await exception.provider('I care about work-life balance; set notes to New Private, Company Ltd').generate();assert.equal(exception.payloads[0].at(-1).content,'I care about work-life balance');
});

test('real web authorization adapter uses scoped service-only privacy memory after caller membership verification',async()=>{
  const {authorizeAIWorkspace}=await import('../ai/store.mjs');
  const f=await fixture({recording:true});try{
    await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,terms]);
    const fetchImpl=async(input,options)=>{
      const url=new URL(input instanceof Request?input.url:String(input));
      if(url.pathname==='/auth/v1/user')return Response.json({id:f.scope.ownerId});
      return f.fetchImpl(input,options);
    };
    const store=await authorizeAIWorkspace({headers:{authorization:'Bearer caller-fixture-token'}},f.scope.workspaceId,{env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'unit-public-key',SUPABASE_SERVICE_ROLE_KEY:'unit-service-key'},fetchImpl});
    const memory=store.privateChatMemory({messageId:'real-web-adapter'});
    assert.deepEqual(await memory.read('Help me plan a walk'),[]);assert.equal(memory.containsPrivate('1250, 77'),true);
    await memory.append('Help me plan a walk','A safe answer');
    const saved=(await f.db.query('select * from whatsapp_provider_memory where phone=$1',['web:'+f.scope.ownerId])).rows;
    assert.equal(saved.length,2);assert.ok(saved.every(row=>row.workspace_id===f.scope.workspaceId&&row.owner_id===f.scope.ownerId&&row.provenance==='ordinary_chat_v1'));
    const restarted=store.privateChatMemory({messageId:'web-restart'});assert.equal((await restarted.read('Hello')).length,2);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});


test('explicit printed-evidence provenance expands labelled and embedded monetary values with SQL/JS parity',async()=>{
  const f=await fixture({recording:true});try{
    for(const text of ['Total: ₹1.250,00','Total ₹1.250,00','Total₹1.250,00','Grand total was ₹1.250,00 plus tax','Amount: $1,250','Invoice total1250₹','Total: one thousand, two hundred & fifty','Due date: 31/10/26']){
      const aliases=(await f.db.query('select app.private_invoice_evidence_aliases($1) term',[text])).rows.map(row=>row.term);
      const match=createPrivateValueMatcher(['evidence:'+text]),retained=createPrivateValueMatcher(aliases);
      for(const probe of ['1250','12500','2026-10-31','2027-10-31'])assert.equal(retained(probe),match(probe),JSON.stringify({text,probe,aliases}));
      if(!text.startsWith('Due'))assert.ok(aliases.includes('number:1250'),text);
    }
    const colloquial=boundary({stored:['twelve fifty']});await colloquial.provider('send 62 today').generate();await colloquial.provider('twelve fifty one today').generate();assert.equal(colloquial.payloads.length,2);
    for(const stored of [['number:12.5'],['₹12.50']]){
      const h=boundary({stored});for(const value of ['12.5','12.50','12.500'])await h.provider('Explain '+value).generate();assert.deepEqual(h.payloads,[],'short-date ambiguity cannot suppress a retained amount');
    }
  }finally{await f.close();}
});

test('typed monetary values and printed amounts do not acquire lossy yearless date aliases',async()=>{
  const f=await fixture({recording:true});try{
    await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{amount:31.10,due_date:'2026-10-31',printedEvidence:{total:'Total: ₹31.10'}}]);
    const aliases=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(row=>row.term);
    assert.ok(aliases.includes('number:31.1'));assert.ok(!aliases.includes('date:*-10-31'));
    for(const stored of [aliases,['evidence:Total: ₹31.10','2026-10-31']]){
      const h=boundary({stored});
      for(const value of ['2027-10-31','31 Oct 2025'])await h.provider('Explain '+value).generate();
      assert.equal(h.payloads.length,2);
      for(const value of ['31.1','₹31.10','2026-10-31','31/10'])await h.provider('Explain '+value).generate();
      assert.equal(h.payloads.length,2);
    }
  }finally{await f.close();}
});
