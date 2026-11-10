import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {setup} from './fixtures/reviewer-round8-harness.mjs';
import {SupabaseAccountingStore} from '../automation/accounting/store.mjs';
const evidence=[];test.after(()=>writeFile('work/r8-long-source.json',JSON.stringify(evidence,null,2)));
test('a schema-valid long imported notes list retains its private numeric members across replay',async t=>{
 const f=await setup();try{const notes=Array.from({length:1100},(_,i)=>String(101+i)).join(','),customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Long Source Cedar') returning id",[f.scope.workspaceId])).rows[0];
const invoice=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,notes) values($1,$2,'R8-LONG-NOTES',43,'INR','draft',$3) returning id",[f.scope.workspaceId,customer.id,notes])).rows[0];
for(const replay of [false,true]){if(replay)await f.db.query('update invoices set notes=notes where id=$1',[invoice.id]);f.restart();
const terms=await f.terms(),completions=(await f.db.query("select input_kind,encode(input_hash,'hex') input_hash from app.private_invoice_canonical_inputs where workspace_id=$1 and input_hash=sha256(convert_to($2,'UTF8'))",[f.scope.workspaceId,notes])).rows;
for(const audience of ['owner','customer'])await t.test(audience+'/replay='+replay,async()=>{await f.clear();const row={notes,notesLength:notes.length,invoice,scope:f.scope,replay,terms,completions,...await f.turn(audience,'send 1073 today')};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));});
 }}finally{await f.close();}
});
test('the existing accounting ingestion method persists the same long note without truncation',async t=>{
 const f=await setup();try{
  const notes=Array.from({length:1100},(_,i)=>String(101+i)).join(',');
  await f.db.query("insert into customers(workspace_id,name,external_provider,external_customer_id) values($1,'Imported Long Cedar','zoho_books','r8-external-customer')",[f.scope.workspaceId]);
  const store=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'isolated-fixture-service-key',fetchImpl:f.fetchImpl});
  const start=f.requests.length,result=await store.upsertSyncSnapshots({userId:f.scope.ownerId,workspaceId:f.scope.workspaceId,provider:'zoho_books',invoices:[{externalId:'r8-external-invoice',number:'R8-IMPORTED-NOTES',invoiceDate:'2026-10-12',currency:'INR',amountMinor:4300,paidMinor:0,balanceMinor:4300,status:'draft',raw:{customer_id:'r8-external-customer',notes}}]});
  const invoice=(await f.db.query("select id,notes,external_provider,external_invoice_id from invoices where workspace_id=$1 and external_invoice_id='r8-external-invoice'",[f.scope.workspaceId])).rows[0];assert.equal(invoice.notes,notes);
  for(const audience of ['owner','customer'])await t.test(audience,async()=>{await f.clear();const row={sourceKind:'accounting-ingestion',notes,notesLength:notes.length,invoice,scope:f.scope,ingestionResult:result,ingestionRequests:f.requests.slice(start),terms:await f.terms(),...await f.turn(audience,'send 1073 today')};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));});
 }finally{await f.close();}
});
