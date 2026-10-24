import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createInvoiceReconcileStore} from '../automation/invoice-sync-reconciler.mjs';
import {retryAssistantInvoiceSync} from '../ai/invoice-ops.mjs';
import {SupabaseAccountingStore} from '../automation/accounting/store.mjs';
import {createZohoBooksProvider} from '../automation/accounting/providers.mjs';

// Characterize the current authority contract before considering a mirror
// exception. The eligibility decision comes from the production migration,
// not the proposed reminder gate or a JavaScript eligibility fixture.
test('Cetld-created Zoho exports acquire external authority and can lag remote payments',async t=>{
  const f=await createOfflineSqlNetwork(),{db}=f,ownerId=randomUUID();
  try{
    for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Zoho authority fixture',$1)).id",[randomUUID()])).rows[0].id;
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    const customerId=(await db.query("insert into customers(workspace_id,name,email) values($1,'Local client','client@example.test') returning id",[workspaceId])).rows[0].id;
    const local=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
      values($1,$2,'LOCAL','2026-10-01','2026-10-20','USD',125,'draft','{"invoice_direction":"receivable"}') returning *`,[workspaceId,customerId])).rows[0];
    const read=async id=>(await db.query('select * from invoices where id=$1 and workspace_id=$2',[id,workspaceId])).rows[0];
    const check=async id=>(await db.query('select public.cetld_core_check_local_reminder_payment($1,$2,$3) value',[ownerId,workspaceId,id])).rows[0].value;
    const blocked=async id=>assert.deepEqual(await check(id),{ok:false,reason:'external_accounting_required'});
    const scoped=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'fixture-only'},fetchImpl:f.fetchImpl})
      .scoped({workspace_id:workspaceId,owner_id:ownerId});
    let exports=0;
    const accounting={async syncInvoice(input){
      exports++;
      assert.equal(input.invoiceId,local.id);assert.equal(input.workspaceId,workspaceId);
      return {provider:'zoho_books',externalId:'zoho-local'};
    }};
    await t.test('real export links even a draft; origin alone cannot establish a local-only mirror',async()=>{
      assert.equal((await check(local.id)).ok,true,'the unlinked local payment ledger is coherent');
      const result=await retryAssistantInvoiceSync({store:scoped,invoiceId:local.id,accounting});
      assert.equal(result.sync.status,'synced');assert.equal(exports,1);
      const linked=await read(local.id);
      assert.equal(linked.status,'draft');assert.equal(linked.external_provider,'zoho_books');
      assert.equal(linked.external_invoice_id,'zoho-local');
      assert.equal(linked.metadata.bookkeeping_provider,'zoho_books');
      assert.equal(linked.metadata.bookkeeping_record_id,'zoho-local');
      assert.equal(linked.metadata.invoice_direction,'receivable');
      await blocked(local.id);
      await retryAssistantInvoiceSync({store:scoped,invoiceId:local.id,accounting});
      assert.equal(exports,1,'sync is create/link once, not continuous local-authority writeback');
      await db.query("update invoices set status='sent' where id=$1",[local.id]);
      await blocked(local.id);
      await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
      try{
        await assert.rejects(db.query("select public.record_invoice_payment($1,$2,25,'local-payment','offline',false)",[workspaceId,local.id]),/EXTERNAL_ACCOUNTING/);
      }finally{
        await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
      }
    });

    const store=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'fixture-only',fetchImpl:f.fetchImpl});
    const identity={userId:ownerId,workspaceId,provider:'zoho_books'};
    const contact={externalId:'zoho-customer',name:'Local client',email:'client@example.test'};
    const remote={externalId:'zoho-local',number:local.metadata.source_invoice_number||local.invoice_number,invoiceDate:'2026-10-01',dueDate:'2026-10-20',currency:'USD',amountMinor:12500,paidMinor:0,balanceMinor:12500,status:'sent',raw:{customer_id:contact.externalId}};
    await t.test('paid in Zoho while local receipts and amount_paid both remain zero',async()=>{
      const before=await read(local.id);
      assert.equal(Number(before.amount_paid),0);
      assert.equal((await db.query('select coalesce(sum(amount),0) net from payments where invoice_id=$1',[local.id])).rows[0].net,'0');
      // A real adapter reads a simulated paid remote invoice without first
      // importing it. A local balance/audit match cannot detect this state.
      const zoho=createZohoBooksProvider({fetchImpl:async(input,options)=>{
        const url=new URL(input);
        assert.equal(url.pathname,'/books/v3/invoices/zoho-local');
        assert.equal(url.searchParams.get('organization_id'),'fixture-org');
        assert.equal(options.method||'GET','GET');
        return Response.json({invoice:{invoice_id:'zoho-local',currency_code:'USD',total:125,balance:0,status:'paid'}});
      }});
      const balance=await zoho.fetchInvoiceBalance({token:{accessToken:'fixture-only',apiDomain:'https://www.zohoapis.in'},accountId:'fixture-org',invoiceId:'zoho-local'});
      assert.equal(balance.balanceMinor,0);assert.equal(balance.totalMinor,12500);
      assert.deepEqual(await read(local.id),before,'remote reads do not reconcile the local ledger');
      await blocked(local.id);
    });
    await t.test('inbound sync can replace amounts and status on the same Cetld-created row',async()=>{
      await store.upsertSyncSnapshots({...identity,customers:[contact],invoices:[{...remote,amountMinor:15000,balanceMinor:15000,status:'overdue'}]});
      const updated=await read(local.id);
      assert.equal(updated.id,local.id);assert.equal(updated.customer_id,customerId);
      assert.equal(Number(updated.total_amount),150);assert.equal(updated.status,'overdue');
      assert.equal(updated.metadata.accounting_provider,'zoho_books');
      assert.equal(updated.metadata.bookkeeping_record_id,'zoho-local','export provenance is preserved but does not prevent inbound control');
      await blocked(local.id);
    });
    await t.test('Zoho payments flow into the exported invoice, once, with aligned external receipt facts',async()=>{
      const payment={externalId:'zoho-payment',invoiceIds:['zoho-local'],amountMinor:15000,currency:'USD',paymentDate:'2026-10-24',reference:'remote receipt',raw:{invoices:[{invoice_id:'zoho-local',amount_applied:150}]}};
      const sync=()=>store.upsertSyncSnapshots({...identity,invoices:[{...remote,amountMinor:15000,paidMinor:15000,balanceMinor:0,status:'paid'}],payments:[payment]});
      await sync();await sync();
      const paid=await read(local.id);
      assert.equal(Number(paid.amount_paid),150);assert.equal(paid.status,'paid');
      const receipts=(await db.query('select * from payments where invoice_id=$1',[local.id])).rows;
      assert.equal(receipts.length,1);assert.equal(receipts[0].external_payment_id,'zoho-payment');
      assert.equal(receipts[0].external_provider,'zoho_books');assert.equal(receipts[0].metadata.external_invoice_id,'zoho-local');
      await blocked(local.id);
    });
    await t.test('provider-originated invoices use the same external-authority refusal',async()=>{
      await store.upsertSyncSnapshots({...identity,invoices:[{...remote,externalId:'zoho-origin',number:'PROVIDER-ORIGIN'}]});
      const imported=(await db.query("select * from invoices where workspace_id=$1 and external_invoice_id='zoho-origin'",[workspaceId])).rows[0];
      assert.ok(imported);assert.notEqual(imported.id,local.id);
      assert.equal(imported.metadata.bookkeeping_record_id,undefined);
      assert.equal(imported.metadata.accounting_provider,'zoho_books');
      await blocked(imported.id);
      assert.equal((await db.query('select count(*)::int n from invoices where workspace_id=$1',[workspaceId])).rows[0].n,2);
    });
    assert.equal(f.requests.some(r=>r.url.includes('graph.facebook.com')),false);
  }finally{await f.close()}
});
