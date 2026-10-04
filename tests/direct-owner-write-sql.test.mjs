import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createOwnerWorkspacePlanner} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerActionButtons,verifyOwnerActionButton} from '../automation/whatsapp/owner-action-buttons.mjs';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stranger='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const phone='+919871367051';

test('incoming payments require receivable direction across RPC, direct assistant and raw inserts while historical replay stays unchanged',async()=>{
 const {db,workspaceId}=await boot();try{
  await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
  const made=await createDirectInvoice(db,workspaceId,{messageId:'direction-create',customerName:'Direction client'});
  await asOwner(db);const historical=(await db.query('select to_jsonb(public.record_invoice_payment($1,$2,10,$3,$4,false)) value',[workspaceId,made.entityId,'historical-direction','actual received transfer'])).rows[0].value;
  for(const direction of ['payable',null,'unknown']){
   await db.exec('reset role');await db.query("update public.invoices set metadata=jsonb_set(metadata,'{invoice_direction}',$2::jsonb) where id=$1",[made.entityId,JSON.stringify(direction)]);
   const snapshot=(await db.query('select to_jsonb(i) value from public.invoices i where id=$1',[made.entityId])).rows[0].value;
   await asOwner(db);
   await assert.rejects(db.query('select public.record_invoice_payment($1,$2,5,$3,$4,false)',[workspaceId,made.entityId,`new-${direction}`,'new received transfer']),/incoming payment requires a receivable invoice/);
   const replay=(await db.query('select to_jsonb(public.record_invoice_payment($1,$2,10,$3,$4,false)) value',[workspaceId,made.entityId,'historical-direction','actual received transfer'])).rows[0].value;assert.deepEqual(replay,historical);
   await db.exec('reset role');await assert.rejects(db.query('insert into public.payments(workspace_id,invoice_id,amount,idempotency_key,reference,settle_remaining) values($1,$2,5,$3,$4,false)',[workspaceId,made.entityId,`raw-${direction}`,'new received transfer']),/incoming payment requires a receivable invoice/);
   await assert.rejects(db.query('insert into public.payments(workspace_id,invoice_id,amount,idempotency_key,reference,settle_remaining) values($1,$2,11,$3,$4,false) on conflict (workspace_id,idempotency_key) where idempotency_key is not null do nothing',[workspaceId,made.entityId,'historical-direction','actual received transfer']),/incoming payment requires a receivable invoice/);
   await db.query('insert into public.payments(workspace_id,invoice_id,amount,idempotency_key,reference,settle_remaining) values($1,$2,10,$3,$4,false) on conflict (workspace_id,idempotency_key) where idempotency_key is not null do nothing',[workspaceId,made.entityId,'historical-direction','actual received transfer']);
   const current=(await db.query('select * from public.invoices where id=$1',[made.entityId])).rows[0];
   await addInbound(db,`direction-paid-${direction}`,'Mark this invoice paid');
   const direct=await write(db,{workspaceId,providerMessageId:`direction-paid-${direction}`,quote:'Mark this invoice paid',operation:'invoice.update',targetId:made.entityId,expectedUpdatedAt:current.updated_at,payload:{status:'paid'}});assert.equal(direct.ok,false);assert.equal(direct.code,'PAYMENT_GUARD');
   await db.exec('reset role');assert.deepEqual((await db.query('select to_jsonb(i) value from public.invoices i where id=$1',[made.entityId])).rows[0].value,snapshot);
  }
  await db.exec('reset role');await db.query("update public.invoices set metadata=jsonb_set(metadata,'{invoice_direction}','\"receivable\"') where id=$1",[made.entityId]);
  await asOwner(db);const received=(await db.query('select to_jsonb(public.record_invoice_payment($1,$2,5,$3,$4,false)) value',[workspaceId,made.entityId,'valid-receivable','actual received transfer'])).rows[0].value;assert.equal(Number(received.amount),5);
  await asOwner(db,stranger);await assert.rejects(db.query('select public.record_invoice_payment($1,$2,5,$3,$4,false)',[workspaceId,made.entityId,'foreign-direction','unauthorized']),/workspace access denied/);
  await db.exec('reset role');assert.deepEqual((await db.query('select to_jsonb(p) value from public.payments p where id=$1',[historical.id])).rows[0].value,historical);
  assert.equal((await db.query('select count(*)::int n from public.payments where invoice_id=$1',[made.entityId])).rows[0].n,2);
 }finally{await db.close();}
});

