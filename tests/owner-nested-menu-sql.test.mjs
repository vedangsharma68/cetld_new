import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';
import {planOwnerNextActions} from '../automation/whatsapp/owner-next-actions.mjs';
import {createOwnerReplyStore} from '../automation/whatsapp/owner-reply-store.mjs';

const migration=new URL('../supabase/migrations/20261006172223_owner_nested_edit_menus.sql',import.meta.url);

test('real default owner handler and SQL receipts preserve nested paid/open menus, replay, return navigation and expiry',async t=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,owner=randomUUID(),phone='+919871367051';
 let elapsed=0,modelCalls=0;const start=Date.now(),clock=()=>new Date(start+elapsed);
 const env={NODE_ENV:'test',WHATSAPP_APP_SECRET:'isolated-nested-menus'};
 const logger={info(){},warn(){},error(){}};
 try{
  await db.query('insert into auth.users(id) values($1)',[owner]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const ws=(await db.query("select (create_workspace('Nested menu fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[ws,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) v',[phone,verification.code])).rows[0].v.ok,true);
  const binding=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  const scope={workspaceId:ws,ownerId:owner,customerId:binding.customer_id,phone};
  await db.exec('reset role');
  const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Menu customer') returning id",[ws])).rows[0].id;
  const rows=[];
  for(const paid of [100,25]){
   await db.exec('reset role');
   const row=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2099-01-01','USD',100,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[ws,customer])).rows[0];
   await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
   await db.query('select record_invoice_payment($1,$2,$3,$4,$5,false)',[ws,row.id,paid,randomUUID(),'Original menu fixture receipt']);
   await db.exec('reset role');rows.push((await db.query('select to_jsonb(i) row from invoices i where id=$1',[row.id])).rows[0].row);
  }
  const external=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,currency,total_amount,status,external_provider,external_invoice_id,metadata) values($1,$2,'AUTO','2026-10-01','USD',100,'sent','quickbooks','fixture-linked-invoice','{\"invoice_direction\":\"receivable\"}') returning to_jsonb(invoices) row",[ws,customer])).rows[0].row;
  const snapshots=async()=>{
   await db.exec('reset role');return (await db.query("select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(i) order by id) from invoices i),'payments',(select jsonb_agg(to_jsonb(p) order by id) from payments p),'reversals',(select jsonb_agg(to_jsonb(r) order by id) from payment_reversals r),'audits',(select jsonb_agg(to_jsonb(a) order by id) from invoice_correction_audits a)) facts")).rows[0].facts;
  };
  const before=await snapshots(),authorize=async input=>Boolean(await authorizeOwnerPhone({supabase,...scope,...input}));
  const replies=createOwnerReplyStore({supabase,clock,env});
  const handler=createOwnerMessageHandler({supabase,clock,env,logger,authorize:input=>authorizeOwnerPhone({supabase,...input}),
   providerFactory(){modelCalls++;throw Error('Signed menu clicks must not invoke a model');}});
  async function initial(row,suffix){
   const reference=await planOwnerNextActions({supabase,scope,clock,authorize,context:{params:{operation:'read',table:'invoices'},result:{ok:true,readOnly:true,rows:[row]},records:[row]}});
   return replies.save({...scope,messageId:`initial-${suffix}`},{answer:`Invoice ${row.invoice_number}`,ownerNextActionRef:reference});
  }
  async function click(button,messageId=randomUUID(),scopeOverride={}){
   await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,interaction_id,status) values($1,'fixture',$2,'button',$3,$4,'processing') on conflict(provider_message_id) do nothing",[messageId,phone,button.title,button.id]);
   return handler({...scope,...scopeOverride,messageId,message:button.title,interactionId:button.id});
  }
  const original=(await readFile(new URL('../supabase/migrations/20261004094307_owner_next_actions.sql',import.meta.url),'utf8'));
  await db.exec(original.slice(original.indexOf('create or replace function'),original.indexOf('revoke all')));
  const originalAcl=(await db.query("select proacl::text acl from pg_proc where oid='app.owner_next_action_ref_valid(jsonb)'::regprocedure")).rows[0].acl;
  const top=await initial(rows[0],'paid');
  assert.deepEqual(top.buttons.map(b=>b.title),['Edit details']);
  await t.test('old production validator reproduces missing nested buttons; proposed SQL fixes actual persisted reply',async()=>{
   const failed=await click(top.buttons[0],'nested-save-interrupted');
   assert.match(failed.answer,/Choose which details/);assert.equal(failed.buttons,undefined);
   assert.ok(f.errors.some(error=>/owner_next_action_ref_check/.test(error.message)),JSON.stringify(f.errors));
   await db.exec('reset role');await db.exec(await readFile(migration,'utf8'));
   assert.equal((await db.query("select proacl::text acl from pg_proc where oid='app.owner_next_action_ref_valid(jsonb)'::regprocedure")).rows[0].acl,originalAcl);
   assert.deepEqual(await snapshots(),before);f.errors.length=0;
   const recovered=await click(top.buttons[0],'nested-save-interrupted');
   assert.deepEqual(recovered.buttons.map(b=>b.title),['Amount','Due date','Other fields']);
   const replay=await click(top.buttons[0],'nested-save-interrupted');assert.equal(replay.replayed,true);assert.deepEqual(replay.buttons,recovered.buttons);
  });
  for(const [index,row] of rows.entries())await t.test(`${row.status} nested actions and return navigation never change invoices or payments`,async()=>{
   const root=index===0?top:await initial(row,'open');
   const menu=await click(root.buttons.find(b=>b.title==='Edit details'));
   assert.deepEqual(menu.buttons.map(b=>b.title),['Amount','Due date','Other fields']);
   const amount=await click(menu.buttons[0]);assert.match(amount.answer,/What should the new total/);assert.match(amount.answer,/history will stay intact/);assert.match(amount.answer,/overpayment/);
   assert.match((await click(menu.buttons[1])).answer,/new due date/);
   assert.match((await click(menu.buttons[2])).answer,/What other details/);
   const returned=await click(root.buttons.find(b=>b.title==='Edit details'));
   assert.deepEqual(returned.buttons.map(b=>b.title),['Amount','Due date','Other fields']);assert.notEqual(returned.buttons[0].id,menu.buttons[0].id);
   assert.deepEqual(await snapshots(),before);
  });
  await t.test('connected accounting amounts stay in their source ledger while benign edit prompts remain available',async()=>{
   const root=await initial(external,'external'),menu=await click(root.buttons.find(b=>b.title==='Edit details'));
   assert.match((await click(menu.buttons[0])).answer,/managed by connected accounting/);
   assert.match((await click(menu.buttons[1])).answer,/new due date/);
   assert.match((await click(menu.buttons[2])).answer,/What other details/);
   assert.deepEqual(await snapshots(),before);
  });
  await t.test('restoring the old validator would reject updates to retained nested receipts',async()=>{
   await db.exec('reset role');
   const receipt=(await db.query("select id from whatsapp_messages where owner_next_action_ref->'choices'->0->>'action'='edit_amount' limit 1")).rows[0];
   assert.ok(receipt);
   await db.exec(original.slice(original.indexOf('create or replace function'),original.indexOf('revoke all')));
   await assert.rejects(db.query('update whatsapp_messages set id=id where id=$1',[receipt.id]),error=>error.code==='23514'&&/owner_next_action_ref_check/.test(error.message));
   await db.exec(await readFile(migration,'utf8'));
   await db.query('update whatsapp_messages set id=id where id=$1',[receipt.id]);
  });
  await t.test('expiry, changed record, forged signature and wrong scope refuse clicks',async()=>{
   const menu=await click(top.buttons[0]);elapsed=31*60*1000;
   assert.match((await click(menu.buttons[1])).answer,/expired|changed/);elapsed=0;
   assert.match((await click({...menu.buttons[0],id:menu.buttons[0].id.slice(0,-1)+'!'})).answer,/expired|changed/);
   assert.equal(await click(menu.buttons[0],randomUUID(),{workspaceId:randomUUID()}),'');
   await db.exec('reset role');await db.query("update invoices set notes='Separately changed record' where id=$1",[rows[0].id]);
   assert.match((await click(menu.buttons[2])).answer,/expired|changed/);
   assert.deepEqual((await snapshots()).payments,before.payments);assert.equal(modelCalls,0);
  });
 }finally{await f.close();}
});

