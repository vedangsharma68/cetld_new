import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createInvoiceCorrectionClient} from '../invoice/correction-client.mjs';
import {correctionValues} from '../invoice/correction-form.mjs';
import {invoiceBusinessFields} from '../invoice/business-fields.mjs';

test('removing every dashboard item emits an empty replacement without unrelated financial changes',()=>{
  const invoice={id:'fixture-invoice',customer_id:'fixture-customer',currency:'USD',total_amount:110,
    metadata:{subtotal:100,tax:10,line_items:[{description:'Original service',amount:100}]}};
  const form={querySelectorAll:()=>[],querySelector:()=>({})};
  assert.deepEqual(correctionValues(form,invoice,new Map([['subtotal','100'],['tax','10'],['total_amount','110']])),{line_items:[]});
});

test('real authenticated SDK/RPC clears itemization while preserving positive totals, source, legacy math and immutable replay audit',async()=>{
  const f=await createOfflineSqlNetwork();
  try{
    const owner=randomUUID(),otherOwner=randomUUID();
    await f.db.query('insert into auth.users(id) values($1),($2)',[owner,otherOwner]);
    const authorize=async actor=>f.db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
    const workspace=async actor=>{
      await authorize(actor);const id=(await f.db.query('select (public.create_workspace($1,$2)).id',['Isolated fixture',randomUUID()])).rows[0].id;
      await f.db.exec('reset role');return id;
    };
    const workspaceId=await workspace(owner),otherWorkspace=await workspace(otherOwner);
    const customerId=(await f.db.query("insert into customers(workspace_id,name) values($1,'Fixture customer') returning id",[workspaceId])).rows[0].id;
    const otherCustomer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Foreign fixture') returning id",[otherWorkspace])).rows[0].id;
    const originalSource={printed_invoice_number:'PRINT-17',source_document:{file:'isolated-original.pdf',extraction:{subtotal:100,tax:10}}};
    const metadata={...originalSource,invoice_direction:'receivable',subtotal_minor:10000,tax_minor:1000,line_items:[{description:'Original service',quantity:null,unitPrice:null,amount:100}]};
    const invoice=(await f.db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,notes,metadata)
      values($1,$2,'AUTO','2026-10-01','2026-10-31','USD',110,'Original notes',$3::jsonb) returning to_jsonb(invoices) row`,[workspaceId,customerId,JSON.stringify(metadata)])).rows[0].row;
    await authorize(owner);
    const sdk=createClient('https://fixture.supabase.test','isolated-publishable-fixture-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:f.fetchImpl}});
    const correct=createInvoiceCorrectionClient(sdk);
    const input={workspaceId,invoiceId:invoice.id,expectedUpdatedAt:invoice.updated_at,requestId:randomUUID(),values:{line_items:[]}};
    const cleared=await correct(input);
    assert.equal(cleared.completed,true);assert.equal(cleared.record.total_amount,110);assert.equal(cleared.record.amount_paid,0);assert.equal(cleared.record.currency,'USD');
    assert.deepEqual(cleared.record.metadata.line_items,[]);assert.equal(cleared.record.metadata.subtotal_minor,10000);assert.equal(cleared.record.metadata.tax_minor,1000);
    assert.equal(invoiceBusinessFields(cleared.record).subtotal,'100.00');assert.equal(invoiceBusinessFields(cleared.record).tax,'10.00');
    assert.deepEqual(cleared.record.metadata.source_document,originalSource.source_document);assert.equal(cleared.record.metadata.printed_invoice_number,'PRINT-17');
    assert.equal((await correct(input)).replayed,true);
    const audits=(await f.db.query('select values,before_snapshot,after_snapshot from invoice_correction_audits where invoice_id=$1',[invoice.id])).rows;
    assert.equal(audits.length,1);assert.deepEqual(audits[0].values,{line_items:[]});assert.equal(audits[0].before_snapshot.metadata.line_items.length,1);assert.deepEqual(audits[0].after_snapshot.metadata.line_items,[]);
    assert.equal((await f.db.query('select count(*)::int n from payments where workspace_id=$1',[workspaceId])).rows[0].n,0);
    const notes=await correct({...input,expectedUpdatedAt:cleared.record.updated_at,requestId:randomUUID(),values:{notes:'Clarified source note'}});
    assert.equal(notes.record.total_amount,110);assert.equal(notes.record.metadata.tax_minor,1000);assert.deepEqual(notes.record.metadata.source_document,originalSource.source_document);
    await assert.rejects(correct(input),error=>error.code==='STALE');
    const replaced=await correct({...input,expectedUpdatedAt:notes.record.updated_at,requestId:randomUUID(),values:{line_items:[{description:'Replacement service',amount:90}],total_amount:100}});
    assert.equal(replaced.record.metadata.subtotal,90);assert.equal(replaced.record.total_amount,100,'nonempty replacement still infers subtotal and reconciles tax');
    await assert.rejects(correct({...input,expectedUpdatedAt:replaced.record.updated_at,requestId:randomUUID(),values:{customer_id:otherCustomer}}),error=>error.code==='NOT_FOUND');
    await authorize(otherOwner);
    await assert.rejects(correct({...input,requestId:randomUUID()}),error=>error.code==='DENIED');
    await authorize(owner);
    await f.db.query('select public.record_invoice_payment($1,$2,10,$3,$4,false)',[workspaceId,invoice.id,'isolated-payment-fixture','Isolated fixture only']);
    const paid=(await f.db.query('select to_jsonb(i) row from invoices i where id=$1',[invoice.id])).rows[0].row;
    const paidCleared=await correct({...input,expectedUpdatedAt:paid.updated_at,requestId:randomUUID()});
    assert.equal(paidCleared.record.amount_paid,10);assert.deepEqual(paidCleared.record.metadata.line_items,[]);assert.equal(paidCleared.record.total_amount,100);
    assert.equal(f.errors.length,0,JSON.stringify(f.errors));
  }finally{await f.close();}
});
