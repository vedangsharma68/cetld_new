import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseTally,MAX_BYTES} from '../integrations/tally.mjs';
import {createTallyHandler} from '../api/tally-import.js';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
const csv='Voucher Number,Party Ledger Name,Date,Amount,GUID\nS-1,"Acme, Ltd",20261001,123.45,v-1';
test('CSV quoted fields, XML ledger masters and sales voucher party total',()=>{
 const p=parseTally('sales.csv',csv);assert.equal(p.errors.length,0);assert.equal(p.customers[0].name,'Acme, Ltd');assert.equal(p.invoices[0].issueDate,'2026-10-01');
 const xml='<ENVELOPE><LEDGER NAME="Acme &amp; Co"><PARENT>Sundry Debtors</PARENT><GUID>c-1</GUID></LEDGER><VOUCHER VCHTYPE="Sales"><DATE>20261001</DATE><VOUCHERNUMBER>S-2</VOUCHERNUMBER><GUID>v-2</GUID><PARTYLEDGERNAME>Acme &amp; Co</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme &amp; Co</LEDGERNAME><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>80</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
 const x=parseTally('masters.xml',xml);assert.equal(x.errors.length,0);assert.equal(x.customers.length,1);assert.equal(x.customers[0].guid,'c-1');assert.equal(x.invoices[0].total,'100');assert.equal(x.invoices[0].guid,'v-2');
});
test('bad file, malformed CSV/XML, row and file caps and invalid invoice validation',()=>{
 for(const [name,body] of [['x.xlsx','abc'],['x.xml','<!DOCTYPE x><x/>'],['x.xml','<x><y></x>'],['x.csv','Name\n"oops'],['x.csv','Name\nx,y'],['x.csv','x'.repeat(MAX_BYTES+1)],['x.csv','Name\n'+'a\n'.repeat(2001)]])assert.throws(()=>parseTally(name,body));
 assert.ok(parseTally('x.csv','Voucher Number,Customer,Date,Amount\nx,c,20260230,-1').errors.length);
});
test('preview classifies records without writes; confirm binds file and plan, stale plans require preview',async()=>{
 let writes=0,stale=false;const calls=[],workspaceId=randomUUID();
 const plan={workspaceCurrency:'EUR',planHash:'plan-1',customers:[],invoices:[],counts:{customers:{created:1,skipped:0,failed:0},invoices:{created:1,skipped:0,failed:0}}};
 const handler=createTallyHandler({authorize:async()=>({role:'owner'}),fetchImpl:async(url,init)=>{
  if(!init.body)return Response.json([{default_currency:'EUR'}]);
  const input=JSON.parse(init.body);calls.push({url,input});
  if(url.endsWith('preview_tally'))return Response.json(plan);
  if(stale)return Response.json({code:'40001'},{status:400});
  writes++;return Response.json({ok:true});
 },env:{SUPABASE_URL:'https://example.test',SUPABASE_PUBLISHABLE_KEY:'test'}});
 const run=async(body,h=handler)=>{const res={status(n){this.code=n;return this},json(v){this.body=v;return this}};await h({method:'POST',headers:{authorization:'Bearer fixture'},body:{workspaceId,filename:'x.csv',content:csv,...body}},res);return res};
 const preview=await run({action:'preview'});assert.equal(preview.code,200);assert.equal(writes,0);assert.equal(preview.body.plan.counts.invoices.created,1);assert.equal(calls[0].input.p_invoices[0].currency,'EUR');
 assert.equal((await run({action:'confirm',previewId:'bad',planHash:'plan-1'})).code,400);assert.equal(writes,0);
 assert.equal((await run({action:'confirm',previewId:preview.body.previewId,planHash:'plan-1'})).code,200);assert.equal(writes,1);assert.equal(calls.at(-1).input.p_expected_hash,'plan-1');assert.equal(calls.at(-1).input.p_expected_plan,undefined);
 stale=true;assert.equal((await run({action:'confirm',previewId:preview.body.previewId,planHash:'plan-1'})).code,409);assert.equal(writes,1);
 const mixed=await run({action:'preview',content:'Voucher Number,Customer,Date,Amount,Currency\nUS-1,C,20261001,10,USD\nEU-1,D,20261001,20,EUR'});assert.match(mixed.body.warnings[0],/never converted/);assert.deepEqual(calls.at(-1).input.p_invoices.map(i=>i.currency),['USD','EUR']);
 const badContent='Voucher Number,Customer,Date,Amount\nx,c,bad,10';const bad=await run({action:'preview',content:badContent});assert.ok(bad.body.errors.length);
 assert.equal((await run({action:'confirm',content:badContent,previewId:bad.body.previewId,planHash:'plan-1'})).code,400);
 assert.equal((await run({action:'preview'},createTallyHandler({authorize:async()=>({role:'member'})}))).code,403);
});
test('real database import is idempotent by GUID or source number plus customer, owner scoped and reports failures',async()=>{
 const f=await createOfflineSqlNetwork();try{
 const owner=randomUUID(),other=randomUUID();await f.db.query('insert into auth.users(id) values($1),($2)',[owner,other]);
 const identity=async id=>{await f.db.exec('reset role');await f.db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[id]);await f.db.exec('set role authenticated')};
 await identity(owner);const ws=(await f.db.query('select (public.create_workspace($1,$2)).id',['Tally',randomUUID()])).rows[0].id;
 const p=parseTally('x.csv',csv);p.customers[0].guid='c-1';p.customers[0].originalId='33';const run=async(data=p)=>{const plan=(await f.db.query('select public.preview_tally($1,$2,$3) value',[ws,data.customers,data.invoices])).rows[0].value;return (await f.db.query('select public.import_tally($1,$2,$3,$4) value',[ws,data.customers,data.invoices,plan.planHash])).rows[0].value};
 let result=await run();assert.deepEqual(result.customers,{created:1,skipped:0,failed:0});assert.deepEqual(result.invoices,{created:1,skipped:0,failed:0});
 result=await run();assert.equal(result.invoices.skipped,1);assert.equal(result.customers.skipped,1);
 const customer=(await f.db.query('select metadata from customers where workspace_id=$1',[ws])).rows[0];assert.equal(customer.metadata.tally.guid,'c-1');assert.equal(customer.metadata.tally.original_id,'33');
 result=await run({...p,invoices:[{...p.invoices[0],number:'CHANGED'}]});assert.equal(result.invoices.skipped,1);
 result=await run({...p,invoices:[{...p.invoices[0],guid:''}]});assert.equal(result.invoices.skipped,1);
 const row=(await f.db.query('select * from invoices where workspace_id=$1',[ws])).rows[0];assert.equal(row.metadata.source,'tally');assert.equal(row.metadata.bookkeeping_origin,'tally');assert.equal(row.metadata.accounting_provider,undefined);assert.equal(row.metadata.source_invoice_number,'S-1');assert.equal(row.status,'draft');
 result=await run({...p,invoices:[{...p.invoices[0],guid:'bad',number:'bad',total:'-1'}]});assert.equal(result.invoices.failed,1);
 await identity(other);await assert.rejects(run(),{code:'42501'});
 }finally{await f.close()}
});
test('XML ignores purchase, cancelled and optional vouchers and non-customer ledgers',()=>{
 const xml='<E><LEDGER NAME="Supplier"><PARENT>Sundry Creditors</PARENT></LEDGER><VOUCHER VCHTYPE="Purchase"/><VOUCHER VCHTYPE="Sales"><ISCANCELLED>Yes</ISCANCELLED></VOUCHER><VOUCHER VCHTYPE="Sales"><ISOPTIONAL>Yes</ISOPTIONAL></VOUCHER></E>';
 const result=parseTally('x.xml',xml);assert.equal(result.counts.customers,0);assert.equal(result.counts.invoices,0);assert.ok(result.errors.length);
});

