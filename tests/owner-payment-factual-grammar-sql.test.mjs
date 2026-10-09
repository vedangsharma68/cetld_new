import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {requestedOwnerPayment,ownerPaymentAmountMentioned} from '../automation/whatsapp/owner-payment-intent.mjs';
import {ownerPartialPaymentAvailable} from '../automation/whatsapp/owner-payment-readback.mjs';
const migration='20261009015001_owner_payment_factual_instruction.sql';
const migrationPath=new URL('../supabase/migrations/'+migration,import.meta.url);
const exact='Record a USD 500 partial payment on the dummy Northwind Systems LLC invoice SB-10442. Leave USD 451.52 outstanding. This is a test bookkeeping entry; do not send any customer messages or reminders.';
const base='Record a USD 500 partial payment on invoice SB-10442 for Northwind Systems LLC.';
const targets=[
 'app.owner_payment_instruction(text)',
 'public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)',
 'public.whatsapp_owner_partial_payment_capability()',
 'public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)',
 'app.owner_payment_amount_mentioned(text)',
];
const routines=f=>f.db.query('select oid::text id,md5(prosrc) hash,proacl::text acl,proowner::text owner,prosecdef definer,proconfig config from pg_catalog.pg_proc where oid=any($1::regprocedure[]) order by oid',[targets]).then(r=>r.rows);
const sqlFacts=(f,text)=>f.db.query('select app.owner_payment_instruction($1) value',[text]).then(r=>r.rows[0].value);

