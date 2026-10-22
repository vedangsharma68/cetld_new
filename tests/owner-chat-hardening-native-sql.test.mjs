import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';

test('owner name clarification, empty filters and service failures work through the real handler and scoped SQL reads',async t=>{
  const f=await createOfflineSqlNetwork(),{db}=f,ownerId=randomUUID(),phone='+12025550137';
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query('select (public.create_workspace($1,$2)).id',['Owner chat hardening',randomUUID()])).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const debtor=(await db.query("insert into customers(workspace_id,name) values($1,'John Smith') returning id",[workspaceId])).rows[0].id;
    await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2026-12-01','USD',100,'draft','{\"invoice_direction\":\"receivable\"}')",[workspaceId,debtor]);
    const scope={workspaceId,ownerId,customerId,phone},history=[];
    const snapshot=async()=> (await db.query("select jsonb_build_object('customers',(select jsonb_agg(to_jsonb(c) order by id) from customers c where workspace_id=$1),'invoices',(select jsonb_agg(to_jsonb(i) order by id) from invoices i where workspace_id=$1),'payments',(select count(*) from payments where workspace_id=$1),'pending',(select count(*) from whatsapp_pending_actions where workspace_id=$1),'outbound',(select count(*) from whatsapp_messages where workspace_id=$1 and audience='customer' and direction='outbound')) value",[workspaceId])).rows[0].value;
    const run=async(message,args,draft='Here is the matching invoice for John Smith.')=>{
      const messageId=randomUUID(),outputs=[],executions=[];let providerCalls=0;
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,message]);
      const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
        historyReader:async()=>structuredClone(history),
        toolsFactory:options=>{const tools=createOwnerWorkspaceTools(options);return {...tools,async execute(name,values,ctx){
          executions.push(structuredClone(values));const result=await tools.execute(name,values,ctx);outputs.push(result);return result;
        }};},
        providerFactory:()=>({async generate(request){
          providerCalls++;
          if(!request.messages.some(item=>item.role==='tool'))return {toolCalls:[{id:'scoped-read',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}]};
          return {content:draft};
        }})});
      const reply=await handler({...scope,messageId,message});
      history.push({role:'user',content:message},{role:'assistant',content:reply.answer});
      return {reply,outputs,executions,providerCalls};
    };
    const before=await snapshot();
    const invoiceRead=(name,extra=[])=>({operation:'read',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:name},...extra]});
    await t.test('typo invoice and debtor reads ask for the existing name; a full-name reply reads it',async()=>{
      const first=await run('Show invoices for Jhon',invoiceRead('Jhon'));
      assert.equal(first.outputs[0].code,'NAME_CONFIRMATION_REQUIRED');assert.match(first.reply.answer,/Did you mean John Smith\?.*full name.*confirm/);
      assert.equal(first.executions.length,1);assert.equal(first.providerCalls,1);
      assert.doesNotMatch(JSON.stringify(first.outputs),new RegExp(debtor));
      const confirmed=await run('John Smith',invoiceRead('John Smith'));
      assert.equal(confirmed.outputs[0].ok,true);assert.equal(confirmed.outputs[0].rows.length,1);assert.match(confirmed.reply.answer,/John Smith/);
      const customer=await run('Show Jhon contact details',{operation:'read',table:'customers',filters:[{column:'name',operator:'ilike',value:'%Jhon%'}]});
      assert.match(customer.reply.answer,/Did you mean John Smith/);
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('overdue filters stay intact and offer open invoices without fetching them',async()=>{
      const result=await run('List overdue invoices for John',invoiceRead('John',[{column:'status',operator:'eq',value:'overdue'}]));
      assert.equal(result.outputs[0].ok,true);assert.deepEqual(result.outputs[0].rows,[]);
      assert.match(result.reply.answer,/No overdue invoices match this request.*all open invoices/);
      assert.equal(result.providerCalls,1);assert.equal(result.executions.length,1);
      const names=f.requests.filter(row=>row.url.includes('/rest/v1/invoices?')).map(row=>new URL(row.url));
      assert.ok(names.filter(url=>url.searchParams.has('status')).every(url=>url.searchParams.get('status')==='eq.overdue'));
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('other empty filters and pagination explicitly offer the nearest list',async()=>{
      const currency=await run('List EUR invoices',{operation:'read',table:'invoices',filters:[{column:'currency',operator:'eq',value:'EUR'}]});
      assert.match(currency.reply.answer,/No invoices match this request.*all invoices/);
      const page=await run('Next page of invoices',{operation:'read',table:'invoices',offset:50});
      assert.match(page.reply.answer,/No more invoices.*first page/);
      assert.equal(page.executions.length,1);
      for(const filter of [{column:'status',operator:'neq',value:'overdue'},{column:'due_date',operator:'lt',value:'2027-01-01'}]){
        const other=await run('List matching EUR invoices',{operation:'read',table:'invoices',filters:[{column:'currency',operator:'eq',value:'EUR'},filter]});
        assert.match(other.reply.answer,/No invoices match/);assert.doesNotMatch(other.reply.answer,/overdue/);
      }
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('failed reads explain the outage and retry, never claiming an empty list',async()=>{
      f.intercept(async url=>{if(url.pathname==='/rest/v1/invoices')throw Error('private database diagnostic');});
      const result=await run('List overdue invoices',{operation:'read',table:'invoices',filters:[{column:'status',operator:'eq',value:'overdue'}]},'Something went wrong.');
      f.intercept(null);
      assert.equal(result.outputs[0].ok,false);assert.match(result.reply.answer,/temporarily unavailable.*Try again/);
      assert.doesNotMatch(result.reply.answer,/No .*invoices|private|diagnostic|UNAVAILABLE/);
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('a typo write cannot change the debtor before confirmation',async()=>{
      let dispatched=0;
      const tool=createWorkspaceDataTool({supabase:f.supabase,scope,authorize:async()=>true,confirmationMode:'direct',
        executeDirectOperation:async()=>{dispatched++;throw Error('a spelling suggestion cannot authorize a write');}});
      const result=await tool.execute({operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'Jhon'}],values:{company_name:'New Company'}});
      assert.equal(result.requiresNameConfirmation,true);assert.equal(dispatched,0);assert.equal(tool.getWriteAttempted(),false);
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('a misspelled reminder debtor is clarified before reminder preparation',async()=>{
      let prepared=0;
      const tool=createWorkspaceDataTool({supabase:f.supabase,scope,authorize:async()=>true,
        executeReminderOperation:async()=>{prepared++;throw Error('name confirmation must precede reminder preparation');}});
      const result=await tool.execute({operation:'sendReminderNow',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'Jhon'}]});
      assert.equal(result.requiresNameConfirmation,true);assert.equal(prepared,0);assert.equal(tool.getWriteAttempted(),false);
      assert.deepEqual(await snapshot(),before);
    });
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