import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('// Tally is an explicit import'));
function fixture(){
 const calls=[],listeners={},review={innerHTML:'',textContent:''},error={textContent:''},submit={disabled:false,textContent:''};
 const input={disabled:false,files:[{name:'tally.csv',size:20,arrayBuffer:async()=>new TextEncoder().encode('Name\nAcme').buffer}],addEventListener(name,fn){listeners[name]=fn}};
 const form={isConnected:true,elements:{file:input},querySelector:s=>s==='[type="submit"]'?submit:s==='#tally-review'?review:error,addEventListener(name,fn){listeners[name]=fn}};
 const context={TextDecoder,Uint8Array,state:{workspace:{id:'workspace',owner_id:'owner'},user:{id:'owner'}},document:{addEventListener(name,fn){listeners.click=fn}},
 $:s=>s==='#tally-import-form'?form:review,openDialog(){},toast(){},accessToken:async()=>'token',loadData:async()=>{},escape:s=>String(s).replaceAll('<','&lt;'),
 fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return {ok:true,json:async()=>body.action==='preview'?{plan:{planHash:'plan-1',counts:{customers:{created:1,skipped:0,failed:0},invoices:{created:0,skipped:0,failed:0}},customers:[{name:'<Acme>',action:'create'}],invoices:[]},errors:[],warnings:[],previewId:'digest'}:{customers:{created:1,skipped:0,failed:0},invoices:{created:0,skipped:0,failed:0},failures:[]}}}};
 vm.runInNewContext(source,context);listeners.click({target:{closest:()=>({})}});
 return {calls,listeners,review,error,submit,input,context};
}
test('actual dialog previews without confirming, escapes rows, then imports only on second submit',async()=>{
 const f=fixture();await f.listeners.submit({preventDefault(){}});assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'preview');assert.equal(f.submit.textContent,'Confirm import');assert.match(f.review.innerHTML,/&lt;Acme>/);assert.doesNotMatch(f.review.innerHTML,/<Acme>/);
 await f.listeners.submit({preventDefault(){}});assert.equal(f.calls[1].action,'confirm');assert.equal(f.calls[1].previewId,'digest');assert.equal(f.calls[1].planHash,'plan-1');assert.equal(f.calls[1].plan,undefined);assert.equal(f.calls[1].workspaceId,'workspace');assert.match(f.review.innerHTML,/1 created/);assert.equal(f.input.disabled,false);
});
test('changing files clears confirmation; workspace changes and unsupported formats block requests',async()=>{
 const f=fixture();await f.listeners.submit({preventDefault(){}});f.listeners.change();assert.equal(f.submit.textContent,'Preview import');await f.listeners.submit({preventDefault(){}});assert.equal(f.calls[1].action,'preview');
 f.context.state.workspace.id='other';await f.listeners.submit({preventDefault(){}});assert.equal(f.calls.length,2);assert.equal(f.input.disabled,false);
 const g=fixture();g.input.files[0].name='bad.xlsx';await g.listeners.submit({preventDefault(){}});assert.equal(g.calls.length,0);assert.match(g.error.textContent,/Unsupported format/);
});

