import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {ownerInvoiceReadAnalysis} from '../automation/whatsapp/owner-invoice-read-analysis.mjs';

const COMPANY='Example Fabrication LLC';
const invoiceQuestion=amount=>`If ${COMPANY} pays USD ${amount} against invoice SIM-2048, how much would be overpaid? Just explain; do not record a payment or change anything.`;

async function fixture(){
  const f=await createOfflineSqlNetwork(),{db}=f,ownerId=randomUUID(),foreignOwnerId=randomUUID(),phone='+12025550876';
  try{
    await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwnerId]);
    const createWorkspace=async(actor,name)=>{
      await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
      return (await db.query('select (public.create_workspace($1,$2)).id',[name,randomUUID()])).rows[0].id;
    };
    const workspaceId=await createWorkspace(ownerId,'Read-only arithmetic fixture');
    const foreignWorkspaceId=await createWorkspace(foreignOwnerId,'Foreign arithmetic fixture');
    await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const scope={workspaceId,ownerId,customerId,phone};
    const customers=new Map();
    const ensureCustomer=async(ws,name)=>{
      const key=`${ws}:${name}`;if(customers.has(key))return customers.get(key);
      const id=(await db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[ws,name])).rows[0].id;
      customers.set(key,id);return id;
    };
    const addInvoice=async({workspace=workspaceId,customer=COMPANY,number='AUTO',printedNumber=null,currency='USD',total=1234.56,
      status='draft',paid=0,issueDate='2026-10-01'}={})=>{
      const customerId=await ensureCustomer(workspace,customer);
      const metadata={invoice_direction:'receivable',followup_state:'paused',next_follow_up_at:null,
        ...(printedNumber?{printed_invoice_number:printedNumber}:{})};
      const row=(await db.query('insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',
        [workspace,customerId,number,issueDate,'2026-10-31',currency,total,status,metadata])).rows[0];
      if(paid>0){
        await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
        await db.query('select public.record_invoice_payment($1,$2,$3,$4,$5,false)',[workspace,row.id,paid,`read-analysis-payment-${randomUUID()}`,'Fixture payment']);
        assert.equal(Number((await db.query('select amount_paid from invoices where id=$1',[row.id])).rows[0].amount_paid),paid);
        await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
      }
      return row;
    };
    const invoice=await addInvoice({printedNumber:'SIM-2048',paid:400});
    const foreignInvoice=await addInvoice({workspace:foreignWorkspaceId,customer:COMPANY,number:'AUTO',printedNumber:'SIM-2048',total:9999999,status:'sent'});
    const executions=[],outputs=[],providerCalls=[];
    const handler=createOwnerMessageHandler({supabase:f.supabase,
      env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
      logger:{info(){},warn(){},error(){}},
      toolsFactory:options=>{
        const tools=createOwnerWorkspaceTools(options);
        return {...tools,async execute(name,args,context){
          executions.push({name,args:structuredClone(args)});
          const output=await tools.execute(name,args,context);outputs.push(structuredClone(output));return output;
        }};
      },
      fetchImpl:async(url,init)=>{
        providerCalls.push({url:String(url),body:JSON.parse(init.body)});
        throw new Error('the server-selected invoice read analysis should not call a model');
      }});
    const inbound=async(id,message)=>db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,phone,message]);
    const turn=async(id,message,turnScope=scope)=>{await inbound(id,message);return handler({...turnScope,messageId:id,message});};
    const snapshot=async()=>({
      invoices:(await db.query('select to_jsonb(i) value from invoices i where workspace_id=$1 order by invoice_number,id',[workspaceId])).rows.map(row=>row.value),
      payments:(await db.query('select to_jsonb(p) value from payments p where workspace_id=$1 order by id',[workspaceId])).rows.map(row=>row.value),
      reversals:(await db.query('select to_jsonb(r) value from payment_reversals r where workspace_id=$1 order by id',[workspaceId])).rows.map(row=>row.value),
      pending:(await db.query('select id,version,action,consumed_at from whatsapp_pending_actions where workspace_id=$1 order by id',[workspaceId])).rows,
      customerOutbound:(await db.query("select count(*)::int n from whatsapp_messages where workspace_id=$1 and audience='customer' and direction='outbound'",[workspaceId])).rows[0].n,
    });
    return {...f,scope,workspaceId,foreignWorkspaceId,invoice,foreignInvoice,addInvoice,ensureCustomer,handler,turn,snapshot,executions,outputs,providerCalls};
  }catch(error){await f.close();throw error;}
}

function assertNoCalculation(answer){
  assert.match(answer,/could not verify|could not calculate|unable|cannot calculate|not available/i,answer);
  assert.doesNotMatch(answer,/overpaid would be|overpayment would be|remaining balance would be/i,answer);
}

