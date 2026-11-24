import assert from "node:assert/strict";
import postgres from "postgres";
import {getEnv} from "../../src/env";
import {invoiceRepository} from "../../src/server/modules/invoices/invoices.repository";
import {paymentService} from "../../src/server/modules/invoices/payments.service";
const env=getEnv();if(env.APP_ENV!=="test"||new URL(env.DATABASE_URL).hostname!=="127.0.0.1")throw Error("Synthetic loopback only");
const sql=postgres(env.DATABASE_URL,{max:1,prepare:false});
const owner="11111111-1111-4111-8111-111111111111",workspace="22222222-2222-4222-8222-222222222222";
try{
 const row=await invoiceRepository.create(owner,{workspaceId:workspace,invoiceNumber:"FINANCIAL-PRESERVATION",amount:"100.00",currency:"INR"});assert.ok(row);
 await sql`update invoices set issue_date='2026-11-01',due_date='2026-12-01',notes='retained note',custom_fields=${sql.json({po:"PO-1"})},metadata=${sql.json({private_data:"retained",followup_state:"scheduled"})},external_provider='synthetic',external_invoice_id='provider-id',last_synced_at='2026-11-01T01:00:00Z',sync_status='synced',last_sync_error='private',last_follow_up_at='2026-11-02T01:00:00Z',reminder_count=9,customer_phone='+919000000001',follow_up_settings=${sql.json({private:"settings"})},automation_version=9007199254740993,updated_at='2026-11-03T01:00:00Z' where id=${row.id}`;
 const detail=await invoiceRepository.find(owner,row.id);assert.ok(detail);assert.equal(detail.issueDate,"2026-11-01");assert.equal(detail.dueDate,"2026-12-01");assert.equal(detail.notes,"retained note");assert.deepEqual(detail.customFields,{po:"PO-1"});
 for(const data of [detail,(await invoiceRepository.list(owner,{workspaceId:workspace,page:1,pageSize:100})).rows.find(x=>x.id===row.id)]){const encoded=JSON.stringify(data);for(const field of ["automationVersion","followUpSettings","externalInvoiceId","metadata","customerPhone","lastSyncError"])assert.ok(!encoded.includes(field),field+" leaked");}
 await sql`insert into payments(workspace_id,invoice_id,amount,paid_at,method,reference,metadata,external_provider,external_payment_id,last_synced_at,sync_status,last_sync_error,updated_at,settle_remaining) values(${workspace},${row.id},'1.23','2026-10-01T00:00:00Z','bank','retained-reference',${sql.json({private:"ledger"})},'synthetic','p-1','2026-10-02T00:00:00Z','synced','private','2026-10-03T00:00:00Z',false)`;
 const [legacy]=await sql`select * from payments where invoice_id=${row.id}`;assert.equal(legacy!.recorded_by,null);assert.equal(legacy!.idempotency_key,null);assert.equal(legacy!.method,"bank");assert.equal(legacy!.paid_at.toISOString(),"2026-10-01T00:00:00.000Z");assert.deepEqual(legacy!.metadata,{private:"ledger"});
 const payment=await paymentService.record(owner,row.id,{amount:"2.00",settleRemaining:false,reference:null,idempotencyKey:"preservation-new"});assert.deepEqual(Object.keys(payment).sort(),["amount","id"]);
 const [preserved]=await sql`select * from invoices where id=${row.id}`;assert.equal(String(preserved!.automation_version),"9007199254740993");assert.equal(preserved!.reminder_count,9);assert.equal(preserved!.external_invoice_id,"provider-id");assert.equal(preserved!.last_sync_error,"private");assert.deepEqual(preserved!.follow_up_settings,{private:"settings"});
 for(const status of ["sent","overdue"]){
 const item=await invoiceRepository.create(owner,{workspaceId:workspace,invoiceNumber:"LEGACY-STATUS-"+status,amount:"100.00",currency:"INR"});assert.ok(item);
 await sql`update invoices set financial_status=${status} where id=${item.id}`;
 await paymentService.record(owner,item.id,{amount:"0.01",settleRemaining:false,reference:null,idempotencyKey:"legacy-status-"+status});
 assert.equal((await invoiceRepository.find(owner,item.id))!.financialStatus,status);
 }
 process.stdout.write("Synthetic financial fields/date/exact bigint/null-attribution/privacy preservation passed. No real import claimed.\n");
}finally{await sql.end();}