test('nested invoice validator retains SQL scope, shape, owner-only and existing ACL restrictions',async()=>{
 const f=await createOfflineSqlNetwork();try{
  const {db}=f;await db.exec('reset role');
  const choice={action:'edit_amount',title:'Amount',table:'invoices',id:randomUUID(),updatedAt:new Date().toISOString()};
  const ref={v:1,key:randomUUID(),expiresAt:new Date(Date.now()+1800000).toISOString(),choices:[choice]};
  const valid=async value=>(await db.query('select app.owner_next_action_ref_valid($1::jsonb) valid',[value])).rows[0].valid;
  for(const action of ['edit_amount','edit_due_date','edit_more'])assert.equal(await valid({...ref,choices:[{...choice,action}]}),true);
  for(const value of [{...ref,choices:[{...choice,table:'customers'}]},{...ref,choices:[{...choice,id:null}]},{...ref,choices:[{...choice,updatedAt:'infinity'}]},{...ref,choices:[{...choice,workspaceId:randomUUID()}]},{...ref,choices:Array(4).fill(choice)},{...ref,choices:[{...choice,title:'X'.repeat(21)}]},{...ref,choices:[{...choice,action:'confirm'}]}])assert.equal(await valid(value),false);
  for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'app.owner_next_action_ref_valid(jsonb)','execute') allowed",[role])).rows[0].allowed,false);
  assert.equal((await db.query("select has_function_privilege('service_role','app.owner_next_action_ref_valid(jsonb)','execute') allowed")).rows[0].allowed,true);
  const def=(await db.query("select pg_get_constraintdef(oid) def from pg_constraint where conrelid='whatsapp_messages'::regclass and conname='whatsapp_messages_owner_next_action_ref_check'")).rows[0].def;
  assert.match(def,/outbound/);assert.match(def,/owner/);assert.match(def,/owner_action_ref IS NULL/);
 }finally{await f.close();}
});
