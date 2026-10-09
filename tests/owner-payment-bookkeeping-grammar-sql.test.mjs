import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {requestedOwnerPayment,ownerPaymentAmountMentioned} from '../automation/whatsapp/owner-payment-intent.mjs';
import {ownerPartialPaymentAvailable} from '../automation/whatsapp/owner-payment-readback.mjs';
import {createOwnerDirectRuntime} from '../automation/whatsapp/owner-direct-runtime.mjs';
import {invoiceReviewClarification} from '../automation/whatsapp/assistant-handler.mjs';
const migration='20261009202000_owner_payment_bookkeeping_instruction.sql';
const exact='Record a USD 40 partial bookkeeping payment on the disposable QA invoice INV-2026-6771. Leave USD 60 outstanding. Keep reminders paused and do not contact anyone.';
const targets=['app.owner_payment_instruction(text)','app.owner_payment_amount_mentioned(text)','public.whatsapp_owner_partial_payment_capability()','public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)','public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'];
const routines=f=>f.db.query('select oid::text id,md5(prosrc) hash,proacl::text acl,proowner::text owner,prosecdef definer,proconfig config from pg_proc where oid=any($1::regprocedure[]) order by oid',[targets]).then(r=>r.rows);
test('bookkeeping payment grammar and deny-only detection match SQL for exact and ordinary variants',async()=>{
 const f=await createOfflineSqlNetwork();try{
  for(const qualifier of ['partial bookkeeping ','bookkeeping ','partial ',''])for(const reference of ['the disposable QA invoice INV-2026-6771','invoice INV-2026-6771','invoice INV-2026-6771 for QA Fixture Customer'])for(const quiet of ['Keep reminders paused and do not contact anyone.','Keep reminders paused.','Do not contact anyone.'])for(const prefix of [`Record a USD 40 ${qualifier}payment on `,`Please log a ${qualifier}payment of USD 40 for `]){
   const text=prefix+reference+'. Leave USD 60 outstanding. '+quiet;
   const facts=requestedOwnerPayment(text);assert.deepEqual(facts,{amount:40,currency:'USD',invoiceNumber:'INV-2026-6771',customerName:reference.includes(' for ')?'QA Fixture Customer':null,expectedOutstanding:60,instructionVersion:5},text);
   assert.deepEqual((await f.db.query('select app.owner_payment_instruction($1) value',[text])).rows[0].value,facts,text);
   assert.equal(ownerPaymentAmountMentioned(text),true);assert.equal((await f.db.query('select app.owner_payment_amount_mentioned($1) value',[text])).rows[0].value,true);
  }
  for(const text of [exact.replace('USD 40','USD 40 or EUR 40'),exact.replace('USD 60','EUR 60'),exact+' Refund USD 1.',exact+' Send a receipt.',exact.replace('Record','Do not record'),exact.replace('INV-2026-6771.','INV-2026-6771 or INV-2026-6772.'),exact+' Keep reminders paused.', 'He said "'+exact+'"']){
   assert.equal(requestedOwnerPayment(text),null,text);assert.equal((await f.db.query('select app.owner_payment_instruction($1) value',[text])).rows[0].value,null,text);assert.equal(ownerPaymentAmountMentioned(text),true);
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('extended instruction requires proven feature while legacy instructions retain capability4 compatibility',async()=>{
 for(const data of [{ok:true,version:4},{ok:true,version:4,bookkeepingInstructions:1},{ok:true,version:4,bookkeepingInstructions:2},{ok:true,version:3,bookkeepingInstructions:1},{ok:false,version:4,bookkeepingInstructions:1}]){
  const supabase={rpc:async()=>({data,error:null})};assert.equal(await ownerPartialPaymentAvailable(supabase),data.ok&&data.version===4);assert.equal(await ownerPartialPaymentAvailable(supabase,5),data.ok&&data.version===4&&data.bookkeepingInstructions===1);
 }
});
test('forward bookkeeping migration preserves security and business rows, reapplies, and rejects any source drift atomically',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[migration]});try{
  const owner=randomUUID();await f.db.query('insert into auth.users(id) values($1)',[owner]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const workspace=(await f.db.query("select (create_workspace('Bookkeeping migration fixture',$1)).id",[randomUUID()])).rows[0].id;
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const client=(await f.db.query("insert into customers(workspace_id,name) values($1,'QA fixture') returning id",[workspace])).rows[0].id;
  await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,metadata) values($1,$2,'AUTO',100,'USD','draft',$3)",[workspace,client,{invoice_direction:'receivable',source_document:{name:'original.jpg'},followup_state:'paused',next_follow_up_at:null}]);
  const sql=await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'),before=await routines(f);
  const state=()=>f.db.query("select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(i)) from invoices i),'payments',(select jsonb_agg(to_jsonb(p)) from payments p),'pending',(select jsonb_agg(to_jsonb(p)) from whatsapp_pending_actions p),'outbound',(select count(*) from whatsapp_messages)) value").then(r=>r.rows[0].value),rows=await state();
  assert.doesNotMatch(sql,/^\s*(?:grant|revoke|insert|update|delete)\b/im);await f.db.exec(sql);const after=await routines(f);
  assert.equal(after.filter(r=>r.hash!==before.find(b=>b.id===r.id).hash).length,3);assert.deepEqual(after.map(({hash,...s})=>s),before.map(({hash,...s})=>s));assert.deepEqual(await state(),rows);
  assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:4,bookkeepingInstructions:1});await f.db.exec(sql);assert.deepEqual(await routines(f),after);
  for(const target of targets){
   const original=(await f.db.query('select pg_get_functiondef($1::regprocedure) definition',[target])).rows[0].definition,end=original.lastIndexOf('$function$');
   await f.db.exec(original.slice(0,end)+'\n-- isolated drift\n'+original.slice(end));const drifted=await routines(f);
   await assert.rejects(()=>f.db.exec(sql),/Unexpected installed owner payment source/);await f.db.exec('rollback');assert.deepEqual(await routines(f),drifted);assert.deepEqual(await state(),rows);await f.db.exec(original);
  }
  const wrong=sql.replace("oid=parser)<>'3950ab33319643e13ef318190bf51ad0'","oid=parser)<>'00000000000000000000000000000000'");assert.notEqual(wrong,sql);await assert.rejects(()=>f.db.exec(wrong),/installed source verification failed/);await f.db.exec('rollback');assert.deepEqual(await routines(f),after);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('issuer clarification asks directly and preserves other missing facts',()=>{
 const answer=invoiceReviewClarification({missingFields:['direction','currency']});assert.match(answer,/Please confirm that your business issued this invoice\./);assert.match(answer,/explicit currency code/);assert.doesNotMatch(answer,/confirm the confirmation|clearer photo/);assert.match(answer,/Nothing was saved/);
});
test('forward bookkeeping migration accepts uniform CRLF but rejects mixed line endings',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[migration]});try{
  const sql=await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8');
  for(const target of targets){const definition=(await f.db.query('select pg_get_functiondef($1::regprocedure) definition',[target])).rows[0].definition;await f.db.exec(definition.replace(/\n/g,'\r\n'));}
  await f.db.exec(sql);assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:4,bookkeepingInstructions:1});
  const original=(await f.db.query('select pg_get_functiondef($1::regprocedure) definition',[targets[0]])).rows[0].definition;
  await f.db.exec(original.replace('$function$\n','$function$\r\n'));const drifted=await routines(f);
  await assert.rejects(()=>f.db.exec(sql),/Unexpected installed owner payment line endings/);await f.db.exec('rollback');assert.deepEqual(await routines(f),drifted);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('button confirmation repeats feature proof and keeps legacy confirmation compatible',async()=>{
 for(const feature of [undefined,1,2])for(const instructionVersion of [undefined,5]){
  let mutations=0;const runtime=createOwnerDirectRuntime({supabase:{rpc:async()=>({data:{ok:true,version:4,bookkeepingInstructions:feature},error:null})},scope:{workspaceId:'fixture',ownerId:'fixture',phone:'+12025550100'},messageId:'button-fixture',message:'',authorize:async()=>true,adapter:{apply:async()=>{mutations++;return {ok:true};}}});
  const result=await runtime.decideButton({interactionId:'fixture',decision:'confirm',pending:{id:1,version:1,action:{type:'owner_invoice_payment',instructionVersion,changes:{amount:40}}}});
  const allowed=instructionVersion!==5||feature===1;assert.equal(mutations,allowed?1:0);assert.equal(result.ok,allowed);
 }
});