test('bounded factual payment/reference/clause composition is equivalent in JavaScript and PostgreSQL',async()=>{
 const f=await createOfflineSqlNetwork();try{
  assert.deepEqual(requestedOwnerPayment(exact),{amount:500,currency:'USD',invoiceNumber:'SB-10442',customerName:'Northwind Systems LLC',expectedOutstanding:451.52});
  assert.deepEqual(await sqlFacts(f,exact),requestedOwnerPayment(exact));
  const references=[
   ['invoice SB-10442',null],['invoice #SB-10442 for Northwind Systems LLC','Northwind Systems LLC'],
   ['the dummy Northwind Systems LLC invoice number SB-10442','Northwind Systems LLC'],
   ['the test invoice no. SB-10442 for Northwind Systems LLC','Northwind Systems LLC'],
   ['Northwind Systems LLC invoice ref SB-10442','Northwind Systems LLC'],
   ['invoice reference SB-10442 for Northwind Systems LLC','Northwind Systems LLC'],
  ];
  const commands=['Record a USD 500 partial payment on ','Please log a payment of USD 500 against ','Register a USD 500 test payment for '];
  const tails=[
   ['',false],['Leave USD 451.52 outstanding.',true],['Keep USD 451.52 remaining.',true],
   ['This is only a dummy bookkeeping entry. Keep customer messages and reminders off.',false],
   ['This is a test bookkeeping entry; do not send any customer messages or reminders.',false],
   ['No customer messages or reminders. This is a dummy bookkeeping entry only; leave USD 451.52 outstanding.',true],
   ['Leave USD 451.52 outstanding. This is a test bookkeeping entry. No messages or reminders. Please.',true],
  ];
  for(const [reference,customerName] of references)for(const command of commands)for(const [tail,remainder] of tails){
   const text=command+reference+'.'+(tail?' '+tail:'');
   const expected={amount:500,currency:'USD',invoiceNumber:'SB-10442',customerName,...(remainder?{expectedOutstanding:451.52}:{})};
   assert.deepEqual(requestedOwnerPayment(text),expected,text);assert.deepEqual(await sqlFacts(f,text),expected,text);
  }
  for(const text of [
   'For invoice number RW-24 for Riverside Studio, please log a payment of CHF 12.25. Leave CHF 29.75 outstanding. No customer messages or reminders.',
   'Please for test Riverside Studio invoice #RW-24, register a CHF 12.25 partial payment. Keep CHF 29.75 remaining.',
  ]){
   const expected={amount:12.25,currency:'CHF',invoiceNumber:'RW-24',customerName:'Riverside Studio',expectedOutstanding:29.75};
   assert.deepEqual(requestedOwnerPayment(text),expected,text);assert.deepEqual(await sqlFacts(f,text),expected,text);
  }
  for(const text of [base.replace(/\.$/,', please.'),base+' Please.',base.replace('USD 500','usd 0.01')+' Keep USD 0 remaining.',base.replace('USD 500','USD 999999999999.99')]){
   assert.notEqual(requestedOwnerPayment(text),null,text);assert.deepEqual(await sqlFacts(f,text),requestedOwnerPayment(text),text);
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('unsupported authority, ambiguous amounts/references and extra instructions fail closed in both parsers',async()=>{
 const f=await createOfflineSqlNetwork();try{
  const negatives=[
   'He said "'+exact+'"','Yesterday I '+exact,'Can I '+exact,'Do not '+exact,'Never '+exact,
   exact.replace('Record','Refund'),exact.replace('partial payment','partial transfer'),exact.replace('USD 500','USD 500 or EUR 500'),
   exact.replace('USD 500','USD 0'),exact.replace('USD 500','USD -500'),exact.replace('USD 500','USD 500.001'),exact.replace('USD 500','USD 1e3'),
   exact.replace('USD 451.52 outstanding','EUR 451.52 outstanding'),exact.replace('USD 451.52 outstanding','USD -1 outstanding'),
   exact+' Leave USD 451.52 outstanding.',exact+' Leave USD 0 outstanding.',exact+' Send the customer a receipt.',
   exact.replace('do not send any customer messages or reminders','send customer messages and reminders'),
   exact.replace('SB-10442.','SB-10442 or SB-10443.'),exact.replace('SB-10442.','SB-10442 for Another Customer.'),
   exact.replace('Leave USD 451.52 outstanding.','Leave the rest outstanding.'),exact.replace('Leave USD 451.52 outstanding.','Leave USD 451.520 outstanding.'),
   base+' Instead record USD 600.',base+' "This is a test bookkeeping entry."',base.replace(/\.$/,'?'),
   'Record a partial payment of 500 on invoice SB-10442.','Record a USD 500 partial payment for this invoice.',
   'For invoice SB-10442, record a partial payment of USD 500 or EUR 500.',
   base+' No customer messages or reminders. Keep customer messages and reminders off.',
  ];
  for(const text of negatives){assert.equal(requestedOwnerPayment(text),null,text);assert.equal(await sqlFacts(f,text),null,text);}
  assert.equal(ownerPaymentAmountMentioned(exact),true);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('capability helper accepts only the complete version 4 proof',async()=>{
 for(const data of [{ok:true,version:1},{ok:true,version:2},{ok:true,version:3},{ok:true,version:4},{ok:false,version:4},null]){
  assert.equal(await ownerPartialPaymentAvailable({rpc:async()=>({data,error:null})}),data?.ok===true&&data?.version===4);
 }
 assert.equal(await ownerPartialPaymentAvailable({rpc:async()=>{throw Error('offline');}}),false);
 assert.equal(await ownerPartialPaymentAvailable({rpc:async()=>({data:{ok:true,version:4},error:{code:'offline'}})}),false);
});

test('forward payment migration preserves rows and routine security, reapplies exactly, and rejects drift atomically',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[migration]});try{
  const owner=randomUUID();await f.db.query('insert into auth.users(id) values($1)',[owner]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const workspace=(await f.db.query("select (create_workspace('Migration fixture',$1)).id",[randomUUID()])).rows[0].id;
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const client=(await f.db.query("insert into customers(workspace_id,name) values($1,'Migration Customer') returning id",[workspace])).rows[0].id;
  await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,metadata) values($1,$2,'AUTO',42,'CHF','draft',$3)",[workspace,client,{invoice_direction:'receivable',source_document:{name:'source.pdf'},followup_state:'paused',next_follow_up_at:null}]);
  const snapshot=()=>f.db.query("select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(i)) from invoices i),'customers',(select jsonb_agg(to_jsonb(c)) from customers c),'payments',(select jsonb_agg(to_jsonb(p)) from payments p),'pending',(select jsonb_agg(to_jsonb(a)) from whatsapp_pending_actions a),'outbound',(select count(*) from whatsapp_messages where audience='customer')) value").then(r=>r.rows[0].value);
  const before=await routines(f),state=await snapshot(),sql=await readFile(migrationPath,'utf8');
  assert.doesNotMatch(sql,/^\s*(?:grant|revoke|insert|update|delete)\b/im);
  assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:3});
  await f.db.exec(sql);const after=await routines(f);
  assert.deepEqual(after.map(({hash,...security})=>security),before.map(({hash,...security})=>security));
  assert.equal(after.filter(row=>row.hash!==before.find(old=>old.id===row.id).hash).length,3);
  assert.deepEqual(await snapshot(),state);assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:4});
  await f.db.exec(sql);assert.deepEqual(await routines(f),after);assert.deepEqual(await snapshot(),state);
  for(const target of targets){
   const original=(await f.db.query('select pg_catalog.pg_get_functiondef($1::regprocedure) definition',[target])).rows[0].definition;
   const end=original.lastIndexOf('$function$');assert.ok(end>0);
   await f.db.exec(original.slice(0,end)+'\n-- isolated drift\n'+original.slice(end));const drifted=await routines(f);
   assert.equal((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value.ok,target===targets[2]);
   await assert.rejects(()=>f.db.exec(sql),/Unexpected installed owner payment source/);await f.db.exec('rollback');
   assert.deepEqual(await routines(f),drifted);assert.deepEqual(await snapshot(),state);await f.db.exec(original);
  }
  assert.deepEqual(await routines(f),after);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('uniform CRLF predecessors and successors verify, while mixed endings and a wrong final pin roll back',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[migration]});try{
  const sql=await readFile(migrationPath,'utf8');
  const definition=target=>f.db.query('select pg_catalog.pg_get_functiondef($1::regprocedure) definition',[target]).then(r=>r.rows[0].definition);
  for(const target of targets)await f.db.exec((await definition(target)).replace(/\n/g,'\r\n'));
  await f.db.exec(sql);assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:4});
  for(const target of targets)await f.db.exec((await definition(target)).replace(/\r\n/g,'\n').replace(/\n/g,'\r\n'));
  const successor=await routines(f);await f.db.exec(sql);
  assert.deepEqual((await routines(f)).map(({hash,...security})=>security),successor.map(({hash,...security})=>security));
  assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:4});
  const before=await routines(f);
  const wrongPin=sql.replace("oid=parser)<>'dd97384b7b854a80c68357b6afa68ca5'","oid=parser)<>'00000000000000000000000000000000'");
  assert.notEqual(wrongPin,sql);await assert.rejects(()=>f.db.exec(wrongPin),/installed source verification failed/);await f.db.exec('rollback');assert.deepEqual(await routines(f),before);
  const original=await definition(targets[0]),mixed=original.replace('$function$\n','$function$\r\n');assert.notEqual(mixed,original);
  await f.db.exec(mixed);const drifted=await routines(f);await assert.rejects(()=>f.db.exec(sql),/Unexpected installed owner payment line endings/);await f.db.exec('rollback');assert.deepEqual(await routines(f),drifted);
 }finally{await f.close();}
});
