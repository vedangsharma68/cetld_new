import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SupabaseAccountingStore} from '../automation/accounting/store.mjs';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

test('real scoped accounting store imports one new aligned receipt on a historical unknown invoice through217 without classification or source mutation',async()=>{
 const f=await createOfflineSqlNetwork(),{db}=f,owner=randomUUID();try{
  await db.query('insert into auth.users(id) values($1)',[owner]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const ws=(await db.query("select (public.create_workspace('Historical provider fixture',$1)).id",[randomUUID()])).rows[0].id;
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  // The fixture models Supabase public-table defaults; run each real store HTTP
  // operation under the actual service SQL role, not merely a JWT configuration.
  const actualServiceFetch=async(...args)=>{await db.exec('set role service_role');try{return await f.fetchImpl(...args)}finally{await db.exec('reset role')}};
  const store=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'fixture-only',fetchImpl:actualServiceFetch});
  const identity={userId:owner,workspaceId:ws,provider:'quickbooks'};
  const customer={externalId:'provider-customer',name:'Existing provider client'};
  const invoice={externalId:'provider-invoice',number:'EXT-LEGACY',invoiceDate:'2026-10-01',dueDate:'2026-10-20',currency:'USD',amountMinor:10000,paidMinor:0,balanceMinor:10000,status:'sent',raw:{CustomerRef:{value:customer.externalId}}};
  await store.upsertSyncSnapshots({...identity,customers:[customer],invoices:[invoice]});
  let i=(await db.query('select * from invoices where workspace_id=$1',[ws])).rows[0];
  const source={...i.metadata,source_file:'original.pdf',original_invoice_number:'printed-17'};delete source.invoice_direction;
  await db.query('update invoices set metadata=$1 where id=$2',[source,i.id]);
  const payment={externalId:'first-new-external-receipt',invoiceIds:[invoice.externalId],paymentDate:'2026-10-03',amountMinor:2500,currency:'USD',reference:'provider receipt',raw:{}};
  const run=()=>store.upsertSyncSnapshots({...identity,customers:[customer],invoices:[{...invoice,paidMinor:2500,balanceMinor:7500}],payments:[payment]});
  await run();i=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
  assert.equal(i.metadata.invoice_direction,undefined);assert.equal(i.metadata.source_file,'original.pdf');assert.equal(i.metadata.original_invoice_number,'printed-17');assert.equal(Number(i.amount_paid),25);
  const receipts=(await db.query('select to_jsonb(p) value from payments p where invoice_id=$1',[i.id])).rows;assert.equal(receipts.length,1);
  assert.equal(receipts[0].value.external_provider,'quickbooks');assert.equal(receipts[0].value.external_payment_id,payment.externalId);
  assert.equal(receipts[0].value.metadata.external_invoice_id,invoice.externalId);
  await run();assert.deepEqual((await db.query('select to_jsonb(p) value from payments p where invoice_id=$1',[i.id])).rows,receipts);
  await assert.rejects(store.upsertSyncSnapshots({...identity,payments:[{...payment,amountMinor:2600}]}),/Existing payment facts differ/);
  await assert.rejects(store.upsertSyncSnapshots({...identity,userId:randomUUID(),payments:[payment]}),/workspace owner/);
  assert.deepEqual((await db.query('select to_jsonb(p) value from payments p where invoice_id=$1',[i.id])).rows,receipts);
 }finally{await f.close()}
});
