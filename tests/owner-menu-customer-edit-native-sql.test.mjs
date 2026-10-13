import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';
import {planOwnerNextActions,ownerMenuInvoiceEdit} from '../automation/whatsapp/owner-next-actions.mjs';
import {createOwnerReplyStore} from '../automation/whatsapp/owner-reply-store.mjs';

test('field-only invoice customer edit retains the signed menu target through real handler, SDK and SQL',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+12025550973';
  const env={NODE_ENV:'test',WHATSAPP_APP_SECRET:'isolated-menu-followup'},clock=()=>new Date();
  let race=false,models=0;const executions=[];
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (create_workspace('Menu edit fixture',$1)).id",[randomUUID()])).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) v',[phone,verification.code])).rows[0].v.ok,true);
    const binding=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
    const scope={workspaceId,ownerId,phone,customerId:binding.customer_id};
    await db.exec('reset role');
    const customers=(await db.query("insert into customers(workspace_id,name) values($1,'QA Fixture Customer'),($1,'gnadev') returning *",[workspaceId])).rows;
    const invoice=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,currency,total_amount,status) values($1,$2,'AUTO','2026-10-01','USD',100,'draft') returning *",[workspaceId,customers[0].id])).rows[0];
    const authorize=input=>authorizeOwnerPhone({supabase,...input});
    const handler=createOwnerMessageHandler({supabase,env,clock,logger:{info(){},warn(){},error(){}},authorize,
      providerFactory:()=>({async generate(){models++;throw Error('bounded menu followup must not call a model');}}),
      toolsFactory:options=>{
        const tools=createOwnerWorkspaceTools(options);
        return {...tools,async execute(name,args,context){
          executions.push({name,args:structuredClone(args)});
          if(race&&args.operation==='update'){
            race=false;await db.exec('reset role');await db.query("update invoices set notes='Concurrent independent change' where id=$1",[invoice.id]);
          }
          return tools.execute(name,args,context);
        }};
      }});
    const replies=createOwnerReplyStore({supabase,clock,env});
    const turn=async(message,interactionId=null,messageId=randomUUID())=>{
      await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,interaction_id,status) values($1,'fixture',$2,$3,$4,$5,'processing') on conflict(provider_message_id) do nothing",[messageId,phone,interactionId?'button':'text',message,interactionId]);
      return handler({...scope,messageId,message,interactionId});
    };
    const prompt=async()=>{
      await db.exec('reset role');const current=(await db.query('select * from invoices where id=$1',[invoice.id])).rows[0];
      const ref=await planOwnerNextActions({supabase,scope,clock,authorize,context:{params:{operation:'read',table:'invoices'},result:{ok:true,readOnly:true,rows:[current]},records:[current]}});
      const top=await replies.save({...scope,messageId:randomUUID()},{answer:`Invoice ${current.invoice_number}`,ownerNextActionRef:ref});
      const menu=await turn('Edit details',top.buttons.find(b=>b.title==='Edit details').id);
      return turn('Other fields',menu.buttons.find(b=>b.title==='Other fields').id);
    };
    const customerSnapshot=async()=>{await db.exec('reset role');return (await db.query('select to_jsonb(c) v from customers c order by id')).rows;};
    const originalCustomers=await customerSnapshot();
    const unselected=await turn('customer name gnadev');assert.match(unselected.answer,/Which invoice/i);
    assert.deepEqual(await customerSnapshot(),originalCustomers);
    await prompt();
    const missing=await turn('customer name nonexistent fixture');
    assert.match(missing.answer,/could not find|no matching/i);assert.deepEqual(await customerSnapshot(),originalCustomers);
    assert.equal((await db.query('select customer_id from invoices where id=$1',[invoice.id])).rows[0].customer_id,customers[0].id);
    const id=randomUUID(),changed=await turn('customer name gnadev',null,id);
    assert.match(changed.answer,/Customer changed/i,JSON.stringify(changed));
    assert.equal((await db.query('select customer_id from invoices where id=$1',[invoice.id])).rows[0].customer_id,customers[1].id);
    assert.deepEqual(await customerSnapshot(),originalCustomers,'reassignment never creates or renames a shared customer');
    const replay=await turn('customer name gnadev',null,id);assert.equal(replay.replayed,true);assert.equal(replay.answer,changed.answer);
    // A worker can commit the audited correction before its reply receipt is
    // persisted. The same provider message must recover that commit once.
    await db.exec('reset role');
    await db.query('delete from whatsapp_messages where workspace_id=$1 and idempotency_key=$2',[workspaceId,`reply:${id}`]);
    const recovered=await turn('customer name gnadev',null,id);assert.equal(recovered.answer,changed.answer);
    assert.deepEqual(await customerSnapshot(),originalCustomers);
    await prompt();const note=await turn('notes: expedite this invoice');assert.match(note.answer,/Notes changed/i);
    assert.equal((await db.query('select notes from invoices where id=$1',[invoice.id])).rows[0].notes,'expedite this invoice');
    await prompt();const date=await turn('due date 2026-11-15');assert.match(date.answer,/Due date: 2026-11-15/i);
    await prompt();race=true;
    const stale=await turn('customer name QA Fixture Customer');assert.match(stale.answer,/expired|changed/i);
    assert.equal((await db.query('select customer_id from invoices where id=$1',[invoice.id])).rows[0].customer_id,customers[1].id);
    assert.equal((await db.query('select count(*)::int n from payments where invoice_id=$1',[invoice.id])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null',[workspaceId])).rows[0].n,0);
    assert.equal(models,0);assert.ok(executions.every(({args})=>args.operation==='update'&&args.table==='invoices'));
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('field-only parser rejects mixed commands and leaves broad reads out of invoice edit context',()=>{
  assert.deepEqual(ownerMenuInvoiceEdit('customer name gnadev'),{customer_name:'gnadev'});
  assert.deepEqual(ownerMenuInvoiceEdit('notes: expedite'),{notes:'expedite'});
  for(const message of ['now show me my unpaid invoices','customer name gnadev; delete invoice','customer name gnadev then record a payment'])
    assert.equal(ownerMenuInvoiceEdit(message),null);
});