async function correctInvoice(db,{workspaceId,invoice,messageId,values,ownerId=owner,quote='Correct my invoice'}){
  await asService(db);await addInbound(db,messageId,quote);
  return (await db.query('select public.whatsapp_correct_owner_invoice($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) value',
    [workspaceId,ownerId,phone,messageId,quote,keyFor(messageId),invoice.id,invoice.updated_at,JSON.stringify(values)])).rows[0].value;
}
test('invoice corrections persist typed fields, preserve source, audit immutable snapshots and recover exact replay',async()=>{
 const {db,workspaceId}=await boot();try{
  await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
  const made=await createDirectInvoice(db,workspaceId,{messageId:'correction-create',invoiceNumber:'SOURCE-17',customerName:'John'});
  await db.exec('reset role');await db.query("update public.invoices set customer_phone='+919811111111',metadata=metadata||$2::jsonb where id=$1",[made.entityId,JSON.stringify({source_file:'original.pdf',extraction_raw:{printed:'SOURCE-17'},debtor_phone:'+919811111111'})]);
  const before=(await db.query('select * from public.invoices where id=$1',[made.entityId])).rows[0];
  const second=(await db.query("insert into public.customers(workspace_id,name) values($1,'Jane') returning id",[workspaceId])).rows[0];
  const values={customer_id:second.id,invoice_number:'CORRECT-18',line_items:[{description:'Service',quantity:2,unitPrice:20,amount:40,confidence:0.9},{description:'Legacy',amount:10}],subtotal:50,tax:10,discount:5,total_amount:55,currency:'USD',issue_date:'2026-10-02',due_date:'2026-11-03',notes:'Corrected',invoice_direction:'payable',seller_name:'Supplier',buyer_name:'My business',payment_information:'Bank details',custom_fields:{purchase_order:'PO-19'}};
  const result=await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-all',values});assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.record.customer_id,second.id);assert.equal(result.record.metadata.source_file,'original.pdf');assert.deepEqual(result.record.metadata.extraction_raw,{printed:'SOURCE-17'});
  assert.equal(result.record.customer_phone,null,'a reassignment to a contact with no phone clears the old canonical recipient');assert.equal(result.record.metadata.debtor_phone,before.metadata.debtor_phone);
  assert.equal(result.record.metadata.printed_invoice_number,before.metadata.printed_invoice_number);assert.equal(result.record.invoice_number,'CORRECT-18');
  assert.equal(result.record.next_follow_up_at,null);assert.equal(result.record.metadata.approved_reminder_text??null,null);
  const audit=(await db.query('select * from public.invoice_correction_audits where id=$1',[result.correctionAuditId])).rows[0];
  assert.equal(audit.source_kind,'whatsapp');assert.equal(audit.before_snapshot.invoice_number,before.invoice_number);assert.deepEqual(audit.after_snapshot,result.record);
  const replay=await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-all',values});assert.equal(replay.replayed,true);assert.equal(replay.correctionAuditId,result.correctionAuditId);
  assert.equal((await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-all',values:{notes:'Different'}})).code,'REPLAY_MISMATCH');
  await db.exec('reset role');await assert.rejects(db.query('delete from public.invoice_correction_audits where id=$1',[audit.id]),/immutable/);
  assert.equal((await db.query('select count(*)::int n from public.payments where invoice_id=$1',[before.id])).rows[0].n,0);
  await db.query("update public.customers set phone='+919822222222' where id=$1",[second.id]);
  const refreshed=await correctInvoice(db,{workspaceId,invoice:result.record,messageId:'correction-recipient-refresh',values:{customer_id:second.id}});
  assert.equal(refreshed.ok,true);assert.equal(refreshed.record.customer_phone,'+919822222222');assert.equal(refreshed.record.metadata.debtor_phone,before.metadata.debtor_phone);
 }finally{await db.close();}
});
test('invoice corrections reject foreign scopes, protected fields, stale events, invalid arithmetic and non-direct authorization without partial writes',async()=>{
 const {db,workspaceId}=await boot();try{
  await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
  const made=await createDirectInvoice(db,workspaceId,{messageId:'correction-negative-create',customerName:'John'});const before=made.record;
  for(const [suffix,values,code] of [['protected',{metadata:{role:'admin'}},'INVALID_FIELDS'],['total',{subtotal:50,tax:10,total_amount:55},'INVALID_TOTAL'],['items',{line_items:[{description:'Bad',quantity:2,unitPrice:20,amount:41}],total_amount:41},'INVALID'],['precision',{tax:1.001},'INVALID'],['invalid-date',{due_date:'2026-02-31'},'INVALID'],['foreign-customer',{customer_id:randomUUID()},'NOT_FOUND']]){
   assert.equal((await correctInvoice(db,{workspaceId,invoice:before,messageId:`correction-${suffix}`,values})).code,code);
  }
  assert.equal((await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-wrong-owner',values:{notes:'bad'},ownerId:stranger})).code,'DENIED');
  assert.equal((await correctInvoice(db,{workspaceId:randomUUID(),invoice:before,messageId:'correction-wrong-ws',values:{notes:'bad'}})).code,'DENIED');
  await setConfirmationMode(db,workspaceId,'buttons');assert.equal((await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-buttons',values:{notes:'bad'}})).code,'CONFIRMATION_REQUIRED');
  await setConfirmationMode(db,workspaceId,'direct');await addInbound(db,'correction-stale-event','Correct my invoice');await db.query("update public.whatsapp_inbound_events set received_at=now()-interval '25 hours' where provider_message_id='correction-stale-event'");
  assert.equal((await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-stale-event',values:{notes:'bad'}})).code,'STALE_EVENT');
  await db.exec('reset role');await db.query("insert into public.cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until) values($1,$2,now(),1,now(),'sending',now()-interval '1 hour')",[workspaceId,before.id]);
  assert.equal((await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-sending',values:{notes:'bad'}})).code,'DELIVERY_IN_FLIGHT');
  await db.exec('reset role');await db.query("update public.cetld_core_automation_delivery_claims set status='quarantined' where invoice_id=$1",[before.id]);
  assert.equal((await correctInvoice(db,{workspaceId,invoice:before,messageId:'correction-quarantined',values:{notes:'bad'}})).code,'DELIVERY_IN_FLIGHT');
  await db.exec('reset role');const actual=(await db.query('select * from public.invoices where id=$1',[before.id])).rows[0];assert.equal(actual.notes,before.notes);assert.deepEqual(actual.metadata,before.metadata);
  assert.equal((await db.query('select count(*)::int n from public.invoice_correction_audits')).rows[0].n,0);
  assert.equal((await db.query("select has_function_privilege('authenticated','app.apply_owner_invoice_correction(uuid,uuid,uuid,timestamptz,jsonb,text,text)','execute') yes")).rows[0].yes,false);
 }finally{await db.close();}
});
test('dashboard corrections authenticate owner, replay independently, reject financial history and retain payment bytes for benign edits',async()=>{
 const {db,workspaceId}=await boot();try{
  await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
  const made=await createDirectInvoice(db,workspaceId,{messageId:'dashboard-correction-create',customerName:'John'});
  await asOwner(db);await db.query('select public.record_invoice_payment($1,$2,20,$3,$4,false)',[workspaceId,made.entityId,'receipt','correction-payment']);
  let invoice=(await db.query('select * from public.invoices where id=$1',[made.entityId])).rows[0];
  const payments=(await db.query('select to_jsonb(p) value from public.payments p where invoice_id=$1',[made.entityId])).rows;
  const call=async(values,request=randomUUID(),expected=invoice.updated_at)=>(await db.query('select public.owner_correct_invoice($1,$2,$3,$4,$5::jsonb) value',[workspaceId,invoice.id,expected,request,JSON.stringify(values)])).rows[0].value;
  for(const values of [{total_amount:60},{currency:'USD'},{customer_id:invoice.customer_id},{invoice_direction:'payable'},{line_items:[]},{subtotal:55},{tax:0},{discount:0},{invoice_number:'NEW'}])assert.equal((await call(values)).code,'PAYMENT_GUARD');
  const request=randomUUID();const values={notes:'Paid invoice explanatory correction',due_date:'2026-11-04',seller_name:'Correct supplier',custom_fields:{project_code:'OWN-19'}};
  const result=await call(values,request);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.record.amount_paid,20);assert.equal(result.record.total_amount,55);
  assert.equal((await call(values,request)).replayed,true);assert.equal((await call({notes:'stale'})).code,'STALE');
  assert.deepEqual((await db.query('select to_jsonb(p) value from public.payments p where invoice_id=$1',[made.entityId])).rows,payments);
  await asOwner(db,stranger);assert.equal((await call({notes:'foreign'})).code,'DENIED');
  await asService(db);await assert.rejects(call({notes:'service bypass'}),/permission denied/);
 }finally{await db.close();}
});

test('business record lifecycle retains facts, scopes owner CAS and receipts, restores once, and blocks archived updates',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
    await addInbound(db,'br-create','Create my supplier');
    const created=await write(db,{workspaceId,providerMessageId:'br-create',quote:'Create my supplier',operation:'business_record.create',payload:{record_type:'supplier',name:'John Smith',custom_fields:{city:'Mumbai',check_count:3}}});
    assert.equal(created.ok,true,JSON.stringify(created));
    const facts={name:created.record.name,record_type:created.record.record_type,custom_fields:created.record.custom_fields};
    const payments=(await db.query('select count(*)::int as n from public.payments')).rows[0].n;
    await addInbound(db,'br-delete','Delete John supplier');
    const input={workspaceId,providerMessageId:'br-delete',quote:'Delete John supplier',operation:'business_record.delete',targetId:created.entityId,expectedUpdatedAt:created.updatedAt,payload:{}};
    assert.equal((await write(db,{...input,ownerId:stranger})).code,'DENIED');
    assert.equal((await write(db,{...input,quote:'invented instruction'})).code,'INVALID_AUTHORIZATION');
    assert.equal((await write(db,{...input,payload:{name:'erase'}})).code,'INVALID');
    const deleted=await write(db,input);assert.equal(deleted.ok,true,JSON.stringify(deleted));assert.equal(deleted.action,'business_record.deleted');assert(deleted.record.deleted_at);assert.equal(deleted.record.deleted_by,owner);
    assert.deepEqual({name:deleted.record.name,record_type:deleted.record.record_type,custom_fields:deleted.record.custom_fields},facts);
    assert.equal((await write(db,input)).replayed,true);
    await addInbound(db,'br-edit','Edit deleted supplier');
    assert.equal((await write(db,{...input,providerMessageId:'br-edit',quote:'Edit deleted supplier',operation:'business_record.update',expectedUpdatedAt:deleted.updatedAt,payload:{name:'changed'}})).code,'ALREADY_DELETED');
    await addInbound(db,'br-restore','Restore John supplier');
    const restore={...input,providerMessageId:'br-restore',quote:'Restore John supplier',operation:'business_record.restore',expectedUpdatedAt:deleted.updatedAt};
    assert.equal((await write(db,{...restore,expectedUpdatedAt:created.updatedAt})).code,'STALE');
    const restored=await write(db,restore);assert.equal(restored.ok,true,JSON.stringify(restored));assert.equal(restored.record.deleted_at,null);assert.equal(restored.action,'business_record.restored');
    assert.equal((await write(db,restore)).replayed,true);
    assert.equal((await db.query('select count(*)::int as n from public.business_records where id=$1',[created.entityId])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int as n from public.payments')).rows[0].n,payments);
    await addInbound(db,'br-delete-old','Delete John supplier again');
    const old=await write(db,{...input,providerMessageId:'br-delete-old',quote:'Delete John supplier again',expectedUpdatedAt:restored.updatedAt});assert.equal(old.ok,true);
    await db.query("update business_records set deleted_at=clock_timestamp()-interval '31 days' where id=$1",[created.entityId]);
    const oldVersion=(await db.query('select to_jsonb(b) row from business_records b where id=$1',[created.entityId])).rows[0].row.updated_at;
    await addInbound(db,'br-restore-expired','Restore old supplier');
    assert.equal((await write(db,{...restore,providerMessageId:'br-restore-expired',quote:'Restore old supplier',expectedUpdatedAt:oldVersion})).code,'UNDO_EXPIRED');
    await asOwner(db,stranger);assert.equal((await db.query('select * from public.business_records')).rows.length,0);
    await assert.rejects(db.query("select app.apply_business_record($1,'delete',$2,null,'{}')",[workspaceId,created.entityId]));
    await asOwner(db);await assert.rejects(db.query('update public.business_records set deleted_at=now(),deleted_by=$1 where id=$2',[owner,created.entityId]));
  }finally{await db.close();}
});

test('reopening draft preserves paid receipts, needs later confirmation, replays once and pauses reminders',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
    const created=await createDirectInvoice(db,workspaceId,{messageId:'reopen-create',invoiceNumber:'INV-REOPEN',customerName:'Reopen Client'});
    assert.equal(created.ok,true);
    await addInbound(db,'reopen-pay','Mark INV-REOPEN paid');
    const paid=await write(db,{workspaceId,providerMessageId:'reopen-pay',quote:'Mark INV-REOPEN paid',operation:'invoice.update',targetId:created.entityId,expectedUpdatedAt:created.updatedAt,payload:{status:'paid'}});
    assert.equal(paid.ok,true,JSON.stringify(paid));
    const original=(await db.query('select to_jsonb(p) as row from public.payments p where workspace_id=$1 and invoice_id=$2 order by id',[workspaceId,created.entityId])).rows;
    await addInbound(db,'reopen-request','Mark INV-REOPEN unpaid');
    const prepareArgs={workspaceId,messageId:'reopen-request',message:'Mark INV-REOPEN unpaid',action:'prepare',invoiceId:created.entityId};
    const proposal=await reopen(db,prepareArgs);
    assert.equal(proposal.ok,true,JSON.stringify(proposal));assert.equal(proposal.requiresConfirmation,true);assert.equal(proposal.cashRefund,false);
    assert.equal(proposal.reversalAmount,Number(paid.record.amount_paid));assert.equal(proposal.paymentCount,1);
    assert.equal((await reopen(db,prepareArgs)).replayed,true);
    const pending=(await db.query("select * from public.whatsapp_pending_actions where workspace_id=$1 and action->>'type'='owner_invoice_reopen' and consumed_at is null",[workspaceId])).rows[0];
    assert.equal((await db.query('select amount_paid::text,status::text from public.invoices where id=$1',[created.entityId])).rows[0].status,'paid');
    assert.equal((await db.query('select count(*)::int as n from public.payment_reversals')).rows[0].n,0);
    await addInbound(db,'reopen-maybe','maybe');
    const decision={workspaceId,messageId:'reopen-maybe',message:'maybe',action:'confirm',proposalId:proposal.proposalId,pendingId:pending.id,pendingVersion:pending.version};
    assert.equal((await reopen(db,decision)).code,'INVALID');
    assert.equal((await reopen(db,{...decision,ownerId:stranger})).code,'DENIED');
    await addInbound(db,'reopen-confirm','yes');
    const confirmed=await reopen(db,{...decision,messageId:'reopen-confirm',message:'yes'});
    assert.equal(confirmed.ok,true,JSON.stringify(confirmed));assert.equal(confirmed.completed,true);assert.equal(confirmed.action,'invoice.reopened');
    assert.equal(confirmed.record.amount_paid,0);assert.equal(confirmed.record.followup_state,'paused');assert.equal(confirmed.record.next_follow_up_at,null);
    assert(['sent','overdue'].includes(confirmed.record.status));assert.equal(confirmed.cashRefund,false);assert.equal(confirmed.paymentHistoryPreserved,true);
    assert.deepEqual((await db.query('select to_jsonb(p) as row from public.payments p where workspace_id=$1 and invoice_id=$2 order by id',[workspaceId,created.entityId])).rows,original);
    const reversal=(await db.query('select * from public.payment_reversals where workspace_id=$1 and invoice_id=$2',[workspaceId,created.entityId])).rows;
    assert.equal(reversal.length,1);assert.equal(reversal[0].actor_id,owner);assert.equal(Number(reversal[0].amount),proposal.reversalAmount);
    assert.equal((await reopen(db,{...decision,messageId:'reopen-confirm',message:'yes'})).replayed,true);
    assert.equal((await db.query('select count(*)::int as n from public.payment_reversals')).rows[0].n,1);
    await asOwner(db);assert.equal((await db.query('select * from public.payment_reversals')).rows.length,1);
    await assert.rejects(db.query("update public.payments set reference='erase history' where id=$1",[original[0].row.id]));
    await asOwner(db,stranger);assert.equal((await db.query('select * from public.payment_reversals')).rows.length,0);
    await assert.rejects(db.query('select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,$6)',[workspaceId,owner,phone,'reopen-confirm','yes','confirm']));
  }finally{await db.close();}
});

async function reopen(db,{workspaceId,ownerId=owner,messageId,message,action,invoiceId=null,proposalId=null,pendingId=null,pendingVersion=null,interactionId=null}){
  await asService(db);
  return (await db.query('select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as value',
    [workspaceId,ownerId,phone,messageId,message,action,invoiceId,proposalId,pendingId,pendingVersion,interactionId])).rows[0].value;
}

async function reopeningFixture(){
  const fixture=await boot(),{db,workspaceId}=fixture;
  await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
  const created=await createDirectInvoice(db,workspaceId,{messageId:'financial-create',invoiceNumber:'INV-FINANCIAL',customerName:'John Smith'});
  assert.equal(created.ok,true,JSON.stringify(created));
  return {...fixture,created};
}

test('reopening draft rejects unsafe ledgers and stale, expired or ambiguous consent',async t=>{
  for(const scenario of ['partial','manual-paid','legacy-mismatch','external','stale','expired','cancel','earlier-consent'])await t.test(scenario,async()=>{
    const {db,workspaceId,created}=await reopeningFixture();
    try{
      await asOwner(db);
      if(scenario==='manual-paid'){await db.exec('reset role');await db.query("update public.invoices set status='paid' where workspace_id=$1 and id=$2",[workspaceId,created.entityId]);}
      else if(scenario==='legacy-mismatch'){await db.exec('reset role');await db.query('update public.invoices set amount_paid=20 where workspace_id=$1 and id=$2',[workspaceId,created.entityId]);}
      else await db.query('select public.record_invoice_payment($1,$2,$3,$4,$5,false)',[workspaceId,created.entityId,20,'test transfer','financial-pay']);
      if(scenario==='external')await db.query("update public.invoices set metadata=metadata||'{\"accounting_provider\":\"external\"}'::jsonb where workspace_id=$1 and id=$2",[workspaceId,created.entityId]);
      await asService(db);await addInbound(db,'financial-request','Mark INV-FINANCIAL unpaid');
      const args={workspaceId,messageId:'financial-request',message:'Mark INV-FINANCIAL unpaid',action:'prepare',invoiceId:created.entityId};
      assert.equal((await reopen(db,{...args,invoiceId:randomUUID()})).code,'NOT_FOUND');
      const proposal=await reopen(db,args);
      if(['legacy-mismatch','external'].includes(scenario)){
        assert.equal(proposal.code,scenario==='external'?'EXTERNAL_LEDGER':'LEDGER_MISMATCH');
        assert.equal((await db.query('select count(*)::int n from public.invoice_reopening_proposals')).rows[0].n,0);return;
      }
      assert.equal(proposal.ok,true,JSON.stringify(proposal));
      const pending=(await db.query("select to_jsonb(a) row from public.whatsapp_pending_actions a where workspace_id=$1 and consumed_at is null",[workspaceId])).rows[0].row;
      await addInbound(db,'financial-decision',scenario==='cancel'?'no':'yes');
      if(scenario==='stale'){await asOwner(db);await db.query("update public.invoices set notes='new version' where id=$1",[created.entityId]);}
      if(scenario==='expired'){await db.exec('reset role');await db.query("update public.invoice_reopening_proposals set expires_at=clock_timestamp()-interval '1 second' where id=$1",[proposal.proposalId]);}
      if(scenario==='earlier-consent'){await db.exec('reset role');await db.query("update public.whatsapp_inbound_events set provider_timestamp=clock_timestamp()-interval '1 day' where provider_message_id='financial-decision'");}
      const confirmed=await reopen(db,{workspaceId,messageId:'financial-decision',message:scenario==='cancel'?'no':'yes',action:scenario==='cancel'?'cancel':'confirm',proposalId:proposal.proposalId,pendingId:pending.id,pendingVersion:pending.version});
      if(['stale','expired','earlier-consent'].includes(scenario))assert.equal(confirmed.code,scenario==='expired'?'EXPIRED':'STALE');
      else if(scenario==='cancel')assert.equal(confirmed.action,'pending.cancelled');
      else {
        assert.equal(confirmed.ok,true,JSON.stringify(confirmed));assert.equal(confirmed.reversedAmount,scenario==='manual-paid'?0:20);
        assert.equal(confirmed.record.amount_paid,0);
        if(scenario==='partial'){
          await asOwner(db);await db.query('select public.record_invoice_payment($1,$2,10,$3,$4,false)',[workspaceId,created.entityId,'new transfer','new-transfer']);
          assert.equal((await db.query('select amount_paid::text paid from public.invoices where id=$1',[created.entityId])).rows[0].paid,'10');
          await asService(db);await addInbound(db,'reopen-again','Mark INV-FINANCIAL unpaid');
          assert.equal((await reopen(db,{...args,messageId:'reopen-again'})).reversalAmount,10);
        }
      }
      if(!['partial','manual-paid'].includes(scenario))assert.equal((await db.query('select count(*)::int n from public.payment_reversals')).rows[0].n,0);
    }finally{await db.close();}
  });
});

function financialSupabase(db,workspaceId){
  return {
    from(table){
      assert(['invoices','payments','invoice_reopening_proposals','whatsapp_direct_write_receipts','payment_reversals'].includes(table));
      const filters=[];let max=51;const read=async()=>{
        assert(filters.some(([c,v])=>c==='workspace_id'&&v===workspaceId));
        // IS NULL consumes no bind parameter.
        const clean=filters.filter(f=>f[2]!=='is');const params=clean.map(f=>f[1]);let n=0;
        const clauses=filters.map(([column,,op])=>op==='is'?`b.${column} is null`:`b.${column}${op==='in'?'=any(': '='}$${++n}${op==='in'?'::uuid[])':''}`);
        return (await db.query(`select to_jsonb(b) row from public.${table} b where ${clauses.join(' and ')} limit ${max}`,params)).rows.map(row=>row.row);
      };
      const q={select(){return q;},eq(c,v){filters.push([c,v,'eq']);return q;},is(c,v){assert.equal(v,null);filters.push([c,v,'is']);return q;},in(c,v){filters.push([c,v,'in']);return q;},
        order(){return q;},limit(n){max=n;return q;},range(a,b){assert.equal(a,0);max=b+1;return q;},
        async maybeSingle(){return {data:(await read())[0]||null,error:null};},then(resolve,reject){return read().then(data=>({data,error:null})).then(resolve,reject);}};
      return q;
    },
    async rpc(name,args){assert.equal(name,'whatsapp_invoice_reopening');const keys=['workspace_id','owner_id','phone','message_id','user_message','action','invoice_id','proposal_id','pending_id','pending_version','interaction_id'];
      await asService(db);return {data:(await db.query('select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) value',keys.map(k=>args['p_'+k]))).rows[0].value,error:null};},
  };
}

test('reopening draft production workspace tools require signed decision and verify persisted receipt/audit',async()=>{
  const {db,workspaceId,created}=await reopeningFixture();
  try{
    await asOwner(db);await db.query('select public.record_invoice_payment($1,$2,20,$3,$4,false)',[workspaceId,created.entityId,'receipt','tool-pay']);
    const scope={workspaceId,ownerId:owner,customerId:await verifiedCustomerId(db),phone},supabase=financialSupabase(db,workspaceId),env={WHATSAPP_APP_SECRET:'isolated-fixture-only'};
    const pendingStore={async loadPendingAction(){await asService(db);return (await db.query('select to_jsonb(a) row from public.whatsapp_pending_actions a where workspace_id=$1 and consumed_at is null',[workspaceId])).rows[0]?.row;}};
    const make=(message,messageId,pendingAtStart=null)=>createOwnerWorkspaceTools({supabase,scope,message,messageId,authorize:async()=>true,env,interactiveAvailable:true,pending:pendingStore,pendingAtStart,botPreferences:{confirmationMode:'direct'},ownerStore:{async query(){throw Error('Legacy tools must not run');}}});
    await addInbound(db,'tool-request','Mark INV-FINANCIAL unpaid');
    const tools=make('Mark INV-FINANCIAL unpaid','tool-request');
    const preview=await tools.execute('workspaceData',{operation:'update',table:'invoices',filters:[{column:'id',operator:'eq',value:created.entityId}],values:{status:'unpaid'}});
    assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.requiresConfirmation,true);assert.equal(preview.completed,undefined);
    assert.equal(tools.getReplyRequirement().buttonsAvailable,true);
    const pending=await pendingStore.loadPendingAction(),buttons=createOwnerActionButtons({scope,action:pending,env});
    assert.deepEqual(buttons.map(b=>b.title),['Reopen invoice','Keep payments']);
    assert.equal(verifyOwnerActionButton({id:buttons[0].id,scope,action:pending,env}).decision,'confirm');
    assert.notEqual(verifyOwnerActionButton({id:buttons[0].id,scope:{...scope,workspaceId:randomUUID()},action:pending,env}).decision,'confirm');
    await addInbound(db,'tool-button','Reopen invoice');await db.query("update public.whatsapp_inbound_events set interaction_id=$1 where provider_message_id='tool-button'",[buttons[0].id]);
    const decide=make('Reopen invoice','tool-button',pending);
    const result=await decide.decideButton({interactionId:buttons[0].id,decision:'confirm',pending});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.completed,true);assert.equal(result.cashRefund,false);
    const replay=await make('Reopen invoice','tool-button').lookupCompleted();assert.equal(replay.ok,true);assert.equal(replay.action,'invoice.reopened');assert.equal(replay.cashRefund,false);
    const payments=await make('Show payments','payment-read').execute('workspaceData',{operation:'read',table:'payments'});
    assert.equal(payments.ok,true,JSON.stringify(payments));assert.equal(payments.rows[0].amount,20);assert.equal(payments.rows[0].net_amount,0);assert.equal(payments.rows[0].reversed_amount,20);
  }finally{await db.close();}
});

test('real provider, catalog, resolver and PostgreSQL repair a targeted update after a successful read',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
    const name='CETLD QA 20261004 1442',initial={record_type:'qa_check',name,custom_fields:{check_note:'temporary assistant test',check_count:1,qa_status:'active'}};
    await addInbound(db,'qa-sql-seed','Create QA record');
    const created=await write(db,{workspaceId,providerMessageId:'qa-sql-seed',quote:'Create QA record',operation:'business_record.create',payload:initial});
    assert.equal(created.ok,true);
    const scope={workspaceId,ownerId:owner,customerId:await verifiedCustomerId(db),phone};
    let dispatches=0;
    const supabase={
      from(table){
        assert(['business_records','whatsapp_direct_write_receipts'].includes(table));
        const filters=[];let max=50,start=0;
        const read=async()=>{
          assert(filters.some(([column,,value])=>column==='workspace_id'&&value===workspaceId));
          const params=filters.map(([, ,value])=>value);
          const where=filters.map(([column,op],i)=>{assert(/^[a-z_]+$/.test(column));return `b.${column} ${op} $${i+1}`;}).join(' and ');
          return (await db.query(`select to_jsonb(b) as row from public.${table} b where ${where} limit ${max} offset ${start}`,params)).rows.map(row=>row.row);
        };
        const q={select(){return q;},eq(column,value){filters.push([column,'=',value]);return q;},ilike(column,value){filters.push([column,'ilike',value]);return q;},
          is(column,value){filters.push([column,'is not distinct from',value]);return q;},
          order(){return q;},limit(value){max=value;return q;},range(a,b){start=a;max=b-a+1;return q;},
          async maybeSingle(){return {data:(await read())[0]||null,error:null};},then(resolve,reject){return read().then(data=>({data,error:null})).then(resolve,reject);}};
        return q;
      },
      async rpc(functionName,args){
        assert.equal(functionName,'whatsapp_apply_direct_owner_write');dispatches++;
        const keys=['workspace_id','owner_id','phone','provider_message_id','interaction_id','idempotency_key','operation','target_id','expected_updated_at','authorization_kind','authorization_quote','button_decision','pending_id','pending_version','payload'];
        const params=keys.map(key=>key==='payload'?JSON.stringify(args.p_payload):args['p_'+key]);
        return {data:(await db.query('select public.whatsapp_apply_direct_owner_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) as value',params)).rows[0].value,error:null};
      },
    };
    let provider;
    const makeTools=(message,messageId)=>createOwnerWorkspaceTools({supabase,scope,message,messageId,authorize:async()=>true,ownerStore:{async query(){throw Error('Legacy tools must not run');}},
      planRequest:(...args)=>createOwnerWorkspacePlanner({provider,message,history:[],timezone:'Asia/Kolkata'})(...args),
      botPreferences:{confirmationMode:'direct'},pendingStoreAvailable:false});
    const read=await makeTools('Show '+name,'qa-read').execute('workspaceData',{operation:'read',table:'business_records',filters:[{column:'name',operator:'eq',value:name}]});
    assert.equal(read.rows.length,1);assert.equal(read.rows[0].custom_fields.check_count,1);
    const message='For '+name+', set check_count to 2 and qa_status to archived.';
    await addInbound(db,'qa-update',message);const tools=makeTools(message,'qa-update');let calls=0;
    provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,
      logger:{info(){},warn(){},error(){}},fetchImpl:async(_url,init)=>{
        const wire=JSON.parse(init.body);calls++;let content;
        if(calls===1){assert(wire.tools.find(tool=>tool.function.name==='workspaceData').function.parameters.properties.filters);content=JSON.stringify({name:'workspaceData',parameters:{operation:'update',table:'business_records',request:message}});}
        else if(calls===2){assert.equal(dispatches,0);assert.equal(wire.response_format.type,'json_schema');assert.equal(wire.messages.at(-1).content,message);
          content=JSON.stringify({operation:'update',table:'business_records',filters:[],values:{custom_fields:{check_count:2,qa_status:'archived'}}});}
        else if(calls===3){assert.equal(dispatches,0);assert.equal(wire.response_format.type,'json_schema');assert(wire.response_format.json_schema.schema.required.includes('filters'));
          assert(wire.messages.some(row=>row.content.includes('TARGET_REQUIRED')&&row.content.includes('validationShape')));
          content=JSON.stringify({operation:'update',table:'business_records',filters:[{column:'name',operator:'eq',value:name}],values:{custom_fields:{check_count:2,qa_status:'archived'}}});}
        else{assert.equal(dispatches,1);content='Updated '+name+': check_count is 2 and qa_status is archived.';}
        return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
      }});
    const result=await runOwnerAgent({provider,message,tools,history:[{role:'assistant',content:JSON.stringify(read.rows)}]});
    assert.equal(result.plannerFailure,undefined);assert.match(result.answer,/check_count is 2/);assert.equal(calls,4);assert.equal(dispatches,1);
    const persisted=(await db.query('select to_jsonb(b) as row from public.business_records b where workspace_id=$1 and id=$2',[workspaceId,created.entityId])).rows[0].row;
    assert.deepEqual(persisted.custom_fields,{check_note:'temporary assistant test',check_count:2,qa_status:'archived'});
    assert.equal((await db.query('select count(*)::int as n from public.business_records where workspace_id=$1 and name=$2',[workspaceId,name])).rows[0].n,1);
    assert.equal((await tools.lookupCompleted()).replayed,true);assert.equal(dispatches,1);
    await asOwner(db,stranger);assert.equal((await db.query('select * from public.business_records where id=$1',[created.entityId])).rows.length,0);
  }finally{await db.close();}
});

test('the requested QA business record persists typed custom fields once and stays private',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
    const quote="Create a qa_check business record named CETLD QA 20261004 1442 with custom fields check_note 'temporary assistant test', check_count 1 and qa_status 'active'.";
    const payload={record_type:'qa_check',name:'CETLD QA 20261004 1442',custom_fields:{check_note:'temporary assistant test',check_count:1,qa_status:'active'}};
    await addInbound(db,'qa-create-regression',quote);
    const input={workspaceId,providerMessageId:'qa-create-regression',quote,operation:'business_record.create',payload};
    const created=await write(db,input);assert.equal(created.ok,true);assert.deepEqual(created.record.custom_fields,payload.custom_fields);
    const replay=await write(db,input);assert.equal(replay.replayed,true);assert.equal(replay.entityId,created.entityId);
    await asOwner(db);
    const rows=(await db.query('select name,record_type,custom_fields from public.business_records where id=$1',[created.entityId])).rows;
    assert.deepEqual(rows,[payload]);
    await asOwner(db,stranger);assert.equal((await db.query('select * from public.business_records where id=$1',[created.entityId])).rows.length,0);
  }finally{await db.close();}
});