test('late confirmation cannot populate a detached or changed workspace dialog',async()=>{
 const f=fixture();await f.listeners.submit({preventDefault(){}});let finish;
 f.context.fetch=()=>new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({customers:{created:1,skipped:0,failed:0},invoices:{created:0,skipped:0,failed:0}})})});
 const confirming=f.listeners.submit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));f.context.state.workspace.id='different';const before=f.review.innerHTML;finish();await confirming;assert.equal(f.review.innerHTML,before);
});
test('a valid file at the cap previews and confirms within the Vercel payload limit without echoing the plan',async()=>{
 const prefix='Name,GSTIN\nAcme,"',content=prefix+'\n'.repeat(MAX_BYTES-prefix.length-1)+'"',workspaceId=randomUUID();
 const plan={planHash:'cap-plan',workspaceCurrency:'INR',customers:[{name:'Acme',action:'create'}],invoices:[],counts:{customers:{created:1,skipped:0,failed:0},invoices:{created:0,skipped:0,failed:0}}};
 let writes=0;
 const handler=createTallyHandler({authorize:async()=>({role:'owner'}),fetchImpl:async(url,init)=>{
  if(!init.body)return Response.json([{default_currency:'INR'}]);
  assert.ok(Buffer.byteLength(init.body)<10000,'ignored source tax data is not sent to the database');
  if(url.endsWith('preview_tally'))return Response.json(plan);writes++;return Response.json({ok:true});
 },env:{SUPABASE_URL:'https://example.test',SUPABASE_PUBLISHABLE_KEY:'test'}});
 const run=async extra=>{const body=JSON.stringify({workspaceId,filename:'cap.csv',content,...extra});assert.ok(Buffer.byteLength(body)<4.5*1024*1024);const res={status(n){this.code=n;return this},json(value){this.body=value;return this}};await handler({method:'POST',headers:{authorization:'Bearer fixture'},body},res);return res};
 const preview=await run({action:'preview'});assert.equal(preview.code,200);assert.equal(writes,0);
 assert.equal((await run({action:'confirm',previewId:preview.body.previewId,planHash:plan.planHash})).code,200);assert.equal(writes,1);
});
test('oversized normalized data below the source cap fails clearly before an RPC or write',async()=>{
 const content='Voucher Number,Customer,Date,Amount,GUID\n'+Array.from({length:2000},(_,i)=>`S-${i},${'\\'.repeat(190)+i},20261001,100,${'\\'.repeat(800)}`).join('\n');
 assert.ok(Buffer.byteLength(content)<MAX_BYTES);let rpcCalls=0;
 const handler=createTallyHandler({authorize:async()=>({role:'owner'}),fetchImpl:async(url)=>{if(url.includes('/rpc/'))rpcCalls++;return Response.json([{default_currency:'INR'}])},env:{SUPABASE_URL:'https://example.test',SUPABASE_PUBLISHABLE_KEY:'test'}});
 const res={status(n){this.code=n;return this},json(value){this.body=value;return this}};
 await handler({method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({action:'preview',workspaceId:randomUUID(),filename:'large.csv',content})},res);
 assert.equal(res.code,400);assert.match(res.body.error,/normalized import is too large.*fewer rows/);assert.equal(rpcCalls,0);
});
