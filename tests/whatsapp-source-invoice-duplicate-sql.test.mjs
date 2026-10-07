import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
import {saveAssistantInvoice} from '../ai/invoice-ops.mjs';

const invoice={invoiceNumber:'PRINTED/17,REV.1',clientName:'Actual debtor',invoiceDate:'2026-10-01',
  dueDate:'2026-10-31',subtotal:100,tax:0,total:100,currency:'USD',direction:'receivable'};
async function fixture(){
  const f=await createOfflineSqlNetwork(),owner=randomUUID();
  await f.db.query('insert into auth.users(id) values($1)',[owner]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const ws=(await f.db.query('select (public.create_workspace($1,$2)).id',['Duplicate fixture',randomUUID()])).rows[0].id;
  const otherWs=(await f.db.query('select (public.create_workspace($1,$2)).id',['Other fixture',randomUUID()])).rows[0].id;
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Actual debtor') returning id",[ws])).rows[0].id;
  const binding=(await f.db.query("insert into customers(workspace_id,name) values($1,'Owner binding') returning id",[ws])).rows[0].id;
  const otherCustomer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Different debtor') returning id",[ws])).rows[0].id;
  const foreignCustomer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Actual debtor') returning id",[otherWs])).rows[0].id;
  const ownerStore=createWhatsAppInvoiceStore({supabase:f.supabase,workspaceId:ws,customerId:binding,audience:'owner',authorize:async()=>true});
  const save=(key,input=invoice,store=ownerStore)=>saveAssistantInvoice({store,invoice:input,confirmed:true,idempotencyKey:key});
  const lifecycle=async(action,{invoiceId=null,proposalId=null,idempotencyKey=null,confirmationMessageId=null}={})=>{
    await f.db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
    try{return (await f.db.query("select public.invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",
      [action,ws,invoiceId,proposalId,idempotencyKey,confirmationMessageId])).rows[0].value;}
    finally{await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");}
  };
  const remove=async(invoiceId)=>{
    const proposal=await lifecycle('prepare',{invoiceId,idempotencyKey:`dashboard_source_delete_${randomUUID()}`});
    assert.equal(proposal.ok,true);
    const deleted=await lifecycle('confirm',{proposalId:proposal.proposalId,confirmationMessageId:`delete-source-${randomUUID()}`});
    assert.equal(deleted.action,'deleted');
  };
  return {...f,ws,otherWs,customer,binding,otherCustomer,foreignCustomer,ownerStore,save,lifecycle,remove};
}

test('fresh upload save keys cannot create another invoice for the same actual debtor and printed number',async()=>{
  const f=await fixture();try{
    const first=await f.save('wa_fresh_message_first');
    assert.equal(first.saved,true);assert.notEqual(first.invoice.invoiceNumber,invoice.invoiceNumber);
    await f.db.query('insert into payments(workspace_id,invoice_id,amount,idempotency_key) values($1,$2,40,$3)',[f.ws,first.invoice.id,'fixture_payment_original']);
    const before=(await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[first.invoice.id])).rows[0].value;
    const writes=f.requests.filter(request=>request.method==='POST').length;
    await assert.rejects(f.save('wa_fresh_message_reupload',{...invoice,total:90,subtotal:90,notes:'changed source facts'}),{status:409,code:'INVOICE_ALREADY_EXISTS'});
    assert.equal(f.requests.filter(request=>request.method==='POST').length,writes);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.deepEqual((await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[first.invoice.id])).rows[0].value,before);
    assert.equal((await f.db.query('select count(*)::int n from payments where invoice_id=$1',[first.invoice.id])).rows[0].n,1);
    assert.equal((await f.save('wa_fresh_message_first')).idempotent,true);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('duplicate matching remains scoped to workspace, actual customer and source number; AUTO saves remain independent',async()=>{
  const f=await fixture();try{
    const first=await f.save('wa_scoped_message_first');
    await f.save('wa_other_debtor_message',{...invoice,clientName:'Different debtor'});
    const foreignStore=createWhatsAppInvoiceStore({supabase:f.supabase,workspaceId:f.otherWs,customerId:f.foreignCustomer});
    await f.save('wa_other_workspace_message',invoice,foreignStore);
    await f.save('wa_other_number_message',{...invoice,invoiceNumber:'PRINTED/18'});
    await f.save('wa_number_matches_internal',{...invoice,invoiceNumber:first.invoice.invoiceNumber});
    await f.save('wa_auto_message_first',{...invoice,invoiceNumber:'AUTO'});
    await f.save('wa_auto_message_second',{...invoice,invoiceNumber:'AUTO'});
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,7);
    await assert.rejects(f.ownerStore.createAssistantInvoice({customerId:f.foreignCustomer,invoice:{...invoice,idempotencyKey:'wa_forged_customer_message'}}),/customer scope violation/);
    const customerStore=createWhatsAppInvoiceStore({supabase:f.supabase,workspaceId:f.ws,customerId:f.customer});
    await assert.rejects(f.save('wa_customer_reupload_message',invoice,customerStore),{code:'INVOICE_ALREADY_EXISTS'});
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('legacy source metadata and trusted original-number overrides also refuse fresh duplicate inserts',async()=>{
  const f=await fixture();try{
    const row=await f.ownerStore.createAssistantInvoice({customerId:f.customer,invoice:{...invoice,idempotencyKey:'wa_legacy_source_first'}});
    await f.db.query("update invoices set metadata=metadata-'printed_invoice_number' where id=$1",[row.id]);
    assert.equal(await f.ownerStore.createAssistantInvoice({customerId:f.customer,invoice:{...invoice,idempotencyKey:'wa_legacy_source_new'}}),null);
    const audit={originalExtractedNumber:invoice.invoiceNumber,requestedNumber:'AUTO',ownerMessageId:'override-source',ownerInstruction:'Use workspace numbering'};
    assert.equal(await f.ownerStore.createAssistantInvoice({customerId:f.customer,invoice:{...invoice,invoiceNumber:'AUTO',idempotencyKey:'wa_override_source_new'},reviewNumberAudit:audit}),null);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('SQL insert guard rejects one of two new save keys after both application duplicate checks pass',async()=>{
  const f=await fixture();try{
    let posts=0,release;
    const bothReady=new Promise(resolve=>{release=resolve;});
    f.intercept(async(url,{method})=>{
      if(url.pathname==='/rest/v1/invoices'&&method==='POST'){
        posts++;if(posts===2)release();await bothReady;
      }
    });
    const results=await Promise.all(['wa_racing_message_first','wa_racing_message_second'].map(idempotencyKey=>
      f.ownerStore.createAssistantInvoice({customerId:f.customer,invoice:{...invoice,idempotencyKey}})));
    assert.equal(posts,2);assert.equal(results.filter(Boolean).length,1);assert.equal(results.filter(value=>value===null).length,1);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.deepEqual(f.errors.map(error=>error.message),['source invoice already exists for customer']);
  }finally{await f.close();}
});

test('SQL source guard preserves historical duplicates, accepts exact save replay and skips missing/AUTO source metadata',async()=>{
  const f=await fixture();try{
    await f.db.exec('reset role;alter table invoices disable trigger a1_invoices_source_duplicate_guard;set role service_role');
    for(const key of ['historical_message_first','historical_message_second'])
      await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'AUTO',100,$3)",
        [f.ws,f.customer,{printed_invoice_number:'HISTORY-17',assistant_idempotency_key:key,invoice_direction:'receivable'}]);
    const before=(await f.db.query('select to_jsonb(i) value from invoices i order by id')).rows;
    await f.db.exec('reset role;alter table invoices enable trigger a1_invoices_source_duplicate_guard;set role service_role');
    assert.deepEqual((await f.db.query('select to_jsonb(i) value from invoices i order by id')).rows,before);
    await assert.rejects(f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'AUTO',120,$3)",
      [f.ws,f.customer,{printed_invoice_number:'HISTORY-17',assistant_idempotency_key:'fresh_history_message',invoice_direction:'receivable'}]),
      {code:'23505',message:'source invoice already exists for customer'});
    const original=await f.ownerStore.createAssistantInvoice({customerId:f.customer,invoice:{...invoice,idempotencyKey:'wa_exact_save_replay'}});
    const replay=await f.db.query('insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,$3,100,$4) on conflict(workspace_id,invoice_number) do nothing returning id',
      [f.ws,f.customer,invoice.invoiceNumber,original.metadata]);
    assert.equal(replay.rows.length,0);
    for(const metadata of [{},{printed_invoice_number:null},{printed_invoice_number:'AUTO'},{source_invoice_number:'AUTO'}])
      await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'RAW-17',100,$3)",[f.ws,f.customer,metadata]);
    await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'AUTO',100,$3)",
      [f.ws,f.customer,{source_invoice_number:'NO-SAVE-KEY',invoice_direction:'receivable'}]);
    await assert.rejects(f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'AUTO',100,$3)",
      [f.ws,f.customer,{source_invoice_number:'NO-SAVE-KEY',invoice_direction:'receivable'}]),{code:'23505',message:'source invoice already exists for customer'});
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,8);
    await assert.rejects(f.db.query('select app.guard_invoice_source_duplicate()'),{code:'42501'});
  }finally{await f.close();}
});