test('business record grants override inherited Supabase service privileges',async()=>{
  const {db}=await boot({supabaseDefaultGrants:true});
  try {
    const {rows:[grants]}=await db.query(`select
      has_table_privilege('service_role','public.business_records','SELECT') as read,
      has_table_privilege('service_role','public.business_records','INSERT') as create,
      has_table_privilege('service_role','public.business_records','UPDATE') as edit,
      has_table_privilege('service_role','public.business_records','DELETE') as delete,
      has_table_privilege('service_role','public.business_records','TRUNCATE') as truncate,
      has_table_privilege('authenticated','public.business_records','INSERT,UPDATE,DELETE') as client_write`);
    assert.deepEqual(grants,{read:true,create:true,edit:true,delete:false,truncate:false,client_write:false});
  } finally {await db.close();}
});

test('owner-defined business categories support atomic create/edit, button decisions, replay and negative tenant access',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
    await addInbound(db,'supplier-create','Add supplier Acme Metals with city Mumbai');
    const created=await write(db,{workspaceId,providerMessageId:'supplier-create',quote:'Add supplier Acme Metals with city Mumbai',operation:'business_record.create',
      payload:{record_type:'supplier',name:'Acme Metals',custom_fields:{city:'Mumbai',lead_days:7}}});
    assert.equal(created.ok,true);assert.equal(created.entityType,'business_record');
    const replay=await write(db,{workspaceId,providerMessageId:'supplier-create',quote:'Add supplier Acme Metals with city Mumbai',operation:'business_record.create',
      payload:{record_type:'supplier',name:'Acme Metals',custom_fields:{city:'Mumbai',lead_days:7}}});
    assert.equal(replay.replayed,true);assert.equal(replay.entityId,created.entityId);
    await setConfirmationMode(db,workspaceId,'buttons');
    await addInbound(db,'supplier-proposal','Set Acme Metals lead days to 5');
    const proposal=await proposeWorkspaceChange(db,workspaceId,{operation:'update',table:'business_records',targetId:created.entityId,
      expectedUpdatedAt:created.updatedAt,values:{custom_fields:{lead_days:5}},requestMessageId:'supplier-proposal',summary:'Change lead days'});
    assert.equal(proposal.result.ok,true);
    const contact=await verifiedCustomerId(db);
    await asService(db);
    const pending=(await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',[workspaceId,contact,phone])).rows[0];
    await addInbound(db,'supplier-button','Confirm','oab1.supplier');
    const confirmed=await write(db,{workspaceId,providerMessageId:'supplier-button',operation:'pending.decide',authorizationKind:'button',
      interactionId:'oab1.supplier',buttonDecision:'confirm',pendingId:pending.id,pendingVersion:pending.version});
    assert.equal(confirmed.ok,true);assert.deepEqual(confirmed.record.custom_fields,{city:'Mumbai',lead_days:5});
    await asOwner(db);
    assert.deepEqual((await db.query('select custom_fields from public.business_records where id=$1',[created.entityId])).rows[0].custom_fields,confirmed.record.custom_fields);
    await asOwner(db,stranger);
    assert.equal((await db.query('select * from public.business_records where id=$1',[created.entityId])).rows.length,0);
    await assert.rejects(db.query("update public.business_records set name='stolen' where id=$1",[created.entityId]));
    await asService(db);await addInbound(db,'supplier-forbidden','Set credentials');await setConfirmationMode(db,workspaceId,'direct');
    const denied=await write(db,{workspaceId,providerMessageId:'supplier-forbidden',quote:'Set credentials',operation:'business_record.update',
      targetId:created.entityId,expectedUpdatedAt:confirmed.updatedAt,payload:{custom_fields:{api_key:'x'}}});
    assert.equal(denied.ok,false);
  }finally{await db.close();}
});

