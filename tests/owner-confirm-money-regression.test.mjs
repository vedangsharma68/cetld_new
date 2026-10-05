import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

test('legacy confirmed total edits reconcile canonical fees atomically and fail closed on fractional minor units or saved items',async()=>{
 const fixture=await createOfflineSqlNetwork(),{db}=fixture,owner=randomUUID(),phone='+919871367051';
 let sequence=0;
 try{
  await db.query('insert into auth.users(id) values($1)',[owner]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const ws=(await db.query('select (public.create_workspace($1,$2)).id',['Owner money regression','money-'+randomUUID()])).rows[0].id;
  const code=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[ws,phone])).rows[0].code;
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,code])).rows[0].value.ok,true);
  const binding=(await db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  await db.exec('reset role');
  const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Customer') returning id",[ws])).rows[0].id;
  async function invoice(metadata){return (await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,$3,105,$4::jsonb) returning *",[ws,customer,'REGRESSION-'+(++sequence),JSON.stringify({invoice_direction:'receivable',source_file:'immutable.pdf',...metadata})])).rows[0];}
  async function confirm(row,changes){
   const message='money-confirm-'+(++sequence);
   const pending=(await db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,action,source) values($1,$2,$3,$4::jsonb,'whatsapp') returning id,version",[ws,binding.customer_id,phone,JSON.stringify({type:'owner_invoice_update',invoiceId:row.id,expectedUpdatedAt:row.updated_at,changes})])).rows[0];
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text','yes','processing')",[message,phone]);
   return {pending,execute:async()=>(await db.query('select public.whatsapp_confirm_owner_invoice_action($1,$2,$3,$4,$5,$6,true) value',[ws,owner,phone,pending.id,pending.version,message])).rows[0].value};
  }
  const canonical=await invoice({subtotal:100,tax:10,tax_minor:2000,discount:5,discount_minor:1000});
  await db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  const correction=await confirm(canonical,{total:115});assert.equal((await correction.execute()).ok,true);assert.equal((await correction.execute()).replayed,true);
  let saved=(await db.query('select * from invoices where id=$1',[canonical.id])).rows[0];
  assert.equal(Number(saved.total_amount),115);assert.equal(saved.metadata.subtotal,110);assert.equal(saved.metadata.tax,10);assert.equal(saved.metadata.discount,5);
  assert.equal(saved.metadata.tax_minor,2000);assert.equal(saved.metadata.discount_minor,1000);assert.equal(saved.metadata.source_file,'immutable.pdf');
  for(const metadata of [{subtotal:null,tax:null,tax_minor:10.5},{subtotal:100,tax:10,discount:5,line_items:[{description:'Preserved service',amount:100}]}]){
   await db.exec('reset role');const original=await invoice(metadata);await db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
   const rejected=await confirm(original,{total:115});await assert.rejects(rejected.execute(),/minor units|financial components must reconcile/);
   saved=(await db.query('select * from invoices where id=$1',[original.id])).rows[0];assert.equal(Number(saved.total_amount),105);assert.deepEqual(saved.metadata,original.metadata);
   assert.equal((await db.query('select consumed_at from whatsapp_pending_actions where id=$1',[rejected.pending.id])).rows[0].consumed_at,null);
   await db.query('select public.whatsapp_claim_pending_action($1,$2,$3,$4)',[rejected.pending.id,ws,binding.customer_id,phone]);
   const benign=await confirm(saved,{notes:'Benign legacy clarification'});assert.equal((await benign.execute()).ok,true);
   assert.equal((await db.query('select notes from invoices where id=$1',[original.id])).rows[0].notes,'Benign legacy clarification');
  }
  assert.equal((await db.query('select count(*)::int n from payments where workspace_id=$1',[ws])).rows[0].n,0);
 }finally{await fixture.close();}
});