test('conditional payment arithmetic derives a hypothetical overpayment from the current invoice without writing',async()=>{
  const f=await fixture();try{
    const before=await f.snapshot();
    const over=await f.turn('event269-overpayment',invoiceQuestion(1000));
    assert.match(over.answer,/USD 834\.56/);assert.match(over.answer,/USD 1,?000\.00/);
    assert.match(over.answer,/overpayment would be USD 165\.44/);assert.match(over.answer,/remaining balance would be USD 0\.00/);
    assert.match(over.answer,/explanation only/i);assert.match(over.answer,/No changes were made/i);
    const under=await f.turn('event269-underpayment',invoiceQuestion(300));
    assert.match(under.answer,/USD 534\.56/);assert.match(under.answer,/overpayment would be USD 0\.00/);
    assert.match(under.answer,/remaining balance would be USD 534\.56/);
    assert.equal(f.executions.length,2,JSON.stringify(f.executions));
    for(const call of f.executions){
      assert.equal(call.name,'workspaceData');assert.equal(call.args.operation,'read');assert.equal(call.args.table,'invoices');
      assert.deepEqual(call.args.filters,[{column:'invoice_number',operator:'eq',value:'SIM-2048'},{column:'customer_name',operator:'eq',value:COMPANY}]);
    }
    assert.equal(f.outputs.filter(row=>row?.invoiceReadAnalysis).length,2);
    assert.equal(f.providerCalls.length,0);assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('parser separates read-only conditional scenarios from writes and rejects mixed write clauses',()=>{
  assert.deepEqual(ownerInvoiceReadAnalysis(invoiceQuestion(1000)),{kind:'conditionalPayment',customerName:COMPANY,currency:'USD',paymentCents:100000,invoiceNumber:'SIM-2048'});
  assert.equal(ownerInvoiceReadAnalysis('Record USD 300 payment against invoice SIM-2048 for Example Fabrication LLC.'),null);
  assert.equal(ownerInvoiceReadAnalysis(`${invoiceQuestion(1000)} Then record it.`),null);
  assert.equal(ownerInvoiceReadAnalysis(`If ${COMPANY} pays USD 0 against invoice SIM-2048, how much would be overpaid?`),null);
});

test('currency mismatch, missing invoice, ambiguity, and stale version fail closed',async t=>{
  await t.test('currency mismatch',async()=>{
    const f=await fixture();try{
      const before=await f.snapshot(),reply=await f.turn('event269-currency-mismatch',invoiceQuestion(1000).replace('USD 1000','INR 1000'));
      assertNoCalculation(reply.answer);assert.equal(f.providerCalls.length,0);assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('missing source invoice',async()=>{
    const f=await fixture();try{
      const before=await f.snapshot(),reply=await f.turn('event269-missing-target',invoiceQuestion(1000).replace('SIM-2048','SIM-4040'));
      assertNoCalculation(reply.answer);assert.equal(f.providerCalls.length,0);assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('ambiguous invoice alias',async()=>{
    const f=await fixture();try{
      const historical=await f.addInvoice({customer:COMPANY,number:'OTHER-HISTORICAL',currency:'USD',total:120,status:'sent'});
      await f.db.query("update invoices set metadata=jsonb_set(metadata,'{printed_invoice_number}','\"SIM-2048\"') where id=$1",[historical.id]);
      const before=await f.snapshot(),reply=await f.turn('event269-ambiguous-target',invoiceQuestion(1000));
      assertNoCalculation(reply.answer);assert.equal(f.providerCalls.length,0);assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('invoice version changes during read',async()=>{
    const f=await fixture();try{
      let changed=false;
      f.intercept(async url=>{
        if(!changed&&url.pathname==='/rest/v1/invoices'&&url.searchParams.get('select')==='id,updated_at'){
          changed=true;await f.db.query("update invoices set updated_at=updated_at+interval '1 second' where id=$1",[f.invoice.id]);
        }
      });
      const before=await f.snapshot(),reply=await f.turn('event269-stale-read',invoiceQuestion(1000));
      assert.equal(changed,true);assertNoCalculation(reply.answer);assert.equal(f.providerCalls.length,0);
      const after=await f.snapshot();assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.pending,before.pending);
      assert.equal(after.invoices.length,before.invoices.length);assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
});

test('currency balances group separately, exclude unrelated invoices, and include drafts only on request',async()=>{
  const f=await fixture();try{
    const alpha='Example Alpha Ltd',beta='Example Beta Inc',unrelated='Unlisted Example LLC';
    const alphaMain=await f.addInvoice({customer:alpha,number:'AUTO',printedNumber:'ALPHA-1',currency:'USD',total:600,status:'sent',paid:100});
    await f.addInvoice({customer:alpha,number:'AUTO',printedNumber:'ALPHA-DRAFT',currency:'USD',total:100,status:'draft'});
    await f.addInvoice({customer:beta,number:'AUTO',printedNumber:'BETA-USD',currency:'USD',total:300,status:'sent',paid:50});
    await f.addInvoice({customer:beta,number:'AUTO',printedNumber:'BETA-INR',currency:'INR',total:1000,status:'sent',paid:100});
    await f.addInvoice({customer:unrelated,number:'AUTO',printedNumber:'UNRELATED-1',currency:'USD',total:999999,status:'sent'});
    await f.addInvoice({workspace:f.foreignWorkspaceId,customer:'Example Alpha Ltd',number:'AUTO',printedNumber:'FOREIGN-1',currency:'USD',total:9999999,status:'sent'});
    const before=await f.snapshot();
    const base=`Show unpaid balances for ${alpha} and ${beta}, grouped by currency. Do not change anything or send reminders.`;
    const excludedDraft=await f.turn('event270-no-drafts',base);
    assert.match(excludedDraft.answer,/USD 750\.00/);assert.match(excludedDraft.answer,/INR 900\.00/);
    assert.doesNotMatch(excludedDraft.answer,/850\.00|999999|9999999/);
    assert.doesNotMatch(excludedDraft.answer,/including draft/i);
    const includedDraft=await f.turn('event270-with-drafts',base.replace('grouped by currency.','grouped by currency, including draft invoices.'));
    assert.match(includedDraft.answer,/USD 850\.00/);assert.match(includedDraft.answer,/INR 900\.00/);assert.match(includedDraft.answer,/including draft invoices/i);
    assert.match(includedDraft.answer,/Currencies are kept separate/i);
    assert.equal(f.providerCalls.length,0);assert.equal(f.outputs.filter(row=>row?.invoiceReadAnalysis?.kind==='currencyBalances').length,2);
    assert.deepEqual(await f.snapshot(),before);assert.ok(alphaMain.id);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('truncated currency rollup fails closed instead of returning a partial total',async()=>{
  const f=await fixture();try{
    const customer='Large Synthetic Customer';
    for(let i=0;i<51;i++)await f.addInvoice({customer,number:`BULK-${String(i+1).padStart(3,'0')}`,currency:'USD',total:100,status:'sent'});
    const before=await f.snapshot(),reply=await f.turn('event270-truncated','Show unpaid balances for Large Synthetic Customer, grouped by currency.');
    assertNoCalculation(reply.answer);assert.equal(f.providerCalls.length,0);
    assert.deepEqual((await f.snapshot()).payments,before.payments);assert.deepEqual((await f.snapshot()).pending,before.pending);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('an explicit payment request stays on the guarded proposal route',async()=>{
  const f=await fixture();try{
    const before=await f.snapshot();
    const message=`Record USD 300 payment against invoice SIM-2048 for ${COMPANY}.`;
    const reply=await f.turn('event269-real-payment-request',message);
    assert.match(reply.answer,/Proposed a USD 300\.00 payment/);assert.match(reply.answer,/Reply yes to confirm or cancel/);
    assert.equal(f.executions.filter(item=>item.args.operation==='read'&&item.args.table==='invoices').length,1);
    assert.ok(f.executions.some(item=>item.args.operation==='create'&&item.args.table==='payments'));
    assert.equal(f.outputs.some(output=>output?.invoiceReadAnalysis),false);
    const after=await f.snapshot();assert.deepEqual(after.invoices,before.invoices);assert.deepEqual(after.payments,before.payments);
    assert.equal(after.pending.filter(row=>row.action?.type==='owner_invoice_payment').length,1);
    assert.equal(after.customerOutbound,0);assert.equal(f.providerCalls.length,0);assert.deepEqual(f.errors,[]);
    const preserved=await f.snapshot(),analysis=await f.turn('event269-with-pending-payment',invoiceQuestion(1000));
    assert.match(analysis.answer,/overpayment would be USD 165\.44/);
    assert.deepEqual(await f.snapshot(),preserved,'read-only analysis must leave the existing payment proposal and ledger untouched');
    assert.equal(f.outputs.filter(output=>output?.invoiceReadAnalysis).length,1);
    assert.equal(f.providerCalls.length,0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('foreign workspace scope cannot read or summarize the invoice',async()=>{
  const f=await fixture();try{
    const before=await f.snapshot(),reply=await f.turn('event269-wrong-scope',invoiceQuestion(1000),{...f.scope,workspaceId:f.foreignWorkspaceId});
    assert.equal(reply,'');assert.equal(f.executions.length,0);assert.equal(f.providerCalls.length,0);assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