test('business custom fields persist and merge through direct and button writes without crossing tenants or changing payments',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
    const quote='Add John Smith with delivery zone West';
    await addInbound(db,'custom-create',quote);
    const created=await write(db,{workspaceId,providerMessageId:'custom-create',quote,operation:'customer.create',
      payload:{name:'John Smith',custom_fields:{delivery_zone:'West',credit_days:30}}});
    assert.equal(created.ok,true);
    assert.deepEqual(created.record.custom_fields,{delivery_zone:'West',credit_days:30});
    const replay=await write(db,{workspaceId,providerMessageId:'custom-create',quote,operation:'customer.create',
      payload:{name:'John Smith',custom_fields:{delivery_zone:'West',credit_days:30}}});
    assert.equal(replay.replayed,true);assert.equal(replay.entityId,created.entityId);
    await addInbound(db,'custom-update','Set John priority high');
    const changed=await write(db,{workspaceId,providerMessageId:'custom-update',quote:'Set John priority high',operation:'customer.update',
      targetId:created.entityId,expectedUpdatedAt:created.updatedAt,payload:{phone:'+12025550123',custom_fields:{priority:'high'}}});
    assert.equal(changed.ok,true);
    assert.equal(changed.record.phone,'+12025550123');
    assert.deepEqual(changed.record.custom_fields,{delivery_zone:'West',credit_days:30,priority:'high'});
    await addInbound(db,'custom-forbidden','Set system fields');
    const forbidden=await write(db,{workspaceId,providerMessageId:'custom-forbidden',quote:'Set system fields',operation:'customer.update',
      targetId:created.entityId,expectedUpdatedAt:changed.updatedAt,payload:{custom_fields:{amount_paid:0}}});
    assert.equal(forbidden.ok,false);

    await asOwner(db,stranger);
    assert.equal((await db.query('select * from public.customers where id=$1',[created.entityId])).rows.length,0);
    assert.equal((await db.query("update public.customers set custom_fields='{\"priority\":\"stolen\"}' where id=$1 returning id",[created.entityId])).rows.length,0);
    await asOwner(db);
    assert.equal((await db.query('select phone from public.customers where id=$1',[created.entityId])).rows[0].phone,'+12025550123');
    const invoice=(await db.query("insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency) values($1,$2,'INV-CUSTOM','2026-10-01','2026-10-06',100,'USD') returning *",[workspaceId,created.entityId])).rows[0];
    await asService(db);await addInbound(db,'invoice-custom','Set invoice project code ABC');
    const invoiceChanged=await write(db,{workspaceId,providerMessageId:'invoice-custom',quote:'Set invoice project code ABC',operation:'invoice.update',
      targetId:invoice.id,expectedUpdatedAt:invoice.updated_at.toISOString(),payload:{custom_fields:{project_code:'ABC'}}});
    assert.equal(invoiceChanged.ok,true);assert.equal(invoiceChanged.record.custom_fields.project_code,'ABC');
    assert.equal(Number(invoiceChanged.record.amount_paid),0);
    await setConfirmationMode(db,workspaceId,'buttons');
    await addInbound(db,'custom-proposal','Add purchase order');
    const proposal=await proposeWorkspaceChange(db,workspaceId,{operation:'update',table:'invoices',targetId:invoice.id,
      expectedUpdatedAt:invoiceChanged.updatedAt,values:{custom_fields:{purchase_order:'PO-7'}},requestMessageId:'custom-proposal',summary:'Add purchase order'});
    assert.equal(proposal.result.ok,true);
    const pending=(await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',[workspaceId,await verifiedCustomerId(db),phone])).rows[0];
    await addInbound(db,'custom-button','Confirm','oab1.custom');
    const confirmed=await write(db,{workspaceId,providerMessageId:'custom-button',operation:'pending.decide',authorizationKind:'button',
      interactionId:'oab1.custom',buttonDecision:'confirm',pendingId:pending.id,pendingVersion:pending.version});
    assert.equal(confirmed.ok,true);
    assert.deepEqual(confirmed.record.custom_fields,{project_code:'ABC',purchase_order:'PO-7'});
    await asOwner(db);
    assert.deepEqual((await db.query('select custom_fields from public.invoices where id=$1',[invoice.id])).rows[0].custom_fields,confirmed.record.custom_fields);
    assert.equal((await db.query('select count(*)::int n from public.payments where invoice_id=$1',[invoice.id])).rows[0].n,0);
  }finally{await db.close();}
});

