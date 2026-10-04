import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SupabaseAccountingStore} from '../automation/accounting/store.mjs';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

test('real accounting store preserves invoice source and immutable receipts under deployed SQL guards', async t=>{
 const f=await createOfflineSqlNetwork(),{db}=f,owner=randomUUID(),foreign=randomUUID();
 try{
  await db.query('insert into auth.users(id) values($1),($2)',[owner,foreign]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const ws=(await db.query("select (public.create_workspace('Accounting fixture',$1)).id",[randomUUID()])).rows[0].id;
  await db.exec(`reset role;set request.jwt.claim.sub='${foreign}';set role authenticated`);
  const other=(await db.query("select (public.create_workspace('Foreign fixture',$1)).id",[randomUUID()])).rows[0].id;
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const store=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'fixture-only',fetchImpl:f.fetchImpl});
  const identity={userId:owner,workspaceId:ws,provider:'quickbooks'};
  const customer={externalId:'customer-1',name:'John Smith'};
  const invoice={externalId:'invoice-1',number:'EXT-1',invoiceDate:'2026-10-01',dueDate:'2026-10-20',currency:'USD',amountMinor:10000,paidMinor:2500,balanceMinor:7500,status:'sent',raw:{CustomerRef:{value:'customer-1'}}};
  const payment={externalId:'payment-1',invoiceIds:['invoice-1'],paymentDate:'2026-10-02',amountMinor:2500,currency:'USD',reference:'receipt-1',raw:{}};
  const sync=()=>store.upsertSyncSnapshots({...identity,customers:[customer],invoices:[invoice],payments:[payment]});
  await t.test('fresh authoritative receivable invoice',async()=>{
   const result=await store.upsertSyncSnapshots({...identity,customers:[customer],invoices:[{...invoice,paidMinor:0,balanceMinor:10000}]});assert.equal(result.invoices,1);
   const i=(await db.query('select * from invoices where workspace_id=$1',[ws])).rows[0];assert.equal(i.metadata.invoice_direction,'receivable');
   assert.equal((await db.query('select count(*)::int as n from payments')).rows[0].n,0);
  });
  const i=(await db.query('select * from invoices where workspace_id=$1',[ws])).rows[0];
  const source={...i.metadata,original_invoice_number:'printed-source',source_file:{name:'original.pdf'},line_items:[{description:'Work',amount:100}],subtotal:100,tax:0,discount:0,custom_fields:{project:'Historical'}};
  // Save source facts before any payment, using the actual classification guard.
  await db.query('update invoices set metadata=$1,custom_fields=$2 where id=$3',[JSON.stringify(source),JSON.stringify({project:'Owner project'}),i.id]);
  await sync();assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
  const prior=(await db.query('select to_jsonb(p) as row from payments p')).rows[0].row;
  await t.test('repeated sync retains paid source, components, custom fields and exact receipt',async()=>{
   await sync();await sync();
   const row=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];assert.deepEqual(row.metadata,source);assert.deepEqual(row.custom_fields,{project:'Owner project'});
   assert.deepEqual((await db.query('select to_jsonb(p) as row from payments p')).rows[0].row,prior);
  });
  await t.test('changed receipt facts fail without overwriting original ledger',async()=>{
   await assert.rejects(store.upsertSyncSnapshots({...identity,payments:[{...payment,amountMinor:3000}]}),{code:'ACCOUNTING_PAYMENT_RECONCILIATION_REQUIRED'});
   assert.deepEqual((await db.query('select to_jsonb(p) as row from payments p')).rows[0].row,prior);
  });
  await t.test('invoice CAS refuses interrupted concurrent edits honestly',async()=>{
   let changed=false;f.intercept(async(url,{method})=>{if(!changed && method==='PATCH' && url.pathname.endsWith('/invoices')){changed=true;await db.query("update invoices set notes='Concurrent owner note' where id=$1",[i.id]);}});
   try{await assert.rejects(sync(),{code:'ACCOUNTING_INVOICE_CONFLICT'});}finally{f.intercept(null);}
   assert.equal((await db.query('select notes from invoices where id=$1',[i.id])).rows[0].notes,'Concurrent owner note');
   assert.deepEqual((await db.query('select to_jsonb(p) row from payments p')).rows[0].row,prior);
  });
  await t.test('foreign identity fails before any snapshot or business mutation',async()=>{
   const before=f.requests.length;
   await assert.rejects(store.upsertSyncSnapshots({...identity,workspaceId:other,customers:[customer],invoices:[invoice],payments:[payment]}),{code:'ACCOUNTING_WORKSPACE_FORBIDDEN'});
   assert.equal(f.requests.length,before+1);assert.equal((await db.query('select count(*)::int n from invoices where workspace_id=$1',[other])).rows[0].n,0);
  });
  await t.test('legacy unknown linked sync preserves classification; payable sync and new manual receipts rejected',async()=>{
   for(const direction of [null,'payable']){
    const id=randomUUID();await db.query("insert into invoices(id,workspace_id,customer_id,invoice_number,issue_date,currency,total_amount,amount_paid,status,external_provider,external_invoice_id,metadata) values($1,$2,$3,$4,'2026-10-01','USD',100,25,'sent','quickbooks',$4,$5)",[id,ws,i.customer_id,'blocked-'+id,JSON.stringify(direction?{invoice_direction:direction}:{})]);
    if(direction) await assert.rejects(store.upsertSyncSnapshots({...identity,invoices:[{...invoice,externalId:'blocked-'+id,number:'blocked-'+id}]}),{code:'ACCOUNTING_INVOICE_DIRECTION_REVIEW'});
    else { await store.upsertSyncSnapshots({...identity,invoices:[{...invoice,externalId:'blocked-'+id,number:'blocked-'+id}]});assert.equal((await db.query('select metadata from invoices where id=$1',[id])).rows[0].metadata.invoice_direction,undefined); }
    await assert.rejects(db.query('insert into payments(workspace_id,invoice_id,amount) values($1,$2,10)',[ws,id]),{code:'22023',message:'EXTERNAL_ACCOUNTING: linked invoice requires an aligned authoritative provider receipt'});
    assert.equal((await db.query('select count(*)::int n from payments where invoice_id=$1',[id])).rows[0].n,0);
   }
  });
 }finally{await f.close();}
});
