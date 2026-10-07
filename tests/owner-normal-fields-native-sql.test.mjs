import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

test('default owner tools read workspace numbering and audit customer/date changes without crossing tenants',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),foreignOwner=randomUUID(),phone='+15555550124';
 try{
  await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
  const workspace=async(actor,label)=>{
   await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
   return (await db.query('select (public.create_workspace($1,$2)).id',[label,randomUUID()])).rows[0].id;
  };
  const foreignWorkspace=await workspace(foreignOwner,'Foreign fixture'),workspaceId=await workspace(ownerId,'Normal owner fixture');
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const client=async ws=>(await db.query("insert into customers(workspace_id,name) values($1,'Same Customer') returning id",[ws])).rows[0].id;
  const ownCustomer=await client(workspaceId),foreignCustomer=await client(foreignWorkspace);
  await db.query("insert into customers(workspace_id,name) values($1,'Correct Customer'),($2,'Correct Customer')",[workspaceId,foreignWorkspace]);
  const invoice=async(ws,clientId,total)=>(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency,status,metadata) values($1,$2,'AUTO','2026-10-01','2026-10-31',$3,'USD','sent',$4) returning *",[ws,clientId,total,{invoice_direction:'receivable',printed_invoice_number:'PRINTED-2026-17',source_document:{name:'source.pdf'}}])).rows[0];
  const own=await invoice(workspaceId,ownCustomer,118),foreign=await invoice(foreignWorkspace,foreignCustomer,9999);
  assert.equal(own.invoice_number,'INV-2026-0001');assert.equal(foreign.invoice_number,own.invoice_number);
  const foreignBefore=(await db.query('select to_jsonb(i) value from invoices i where id=$1',[foreign.id])).rows[0].value;
  await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
  const results=[];let proposed,providerCalls=0;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},fetchImpl:async(url,init)=>{
   providerCalls++;assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body),tool=body.messages.findLast(item=>item.role==='tool');
   if(!tool)return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'normal-operation',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(proposed)}}]}}]});
   const value=JSON.parse(tool.content);results.push(value);
   return Response.json({choices:[{finish_reason:'stop',message:{content:value.completed?'Updated invoice INV-2026-0001 customer and dates. No payment changed.':'Invoice INV-2026-0001 is USD 118 for Same Customer. No changes were made.'}}]});
  }});
  const turn=async(id,message,args)=>{
   proposed=args;await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,phone,message]);
   return handler({workspaceId,ownerId,customerId,phone,messageId:id,message});
  };
  const read=await turn('normal-read','Show invoice INV-2026-0001, customer and dates. Do not change anything.',{operation:'read',table:'invoices',columns:['invoice_number','customer_name','total_amount','currency','issue_date','due_date'],filters:[{column:'invoice_number',operator:'eq',value:own.invoice_number}]});
  assert.match(read.answer,/USD 118/);assert.equal(results.at(-1).ok,true);assert.equal(results.at(-1).rows.length,1);assert.equal(results.at(-1).rows[0].total_amount,118);
  const edited=await turn('normal-edit','Change invoice INV-2026-0001 customer to Correct Customer, issue date to 2026-09-30 and due date to 2026-11-15. Keep USD 118 and payment history.',{operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:own.invoice_number}],values:{customer_name:'Correct Customer',issue_date:'2026-09-30',due_date:'2026-11-15'}});
  assert.equal(results.at(-1).completed,true,JSON.stringify(results.at(-1)));assert.match(edited.answer,/Updated invoice/);
  const callCount=providerCalls,replayed=await handler({workspaceId,ownerId,customerId,phone,messageId:'normal-edit',message:'Change invoice INV-2026-0001 customer to Correct Customer, issue date to 2026-09-30 and due date to 2026-11-15. Keep USD 118 and payment history.'});
  assert.equal(replayed.replayed,true);assert.equal(replayed.answer,edited.answer);assert.equal(providerCalls,callCount);
  const saved=(await db.query('select i.*,c.name customer_name from invoices i join customers c on c.id=i.customer_id and c.workspace_id=i.workspace_id where i.id=$1',[own.id])).rows[0];
  assert.equal(saved.customer_name,'Correct Customer');assert.equal(new Date(saved.issue_date).toISOString().slice(0,10),'2026-09-30');assert.equal(new Date(saved.due_date).toISOString().slice(0,10),'2026-11-15');assert.equal(Number(saved.total_amount),118);assert.equal(Number(saved.amount_paid),0);assert.equal(saved.currency,'USD');assert.equal(saved.invoice_number,own.invoice_number);
  assert.equal(saved.metadata.printed_invoice_number,'PRINTED-2026-17');assert.deepEqual(saved.metadata.source_document,{name:'source.pdf'});
  assert.equal((await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[own.id])).rows[0].n,1);
  assert.deepEqual((await db.query('select to_jsonb(i) value from invoices i where id=$1',[foreign.id])).rows[0].value,foreignBefore);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