async function boot({crlfLegacyWorkspaceData=false,supabaseDefaultGrants=false}={}){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role',true),'')
    $$;
    grant usage on schema auth,storage to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated,anon,service_role;
    grant execute on function auth.role() to authenticated,anon,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;`);
  if(supabaseDefaultGrants)await db.exec('alter default privileges in schema public grant all on tables to service_role');
  const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
  for(const name of migrations){
    if(crlfLegacyWorkspaceData&&name==='20261003141000_direct_owner_write.sql'){
      const current=(await db.query(`select
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)'::regprocedure) as propose,
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure) as decide`)).rows[0];
      await db.exec(current.propose.replace(/\n/g,'\r\n')+';\r\n'+current.decide.replace(/\n/g,'\r\n')+';');
      const legacy=(await db.query(`select
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)'::regprocedure) as propose,
        pg_catalog.pg_get_functiondef('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure) as decide`)).rows[0];
      assert.ok(legacy.propose.includes('\r\n'),'proposal legacy body should retain CRLF before upgrade');
      assert.ok(legacy.decide.includes('\r\n'),'decision legacy body should retain CRLF before upgrade');
    }
    const sql=await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
    await db.exec(sql.replace('create extension if not exists pgcrypto;',''));
  }
  await db.exec(`insert into auth.users(id) values('${owner}'),('${stranger}') on conflict(id) do nothing;
    set request.jwt.claim.role='authenticated';set role authenticated;set request.jwt.claim.sub='${owner}'`);
  const workspaceId=(await db.query("select (public.create_workspace('Direct writes','direct-write-test')).id")).rows[0].id;
  return {db,workspaceId};
}

async function asOwner(db,userId=owner){
  await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${userId}';set role authenticated`);
}
async function asService(db){
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
}
async function bindOwner(db,workspaceId){
  await asOwner(db);
  const verification=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  assert.match(verification.code,/^\d{6}$/);
  await asService(db);
  const result=(await db.query('select public.whatsapp_verify_owner_code($1,$2) as value',[phone,verification.code])).rows[0].value;
  assert.equal(result.ok,true);
}
async function addInbound(db,messageId,messageText,interactionId=null){
  await db.query(`insert into public.whatsapp_inbound_events(
    provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,interaction_id)
    values($1,'123456',$2,'text',$3,'processing',$4) on conflict(provider_message_id) do nothing`,[messageId,phone,messageText,interactionId]);
}
const keyFor=id=>`ownerwrite_${id.padEnd(32,'x').slice(0,32)}`;
async function write(db,{workspaceId,ownerId=owner,providerMessageId,quote,operation,targetId=null,expectedUpdatedAt=null,
  authorizationKind='instruction',interactionId=null,buttonDecision=null,pendingId=null,pendingVersion=null,payload={}}){
  await asService(db);
  return (await db.query(`select public.whatsapp_apply_direct_owner_write(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) as value`,[
    workspaceId,ownerId,phone,providerMessageId,interactionId,keyFor(providerMessageId),operation,targetId,expectedUpdatedAt,
    authorizationKind,quote,buttonDecision,pendingId,pendingVersion,JSON.stringify(payload)])).rows[0].value;
}

async function setConfirmationMode(db,workspaceId,mode){
  await asOwner(db);
  await db.query('update public.workspace_settings set owner_bot_preferences=owner_bot_preferences||$2::jsonb where workspace_id=$1',
    [workspaceId,JSON.stringify({confirmationMode:mode})]);
  await asService(db);
}

async function verifiedCustomerId(db){
  await db.exec('reset role');
  return (await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
}

async function seedPending(db,workspaceId,action){
  const customerId=await verifiedCustomerId(db);
  await db.exec('reset role');
  return (await db.query(`insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source)
    values($1,$2,$3,$4::jsonb,'whatsapp') returning id,version`,
    [workspaceId,customerId,phone,JSON.stringify(action)])).rows[0];
}

async function seedWorkspaceProposal(db,workspaceId,{operation,table,targetId=null,expectedUpdatedAt=null,values,requestMessageId}){
  const proposalId=randomUUID();
  await addInbound(db,requestMessageId,`Please ${operation} ${table}`);
  const customerId=await verifiedCustomerId(db);
  const pending=await seedPending(db,workspaceId,{type:'owner_workspace_data_change',proposalId,
    requestMessageId,sourceMessageId:requestMessageId,operation,table,
    expiresAt:new Date(Date.now()+5*60_000).toISOString()});
  await db.query(`insert into public.whatsapp_workspace_data_proposals(
    id,workspace_id,owner_id,customer_id,phone,operation,table_name,target_id,expected_updated_at,values,summary,
    request_message_id,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,now()+interval '5 minutes')`,
    [proposalId,workspaceId,owner,customerId,phone,operation,table,targetId,expectedUpdatedAt,
      JSON.stringify(values),`${operation} ${table}`,requestMessageId]);
  return {proposalId,pending};
}

async function proposeWorkspaceChange(db,workspaceId,{operation,table,targetId=null,expectedUpdatedAt=null,values,requestMessageId,summary}){
  const customerId=await verifiedCustomerId(db);
  const state=(await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',
    [workspaceId,customerId,phone])).rows[0];
  const result=(await db.query(`select public.whatsapp_workspace_data_propose(
    $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) as value`,[
    workspaceId,customerId,phone,requestMessageId,operation,table,targetId,expectedUpdatedAt,JSON.stringify(values),summary,
    state.generation,state.id,state.version])).rows[0].value;
  return {result,state};
}

async function seedLifecycleDelete(db,workspaceId,invoice,sourceMessageId){
  const proposalId=randomUUID();
  await addInbound(db,sourceMessageId,`Delete invoice ${invoice.invoice_number}`);
  const customerId=await verifiedCustomerId(db);
  const pending=await seedPending(db,workspaceId,{type:'owner_invoice_delete_proposal',proposalId,
    invoiceId:invoice.id,sourceMessageId,expiresAt:new Date(Date.now()+5*60_000).toISOString()});
  await db.query(`insert into public.invoice_lifecycle_proposals(
    id,workspace_id,owner_id,invoice_id,actor_phone,idempotency_key,request_message_id,expected_updated_at,
    invoice_number,customer_name,total_amount,currency,invoice_status,requires_exact_confirmation,had_payment,
    had_sent_reminder,state,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,false,false,'pending',now()+interval '5 minutes')`,
    [proposalId,workspaceId,owner,invoice.id,phone,`button_delete_${proposalId.replaceAll('-','')}`,
      sourceMessageId,invoice.updated_at,invoice.invoice_number,'Button Client',invoice.total_amount,invoice.currency,invoice.status]);
  return {proposalId,pending,customerId};
}

async function createDirectInvoice(db,workspaceId,{messageId,invoiceNumber,customerName,amount='55.00',currency='INR'}){
  const quote=invoiceNumber?`Create invoice ${invoiceNumber} for ${customerName}`:`Create invoice for ${customerName}`;
  await addInbound(db,messageId,quote);
  const payload={
    customer_name:customerName,issue_date:'2026-10-01',due_date:'2026-10-31',
    total_amount:amount,notes:`${customerName} original`,
  };
  if(invoiceNumber)payload.invoice_number=invoiceNumber;
  if(currency)payload.currency=currency;
  return write(db,{workspaceId,providerMessageId:messageId,quote,operation:'invoice.create',payload});
}