test('restoring a softdeleted source invoice refuses another active upload without changing either invoice',async()=>{
  const f=await fixture();try{
    const original=await f.save('wa_deleted_original_source');
    await f.remove(original.invoice.id);
    const fresh=await f.save('wa_deleted_source_reuploaded');
    assert.notEqual(fresh.invoice.id,original.invoice.id);
    const before=(await f.db.query('select to_jsonb(i) value from invoices i order by id')).rows;
    await assert.rejects(f.lifecycle('undo',{invoiceId:original.invoice.id,idempotencyKey:'dashboard_duplicate_source_undo'}),
      {code:'23505',message:'source invoice already exists for customer'});
    assert.deepEqual((await f.db.query('select to_jsonb(i) value from invoices i order by id')).rows,before);
    await f.remove(fresh.invoice.id);
    assert.equal((await f.lifecycle('undo',{invoiceId:original.invoice.id,idempotencyKey:'dashboard_duplicate_source_undo'})).action,'restored');
    assert.equal((await f.db.query('select id from invoices where deleted_at is null')).rows[0].id,original.invoice.id);
    await f.db.query("update invoices set notes='Normal unrelated edit' where id=$1",[original.invoice.id]);
    assert.equal((await f.db.query('select notes from invoices where id=$1',[original.invoice.id])).rows[0].notes,'Normal unrelated edit');
  }finally{await f.close();}
});