test('direct owner invoice writes are message-bound, scoped, idempotent, and reversible',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    const quote='Create invoice INV-DIRECT-001 for Nova Studio for 125.50 INR';
    await addInbound(db,'wa-direct-create-001',quote);
    const payload={invoice_number:'INV-DIRECT-001',customer_name:'Nova Studio',customer_email:'billing@nova.example',
      customer_phone:'+14155550244',issue_date:'2026-10-01',due_date:'2026-10-31',total_amount:'125.50',subtotal:'100.00',
      tax:'25.50',currency:'INR',notes:'Project phase one'};
    const created=await write(db,{workspaceId,providerMessageId:'wa-direct-create-001',quote,operation:'invoice.create',payload});
    assert.equal(created.ok,true,JSON.stringify(created));
    assert.equal(created.entityType,'invoice');
    assert.match(created.record.invoice_number,/^INV-2026-[0-9]{4,}$/);
    assert.equal(created.record.metadata.printed_invoice_number,'INV-DIRECT-001');
    assert.equal(created.record.total_amount,'125.50');
    const persistedCreated=(await db.query(`select i.id,i.total_amount::text as total_amount,c.name as customer_name
      from public.invoices i join public.customers c on c.workspace_id=i.workspace_id and c.id=i.customer_id
      where i.workspace_id=$1 and i.id=$2`,[workspaceId,created.entityId])).rows[0];
    assert.deepEqual(persistedCreated,{id:created.entityId,total_amount:'125.50',customer_name:'Nova Studio'});
    const replay=await write(db,{workspaceId,providerMessageId:'wa-direct-create-001',quote,operation:'invoice.create',payload});
    assert.equal(replay.replayed,true);
    const payloadDrift=await write(db,{workspaceId,providerMessageId:'wa-direct-create-001',quote,operation:'invoice.create',
      payload:{...payload,total_amount:'126.00',subtotal:'100.50',tax:'25.50'}});
    assert.equal(payloadDrift.code,'REPLAY_MISMATCH');
    assert.equal((await db.query("select count(*)::int as n from public.invoices where workspace_id=$1 and metadata->>'printed_invoice_number'='INV-DIRECT-001'",[workspaceId])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int as n from public.customers where workspace_id=$1 and name='Nova Studio'",[workspaceId])).rows[0].n,1);

    await addInbound(db,'wa-direct-negative-001','Do not delete invoice INV-DIRECT-001');
    const negative=await write(db,{workspaceId,providerMessageId:'wa-direct-negative-001',quote:'Delete it',
      operation:'invoice.delete',targetId:created.entityId,expectedUpdatedAt:created.updatedAt});
    assert.equal(negative.code,'INVALID_AUTHORIZATION');
    assert.equal((await db.query('select deleted_at from public.invoices where id=$1',[created.entityId])).rows[0].deleted_at,null);

    const canonicalNumber=created.record.invoice_number;
    await addInbound(db,'wa-direct-stale-001',`Update invoice ${canonicalNumber} notes`);
    const stale=await write(db,{workspaceId,providerMessageId:'wa-direct-stale-001',quote:`Update invoice ${canonicalNumber} notes`,
      operation:'invoice.update',targetId:created.entityId,expectedUpdatedAt:'2000-01-01T00:00:00Z',payload:{notes:'Changed'}});
    assert.equal(stale.code,'STALE');
    assert.equal((await db.query('select notes from public.invoices where id=$1',[created.entityId])).rows[0].notes,'Project phase one');

    await addInbound(db,'wa-direct-bad-type-001','Set invoice notes to a number');
    const badType=await write(db,{workspaceId,providerMessageId:'wa-direct-bad-type-001',
      quote:'Set invoice notes to a number',operation:'invoice.update',targetId:created.entityId,
      expectedUpdatedAt:created.updatedAt,payload:{notes:123}});
    assert.equal(badType.code,'INVALID');
    await addInbound(db,'wa-direct-delete-payload-001',`Delete invoice ${canonicalNumber}`);
    const deleteWithPayload=await write(db,{workspaceId,providerMessageId:'wa-direct-delete-payload-001',
      quote:`Delete invoice ${canonicalNumber}`,operation:'invoice.delete',targetId:created.entityId,
      expectedUpdatedAt:created.updatedAt,payload:{force:true}});
    assert.equal(deleteWithPayload.code,'INVALID');

    await addInbound(db,'wa-direct-delete-001',`Delete invoice ${canonicalNumber}`);
    const deleted=await write(db,{workspaceId,providerMessageId:'wa-direct-delete-001',quote:`Delete invoice ${canonicalNumber}`,
      operation:'invoice.delete',targetId:created.entityId,expectedUpdatedAt:created.updatedAt});
    assert.equal(deleted.ok,true,JSON.stringify(deleted));
    assert.ok((await db.query('select deleted_at from public.invoices where id=$1',[created.entityId])).rows[0].deleted_at);
    await db.exec('reset role');
    assert.equal((await db.query(`select state from public.invoice_lifecycle_proposals
      where workspace_id=$1 and invoice_id=$2`,[workspaceId,created.entityId])).rows[0].state,'deleted');

    const deletedUpdatedAt=(await db.query('select updated_at from public.invoices where id=$1',[created.entityId])).rows[0].updated_at;
    await addInbound(db,'wa-direct-restore-001',`Restore invoice ${canonicalNumber}`);
    const restored=await write(db,{workspaceId,providerMessageId:'wa-direct-restore-001',quote:`Restore invoice ${canonicalNumber}`,
      operation:'invoice.restore',targetId:created.entityId,expectedUpdatedAt:deletedUpdatedAt});
    assert.equal(restored.ok,true,JSON.stringify(restored));
    assert.equal((await db.query('select deleted_at from public.invoices where id=$1',[created.entityId])).rows[0].deleted_at,null);

    const expiredInvoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-direct-expired-invoice-001',
      invoiceNumber:'INV-EXPIRED-UNDO',customerName:'Expired Undo Client'});
    await addInbound(db,'wa-direct-expired-delete-001',`Delete invoice ${expiredInvoice.record.invoice_number}`);
    const expiredDelete=await write(db,{workspaceId,providerMessageId:'wa-direct-expired-delete-001',
      quote:`Delete invoice ${expiredInvoice.record.invoice_number}`,operation:'invoice.delete',targetId:expiredInvoice.entityId,
      expectedUpdatedAt:expiredInvoice.updatedAt});
    assert.equal(expiredDelete.ok,true,JSON.stringify(expiredDelete));
    await db.exec(`reset role;begin;
      insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
        values(pg_backend_pid(),txid_current(),'${expiredInvoice.entityId}');
      update public.invoices set deleted_at=clock_timestamp()-interval '31 days' where id='${expiredInvoice.entityId}';
      update public.invoice_lifecycle_proposals set deleted_at=(select deleted_at from public.invoices where id='${expiredInvoice.entityId}')
        where workspace_id='${workspaceId}' and invoice_id='${expiredInvoice.entityId}' and state='deleted';
      delete from app.invoice_lifecycle_write_context where backend_pid=pg_backend_pid()
        and transaction_id=txid_current() and invoice_id='${expiredInvoice.entityId}';commit;`);
    const expiredVersion=(await db.query('select updated_at from public.invoices where id=$1',[expiredInvoice.entityId])).rows[0].updated_at;
    await addInbound(db,'wa-direct-expired-restore-001',`Restore invoice ${expiredInvoice.record.invoice_number}`);
    const expiredRestore=await write(db,{workspaceId,providerMessageId:'wa-direct-expired-restore-001',
      quote:`Restore invoice ${expiredInvoice.record.invoice_number}`,operation:'invoice.restore',targetId:expiredInvoice.entityId,
      expectedUpdatedAt:expiredVersion});
    assert.equal(expiredRestore.code,'UNDO_EXPIRED');
    assert.ok((await db.query('select deleted_at from public.invoices where id=$1',[expiredInvoice.entityId])).rows[0].deleted_at);

    const foreignWorkspace='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    assert.equal((await write(db,{workspaceId:foreignWorkspace,providerMessageId:'wa-direct-foreign-001',quote:'Create invoice INV-FOREIGN',
      operation:'invoice.create',payload})).code,'DENIED');
    assert.equal((await write(db,{workspaceId,ownerId:stranger,providerMessageId:'wa-direct-wrong-owner-001',
      quote:'Create invoice INV-WRONG-OWNER',operation:'invoice.create',payload})).code,'DENIED');

    await addInbound(db,'wa-direct-revoked-owner-001','Create invoice after disconnect');
    await asOwner(db);
    assert.equal((await db.query('select public.owner_unbind_whatsapp($1) as unbound',[workspaceId])).rows[0].unbound,true);
    const revoked=await write(db,{workspaceId,providerMessageId:'wa-direct-revoked-owner-001',
      quote:'Create invoice after disconnect',operation:'invoice.create',payload});
    assert.equal(revoked.code,'DENIED');
  }finally{await db.close();}
});

test('button execution binds a real interaction to the current pending version and honors cancellation',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    const quote='Create invoice INV-BUTTON-001 for Button Client';
    await addInbound(db,'wa-button-source-001',quote);
    const action={type:'owner_invoice_create',sourceMessageId:'wa-button-source-001',idempotencyKey:'wa_owner_create_button_001',
      expiresAt:new Date(Date.now()+300000).toISOString(),invoice:{invoiceNumber:'INV-BUTTON-001',clientName:'Button Client',
        clientEmail:null,clientPhone:null,clientPhoneRaw:null,invoiceDate:'2026-10-01',dueDate:'2026-10-31',currency:'INR',
        total:55,subtotal:null,tax:null,outstanding:55,notes:null,lineItems:[],alreadyPaid:false,direction:'receivable'}};
    await asService(db);
    const binding=(await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
    const pending=(await db.query(`insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source)
      values($1,$2,$3,$4::jsonb,'whatsapp') returning id,version`,[workspaceId,binding.customer_id,phone,JSON.stringify(action)])).rows[0];
    await asOwner(db);
    await db.query(`update public.workspace_settings set owner_bot_preferences='{"confirmationMode":"buttons"}'::jsonb where workspace_id=$1`,[workspaceId]);
    await asService(db);
    await addInbound(db,'wa-button-confirm-001','Confirm','oab1.valid.confirm');
    const confirmed=await write(db,{workspaceId,providerMessageId:'wa-button-confirm-001',interactionId:'oab1.valid.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:pending.id,pendingVersion:pending.version});
    assert.equal(confirmed.ok,true,JSON.stringify(confirmed));
    assert.equal(confirmed.entityType,'invoice');
    assert.equal((await db.query("select count(*)::int as n from public.invoices where workspace_id=$1 and metadata->>'printed_invoice_number'='INV-BUTTON-001'",[workspaceId])).rows[0].n,1);
    assert.ok((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[pending.id])).rows[0].consumed_at);
  }finally{await db.close();}
});

test('direct customer, workspace settings, and AI settings updates are scoped and merge partial preferences',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    await db.exec('reset role');
    const ownerContact=(await db.query(`select c.id,c.updated_at from public.whatsapp_resolve_verified_owner($1) r
      join public.customers c on c.workspace_id=r.workspace_id and c.id=r.customer_id`,[phone])).rows[0];
    await addInbound(db,'wa-owner-contact-update-001','Rename my owner contact');
    const ownerUpdate=await write(db,{workspaceId,providerMessageId:'wa-owner-contact-update-001',
      quote:'Rename my owner contact',operation:'customer.update',targetId:ownerContact.id,
      expectedUpdatedAt:ownerContact.updated_at,payload:{name:'Reassigned Owner Contact'}});
    assert.equal(ownerUpdate.code,'DENIED');
    await addInbound(db,'wa-owner-contact-delete-001','Delete my owner contact');
    const ownerDelete=await write(db,{workspaceId,providerMessageId:'wa-owner-contact-delete-001',
      quote:'Delete my owner contact',operation:'customer.delete',targetId:ownerContact.id,
      expectedUpdatedAt:ownerContact.updated_at});
    assert.equal(ownerDelete.code,'DENIED');

    await db.exec('reset role');
    const flaggedContact=(await db.query(`insert into public.customers(workspace_id,name,metadata)
      values($1,'Flagged Owner Contact','{"whatsapp_owner":"true"}'::jsonb) returning id,updated_at`,[workspaceId])).rows[0];
    await addInbound(db,'wa-flagged-contact-update-001','Rename flagged contact');
    const flaggedUpdate=await write(db,{workspaceId,providerMessageId:'wa-flagged-contact-update-001',
      quote:'Rename flagged contact',operation:'customer.update',targetId:flaggedContact.id,
      expectedUpdatedAt:flaggedContact.updated_at,payload:{name:'Reassigned Flagged Contact'}});
    assert.equal(flaggedUpdate.code,'DENIED');

    await addInbound(db,'wa-customer-create-001','Add customer Cedar Works');
    const customer=await write(db,{workspaceId,providerMessageId:'wa-customer-create-001',quote:'Add customer Cedar Works',
      operation:'customer.create',payload:{name:'Cedar Works',company_name:'Cedar',email:'billing@cedar.example'}});
    assert.equal(customer.ok,true,JSON.stringify(customer));
    const customerId=customer.entityId;

    await addInbound(db,'wa-customer-update-001','Rename customer Cedar Works to Cedar Studio');
    const updatedCustomer=await write(db,{workspaceId,providerMessageId:'wa-customer-update-001',
      quote:'Rename customer Cedar Works to Cedar Studio',operation:'customer.update',targetId:customerId,
      expectedUpdatedAt:customer.updatedAt,payload:{name:'Cedar Studio'}});
    assert.equal(updatedCustomer.ok,true,JSON.stringify(updatedCustomer));
    assert.equal(updatedCustomer.record.name,'Cedar Studio');

    await addInbound(db,'wa-customer-delete-001','Remove customer Cedar Studio');
    const removedCustomer=await write(db,{workspaceId,providerMessageId:'wa-customer-delete-001',
      quote:'Remove customer Cedar Studio',operation:'customer.delete',targetId:customerId,
      expectedUpdatedAt:updatedCustomer.updatedAt});
    assert.equal(removedCustomer.ok,true,JSON.stringify(removedCustomer));
    assert.equal(removedCustomer.action,'customer.deleted');
    assert.equal(removedCustomer.record.name,'Cedar Studio');
    assert.equal((await db.query('select count(*)::int as n from public.customers where workspace_id=$1 and id=$2',[workspaceId,customerId])).rows[0].n,0);

    await asService(db);
    const settings=(await db.query('select updated_at,owner_bot_preferences from public.workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
    await addInbound(db,'wa-settings-update-001','Set currency to USD and shorten reminders');
    const reminderTemplate='Hello {{customer_name}}, invoice {{invoice_number}} is due {{due_date}}.';
    const settingsResult=await write(db,{workspaceId,providerMessageId:'wa-settings-update-001',
      quote:'Set currency to USD and shorten reminders',operation:'settings.update',targetId:workspaceId,
      expectedUpdatedAt:settings.updated_at,payload:{default_currency:'USD',default_timezone:'Asia/Kolkata',
        follow_up_preferences:{reminderTemplate,allowedWeekdays:[1,2,5],escalation:'pause',stopOnPayment:true},
        owner_bot_preferences:{assistantName:'Nia'}}});
    assert.equal(settingsResult.ok,true,JSON.stringify(settingsResult));
    assert.equal(settingsResult.record.default_currency,'USD');
    assert.equal(settingsResult.record.follow_up_preferences.reminderTemplate,reminderTemplate);
    assert.deepEqual(settingsResult.record.follow_up_preferences.allowedWeekdays,[1,2,5]);
    assert.equal(settingsResult.record.follow_up_preferences.escalation,'pause');
    assert.equal(settingsResult.record.follow_up_preferences.stopOnPayment,true);
    assert.equal(settingsResult.record.owner_bot_preferences.assistantName,'Nia');
    assert.equal(settingsResult.record.owner_bot_preferences.tone,settings.owner_bot_preferences.tone);

    const defaultCurrencyInvoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-default-currency-001',
      invoiceNumber:null,customerName:'Currency Client',amount:'55.00',currency:null});
    assert.equal(defaultCurrencyInvoice.ok,true,JSON.stringify(defaultCurrencyInvoice));
    assert.equal(defaultCurrencyInvoice.record.currency,'USD');
    assert.match(defaultCurrencyInvoice.record.invoice_number,/^INV-2026-[0-9]{4,}$/);
    assert.equal(defaultCurrencyInvoice.record.metadata.printed_invoice_number,undefined);

    await addInbound(db,'wa-ai-create-001','Set primary model to gemini-3.5-flash');
    const aiCreated=await write(db,{workspaceId,providerMessageId:'wa-ai-create-001',quote:'Set primary model to gemini-3.5-flash',
      operation:'ai_settings.update',targetId:workspaceId,payload:{primary_model:'gemini-3.5-flash',fallback_model:null}});
    assert.equal(aiCreated.ok,true,JSON.stringify(aiCreated));
    assert.equal(aiCreated.record.primary_model,'gemini-3.5-flash');
    await addInbound(db,'wa-ai-update-001','Set fallback model to space-bunny-free');
    const aiUpdated=await write(db,{workspaceId,providerMessageId:'wa-ai-update-001',quote:'Set fallback model to space-bunny-free',
      operation:'ai_settings.update',targetId:workspaceId,expectedUpdatedAt:aiCreated.updatedAt,
      payload:{fallback_model:'space-bunny-free'}});
    assert.equal(aiUpdated.ok,true,JSON.stringify(aiUpdated));
    assert.equal(aiUpdated.record.fallback_model,'space-bunny-free');
  }finally{await db.close();}
});

test('button owner invoice update and settlement verify pending version and current interaction',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);
    const invoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-button-update-invoice-001',
      invoiceNumber:'INV-BUTTON-UPDATE',customerName:'Button Update Client',amount:'70.00'});
    const paidInvoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-button-payment-invoice-001',
      invoiceNumber:'INV-BUTTON-PAYMENT',customerName:'Button Payment Client',amount:'80.00'});
    assert.equal(invoice.ok,true,JSON.stringify(invoice));
    assert.equal(paidInvoice.ok,true,JSON.stringify(paidInvoice));
    await setConfirmationMode(db,workspaceId,'buttons');

    const updateSource='wa-button-update-source-001';
    await addInbound(db,updateSource,'Please revise the notes');
    const updatePending=await seedPending(db,workspaceId,{type:'owner_invoice_update',sourceMessageId:updateSource,
      invoiceId:invoice.entityId,expectedUpdatedAt:invoice.updatedAt,changes:{notes:'Button updated notes'},
      expiresAt:new Date(Date.now()+5*60_000).toISOString()});
    const updateClick='oab1.update.confirm';
    await addInbound(db,'wa-button-update-click-001','Confirm',updateClick);
    const wrongInteraction=await write(db,{workspaceId,providerMessageId:'wa-button-update-click-001',interactionId:'oab1.other.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:updatePending.id,pendingVersion:updatePending.version});
    assert.equal(wrongInteraction.code,'INVALID_AUTHORIZATION');
    const staleVersion=await write(db,{workspaceId,providerMessageId:'wa-button-update-click-001',interactionId:updateClick,
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:updatePending.id,pendingVersion:updatePending.version+1});
    assert.equal(staleVersion.code,'NO_PENDING_ACTION');
    const updated=await write(db,{workspaceId,providerMessageId:'wa-button-update-click-001',interactionId:updateClick,
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:updatePending.id,pendingVersion:updatePending.version});
    assert.equal(updated.ok,true,JSON.stringify(updated));
    assert.equal(updated.action,'invoice.updated');
    assert.equal(updated.record.notes,'Button updated notes');

    const paymentSource='wa-button-payment-source-001';
    await addInbound(db,paymentSource,'Please mark this invoice as paid');
    const paymentPending=await seedPending(db,workspaceId,{type:'owner_invoice_payment',sourceMessageId:paymentSource,
      invoiceId:paidInvoice.entityId,expectedUpdatedAt:paidInvoice.updatedAt,changes:{status:'paid'},
      expiresAt:new Date(Date.now()+5*60_000).toISOString()});
    const paymentClick='oab1.payment.confirm';
    await addInbound(db,'wa-button-payment-click-001','Confirm',paymentClick);
    const paymentResult=await write(db,{workspaceId,providerMessageId:'wa-button-payment-click-001',interactionId:paymentClick,
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:paymentPending.id,pendingVersion:paymentPending.version});
    assert.equal(paymentResult.ok,true,JSON.stringify(paymentResult));
    assert.equal(paymentResult.action,'invoice.paid');
    assert.equal(paymentResult.record.status,'paid');
    assert.equal(paymentResult.record.amount_paid,'80.00');
    assert.equal((await db.query('select count(*)::int as n from public.payments where workspace_id=$1 and invoice_id=$2',[workspaceId,paidInvoice.entityId])).rows[0].n,1);
  }finally{await db.close();}
});

test('button AI settings, cancel, expiry, and invoice delete use the stored proposal and exact interaction',async()=>{
  const {db,workspaceId}=await boot({crlfLegacyWorkspaceData:true});
  try{
    await bindOwner(db,workspaceId);
    await addInbound(db,'wa-button-ai-initial-001','Set primary model to gemini-3.5-flash');
    const aiCreated=await write(db,{workspaceId,providerMessageId:'wa-button-ai-initial-001',
      quote:'Set primary model to gemini-3.5-flash',operation:'ai_settings.update',targetId:workspaceId,
      payload:{primary_model:'gemini-3.5-flash',fallback_model:null}});
    assert.equal(aiCreated.ok,true,JSON.stringify(aiCreated));
    const invoice=await createDirectInvoice(db,workspaceId,{messageId:'wa-button-delete-invoice-001',
      invoiceNumber:'INV-BUTTON-DELETE',customerName:'Button Delete Client'});
    assert.equal(invoice.ok,true,JSON.stringify(invoice));
    await setConfirmationMode(db,workspaceId,'buttons');

    const aiProposal=await seedWorkspaceProposal(db,workspaceId,{operation:'update',table:'workspace_ai_settings',
      targetId:workspaceId,expectedUpdatedAt:aiCreated.updatedAt,
      values:{primary_model:'gemini-3.5-flash-lite',fallback_model:'space-bunny-free'},
      requestMessageId:'wa-button-ai-request-001'});
    await addInbound(db,'wa-button-ai-click-001','Confirm','oab1.ai.confirm');
    const aiResult=await write(db,{workspaceId,providerMessageId:'wa-button-ai-click-001',interactionId:'oab1.ai.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:aiProposal.pending.id,
      pendingVersion:aiProposal.pending.version});
    assert.equal(aiResult.ok,true,JSON.stringify(aiResult));
    assert.equal(aiResult.action,'ai_settings.updated');
    assert.equal(aiResult.record.primary_model,'gemini-3.5-flash-lite');
    assert.equal(aiResult.record.fallback_model,'space-bunny-free');

    await asOwner(db);
    await db.query(`update public.workspace_settings set owner_bot_preferences='{"assistantName":"Nia","tone":"friendly","confirmationMode":"buttons"}'::jsonb
      where workspace_id=$1`,[workspaceId]);
    await asService(db);
    const settingsBefore=(await db.query(`select updated_at,owner_bot_preferences from public.workspace_settings where workspace_id=$1`,[workspaceId])).rows[0];
    const template='Hello {{customer_name}} - invoice {{invoice_number}} is due {{due_date}}.';
    await addInbound(db,'wa-button-settings-request-001','Update workspace settings');
    const settingsProposal=await proposeWorkspaceChange(db,workspaceId,{operation:'update',table:'workspace_settings',
      targetId:workspaceId,expectedUpdatedAt:settingsBefore.updated_at,
      values:{business_name:'Northside Billing',owner_bot_preferences:{assistantName:'Avery'},
        follow_up_preferences:{reminderTemplate:template,allowedWeekdays:[1,2,5],escalation:'pause',stopOnPayment:true}},
      requestMessageId:'wa-button-settings-request-001',summary:'Update workspace settings'});
    assert.equal(settingsProposal.result.ok,true,JSON.stringify(settingsProposal.result));
    const settingsPending=await db.query('select * from public.whatsapp_load_pending_action_state($1,$2,$3)',
      [workspaceId,await verifiedCustomerId(db),phone]);
    assert.equal(settingsPending.rows[0].action.type,'owner_workspace_data_change');
    await addInbound(db,'wa-button-settings-click-001','Confirm','oab1.settings.confirm');
    const settingsResult=await write(db,{workspaceId,providerMessageId:'wa-button-settings-click-001',
      interactionId:'oab1.settings.confirm',operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',
      pendingId:settingsPending.rows[0].id,pendingVersion:settingsPending.rows[0].version});
    assert.equal(settingsResult.ok,true,JSON.stringify(settingsResult));
    assert.equal(settingsResult.action,'settings.updated');
    assert.equal(settingsResult.record.business_name,'Northside Billing');
    assert.equal(settingsResult.record.follow_up_preferences.reminderTemplate,template);
    assert.equal(settingsResult.record.owner_bot_preferences.assistantName,'Avery');
    assert.equal(settingsResult.record.owner_bot_preferences.tone,'friendly');
    assert.equal(settingsResult.record.owner_bot_preferences.confirmationMode,'buttons');
    assert.deepEqual(settingsResult.record.follow_up_preferences.allowedWeekdays,[1,2,5]);
    assert.equal(settingsResult.record.follow_up_preferences.escalation,'pause');
    assert.equal(settingsResult.record.follow_up_preferences.stopOnPayment,true);

    const cancelProposal=await seedWorkspaceProposal(db,workspaceId,{operation:'create',table:'customers',
      values:{name:'Cancelled Customer'},requestMessageId:'wa-button-cancel-request-001'});
    await addInbound(db,'wa-button-cancel-click-001','Cancel','oab1.cancel.cancel');
    const cancelled=await write(db,{workspaceId,providerMessageId:'wa-button-cancel-click-001',interactionId:'oab1.cancel.cancel',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'cancel',pendingId:cancelProposal.pending.id,
      pendingVersion:cancelProposal.pending.version});
    assert.equal(cancelled.ok,true,JSON.stringify(cancelled));
    assert.equal(cancelled.action,'pending.cancelled');
    await db.exec('reset role');
    assert.equal((await db.query('select state from public.whatsapp_workspace_data_proposals where id=$1',[cancelProposal.proposalId])).rows[0].state,'cancelled');
    assert.equal((await db.query("select count(*)::int as n from public.customers where workspace_id=$1 and name='Cancelled Customer'",[workspaceId])).rows[0].n,0);

    const deleteProposal=await seedLifecycleDelete(db,workspaceId,invoice.record,'wa-button-delete-request-001');
    await addInbound(db,'wa-button-delete-click-001','Confirm','oab1.delete.confirm');
    const deleted=await write(db,{workspaceId,providerMessageId:'wa-button-delete-click-001',interactionId:'oab1.delete.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:deleteProposal.pending.id,
      pendingVersion:deleteProposal.pending.version});
    assert.equal(deleted.ok,true,JSON.stringify(deleted));
    assert.equal(deleted.action,'invoice.deleted');
    assert.ok(deleted.record.deleted_at);
    assert.ok((await db.query('select deleted_at from public.invoices where workspace_id=$1 and id=$2',[workspaceId,invoice.entityId])).rows[0].deleted_at);

    const expiredSource='wa-button-expired-source-001';
    await addInbound(db,expiredSource,'Create another invoice');
    const expiredPending=await seedPending(db,workspaceId,{type:'owner_invoice_create',sourceMessageId:expiredSource,
      expiresAt:new Date(Date.now()-60_000).toISOString()});
    await addInbound(db,'wa-button-expired-click-001','Confirm','oab1.expired.confirm');
    const expired=await write(db,{workspaceId,providerMessageId:'wa-button-expired-click-001',interactionId:'oab1.expired.confirm',
      operation:'pending.decide',authorizationKind:'button',buttonDecision:'confirm',pendingId:expiredPending.id,
      pendingVersion:expiredPending.version});
    assert.equal(expired.code,'EXPIRED');
    assert.ok((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[expiredPending.id])).rows[0].consumed_at);
  }finally{await db.close();}
});

test('atomic owner batch persists all records, rolls back collisions and stale targets, rejects foreign scope, and replays one receipt',async()=>{
  const {db,workspaceId}=await boot();
  try{
    await bindOwner(db,workspaceId);await setConfirmationMode(db,workspaceId,'direct');
    const first=await createDirectInvoice(db,workspaceId,{messageId:'batch-first',invoiceNumber:'123113',customerName:'MineralTree'});
    const second=await createDirectInvoice(db,workspaceId,{messageId:'batch-second',invoiceNumber:'GST-3425-26',customerName:'Shiv Engineering'});
    const operations=[first,second].map((row,index)=>({operation:'invoice.update',targetId:row.entityId,expectedUpdatedAt:row.updatedAt,payload:{invoice_number:`INV-2026-000${index+3}`,custom_fields:{batch_note:'isolated fixture'}}}));
    const batch=async(id,items=operations,actor=owner)=>{
      await asService(db);await addInbound(db,id,'Renumber both invoices like John');
      return (await db.query('select public.whatsapp_apply_owner_batch($1,$2,$3,$4,$5,$6::jsonb) value',[workspaceId,actor,phone,id,'Renumber both invoices like John',JSON.stringify(items)])).rows[0].value;
    };
    assert.equal((await batch('batch-foreign',operations,stranger)).code,'DENIED');
    await asOwner(db,stranger);
    const foreignWorkspace=(await db.query("select (public.create_workspace('Foreign batch fixture','foreign-batch')).id")).rows[0].id;
    const foreignCustomer=(await db.query("insert into public.customers(workspace_id,name) values($1,'Foreign customer') returning id",[foreignWorkspace])).rows[0].id;
    const foreignInvoice=(await db.query("insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency) values($1,$2,'FOREIGN-17','2026-10-01','2026-10-31',50,'USD') returning id,updated_at,invoice_number",[foreignWorkspace,foreignCustomer])).rows[0];
    const crossTenant=structuredClone(operations);crossTenant[1].targetId=foreignInvoice.id;crossTenant[1].expectedUpdatedAt=foreignInvoice.updated_at.toISOString();
    const crossResult=await batch('batch-cross-tenant',crossTenant);assert.equal(crossResult.ok,false);assert.equal(crossResult.rolledBack,true);
    await asOwner(db,stranger);assert.equal((await db.query('select invoice_number from public.invoices where id=$1',[foreignInvoice.id])).rows[0].invoice_number,foreignInvoice.invoice_number);
    await asService(db);
    const collision=structuredClone(operations);collision[1].payload.invoice_number=collision[0].payload.invoice_number;
    const failed=await batch('batch-collision',collision);assert.equal(failed.ok,false,JSON.stringify(failed));assert.equal(failed.rolledBack,true);
    assert.equal((await db.query('select invoice_number from public.invoices where id=$1',[first.entityId])).rows[0].invoice_number,first.record.invoice_number);
    assert.equal((await db.query('select count(*)::int n from public.whatsapp_direct_write_receipts where provider_message_id=$1',['batch-collision'])).rows[0].n,0);
    const stale=structuredClone(operations);stale[1].expectedUpdatedAt='2000-01-01T00:00:00Z';
    const staleResult=await batch('batch-stale',stale);assert.equal(staleResult.code,'STALE');assert.equal(staleResult.rolledBack,true);
    assert.equal((await db.query('select invoice_number from public.invoices where id=$1',[first.entityId])).rows[0].invoice_number,first.record.invoice_number);
    const denied=structuredClone(operations);denied[1].targetId=randomUUID();assert.equal((await batch('batch-wrong-target',denied)).ok,false);
    const status=structuredClone(operations);status[1].payload.status='unpaid';assert.equal((await batch('batch-financial',status)).code,'INVALID');
    const result=await batch('batch-success');assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.completed,true);assert.equal(result.results.length,2);
    assert.equal((await batch('batch-success')).replayed,true);
    const mismatch=structuredClone(operations);mismatch[0].payload.invoice_number='INV-2026-0009';assert.equal((await batch('batch-success',mismatch)).code,'REPLAY_MISMATCH');
    assert.equal((await db.query('select count(*)::int n from public.whatsapp_direct_write_receipts where provider_message_id=$1',['batch-success'])).rows[0].n,1);
    await asOwner(db);assert.deepEqual((await db.query('select invoice_number,custom_fields from public.invoices where id=any($1::uuid[]) order by invoice_number',[[first.entityId,second.entityId]])).rows.map(row=>row.invoice_number),['INV-2026-0003','INV-2026-0004']);
    await assert.rejects(db.query('select public.whatsapp_apply_owner_batch($1,$2,$3,$4,$5,$6)',[workspaceId,owner,phone,'batch-success','Renumber both invoices like John',JSON.stringify(operations)]));
    await assert.rejects(db.query('select app.whatsapp_apply_owner_batch_operation($1,$2,$3,$4,null,$5,$6,$7,$8,$9,$10,null,null,null,$11)',[workspaceId,owner,phone,'batch-success','ownerwrite_private','invoice.update',first.entityId,first.updatedAt,'instruction','Renumber both invoices like John','{}']));
    await asOwner(db,stranger);assert.equal((await db.query('select * from public.invoices where workspace_id=$1',[workspaceId])).rows.length,0);
  }finally{await db.close();}
});


test('expired owner proposals clear metadata on verified new turns without changing invoices or payments',async()=>{
  const {db,workspaceId,created}=await reopeningFixture();
  try{
    await asOwner(db);await db.query('select public.record_invoice_payment($1,$2,$3,$4,$5,false)',[workspaceId,created.entityId,55,'test transfer','expiry-payment']);
    await asService(db);await addInbound(db,'expiry-prepare','Mark invoice unpaid');
    const proposal=await reopen(db,{workspaceId,messageId:'expiry-prepare',message:'Mark invoice unpaid',action:'prepare',invoiceId:created.entityId});assert.equal(proposal.ok,true);
    const snapshot=(await db.query('select to_jsonb(i) invoice,(select jsonb_agg(to_jsonb(p)) from public.payments p where p.invoice_id=i.id) payments from public.invoices i where id=$1',[created.entityId])).rows[0];
    const expire=async(id,actor=owner,text='Review my business')=>{
      await asService(db);await addInbound(db,id,'Review my business');
      return (await db.query('select public.whatsapp_expire_owner_pending($1,$2,$3,$4,$5) value',[workspaceId,actor,phone,id,text])).rows[0].value;
    };
    assert.equal((await expire('expiry-active')).expired,false);
    await db.exec('reset role');await db.query("update public.invoice_reopening_proposals set expires_at=clock_timestamp()-interval '1 second' where id=$1",[proposal.proposalId]);
    assert.equal((await expire('expiry-denied',stranger)).code,'DENIED');
    assert.equal((await expire('expiry-wrong-text',owner,'Invented instruction')).code,'DENIED');
    const result=await expire('expiry-valid');assert.equal(result.expired,true);assert.equal(result.businessChangeApplied,false);
    assert.equal((await db.query('select state from public.invoice_reopening_proposals where id=$1',[proposal.proposalId])).rows[0].state,'expired');
    assert.equal((await db.query("select count(*)::int n from public.whatsapp_pending_actions where workspace_id=$1 and action->>'type'='owner_invoice_reopen' and consumed_at is null",[workspaceId])).rows[0].n,0);
    assert.deepEqual((await db.query('select to_jsonb(i) invoice,(select jsonb_agg(to_jsonb(p)) from public.payments p where p.invoice_id=i.id) payments from public.invoices i where id=$1',[created.entityId])).rows[0],snapshot);
    assert.equal((await db.query('select count(*)::int n from public.payment_reversals where workspace_id=$1',[workspaceId])).rows[0].n,0);
    assert.equal((await expire('expiry-valid')).expired,false);
    await addInbound(db,'expiry-new-preview','Mark invoice unpaid');
    const fresh=await reopen(db,{workspaceId,messageId:'expiry-new-preview',message:'Mark invoice unpaid',action:'prepare',invoiceId:created.entityId});assert.equal(fresh.ok,true,JSON.stringify(fresh));assert.notEqual(fresh.proposalId,proposal.proposalId);
    await db.exec('reset role');await db.query('update public.whatsapp_pending_actions set consumed_at=clock_timestamp() where workspace_id=$1 and consumed_at is null',[workspaceId]);
    const expiredSettings=await seedPending(db,workspaceId,{type:'owner_settings_update',expiresAt:new Date(Date.now()-60000).toISOString()});
    await expire('expiry-legacy');assert((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[expiredSettings.id])).rows[0].consumed_at);
    const saving=await seedPending(db,workspaceId,{type:'invoice_review_draft',stage:'saving',expiresAt:new Date(Date.now()-60000).toISOString()});
    await expire('expiry-saving');
    assert.equal((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[saving.id])).rows[0].consumed_at,null);
    await db.exec('reset role');await db.query('update public.whatsapp_pending_actions set consumed_at=clock_timestamp() where id=$1',[saving.id]);
    const unknown=await seedPending(db,workspaceId,{type:'future_unsupported_kind',expiresAt:new Date(Date.now()-60000).toISOString()});
    await expire('expiry-unknown');
    assert.equal((await db.query('select consumed_at from public.whatsapp_pending_actions where id=$1',[unknown.id])).rows[0].consumed_at,null);
    await asOwner(db);await assert.rejects(db.query('select public.whatsapp_expire_owner_pending($1,$2,$3,$4,$5)',[workspaceId,owner,phone,'expiry-valid','Review my business']));
  }finally{await db.close();}
});
