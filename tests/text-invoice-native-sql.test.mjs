import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createDirectOwnerWriteAdapter} from '../automation/whatsapp/direct-owner-write.mjs';
import {ownerCalendar} from '../automation/whatsapp/workspace-records.mjs';
import {CF_PRIMARY_MODEL} from '../ai/provider.mjs';

test('owner text -> workspace tool -> Supabase SDK -> SQL -> verified reply, without outbound delivery',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+919871367051';
  const clock=()=>new Date('2026-10-18T12:18:00Z');
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Disposable QA','text-qa')).id")).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
    let providerCalls=0;
    const handler=createOwnerMessageHandler({supabase,clock,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:()=>({async generate({messages}){
        providerCalls++;
        if(messages.some(item=>item.role==='tool'))return {model:CF_PRIMARY_MODEL,content:'Created invoice.'};
        return {model:CF_PRIMARY_MODEL,toolCalls:[{id:'text-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'invoices',values:{invoiceNumber:'WRONG',clientName:'WRONG',total:999999,dueDate:'2099-12-01',currency:'INR'}})}}]};
      }})});
    const turn=async(messageId,message)=>{
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline',$2,'text',$3,'processing')",[messageId,phone,message]);
      return handler({workspaceId,ownerId,customerId,phone,messageId,message});
    };
    for(const [index,message] of [
      'New invoice QA-VERIFY-001 for QA Text Customer, amount Rs 2,500, due 25 October 2026',
      'QA-EDGE-002 नया invoice 🧾🔥 for QA Emoji Customer ₹1,200 due kal, please check',
      'new invoice QA-REPRO-001, QA Repro Customer, Rs 1,500, due 25 Oct',
      'new invoice QA-REPRO-002 for QA Repro Customer, Rs 1,500, due 25 Oct',
      'new invoice QA-RETEST-001 for QA Media Customer, Rs 1,500, due 30 Oct',
    ].entries()){
      const reply=await turn(`qa-native-${index}`,message);
      assert.match(reply.answer,/Created invoice/);
      const saved=(await db.query('select result from whatsapp_direct_write_receipts where provider_message_id=$1',[`qa-native-${index}`])).rows[0].result;
      assert.equal(saved.ok,true);assert.equal(Number(saved.record.total_amount),[2500,1200,1500,1500,1500][index]);
      assert.equal(saved.record.due_date,index===1?'2026-10-19':index===4?'2026-10-30':'2026-10-25');
      assert.equal(saved.record.invoice_number,['QA-VERIFY-001','QA-EDGE-002','QA-REPRO-001','QA-REPRO-002','QA-RETEST-001'][index]);
      assert.equal(saved.record.metadata.source_invoice_number,['QA-VERIFY-001','QA-EDGE-002','QA-REPRO-001','QA-REPRO-002','QA-RETEST-001'][index]);
      assert.equal(saved.record.status,'draft');
      const persisted=(await db.query('select i.*,c.name customer_name from invoices i join customers c on c.id=i.customer_id and c.workspace_id=i.workspace_id where i.id=$1',[saved.record.id])).rows[0];
      assert.equal(persisted.invoice_number,saved.record.invoice_number);
      assert.equal(persisted.workspace_id,workspaceId);assert.equal(persisted.customer_id,saved.record.customer_id);
      assert.equal(persisted.customer_name,['QA Text Customer','QA Emoji Customer','QA Repro Customer','QA Repro Customer','QA Media Customer'][index]);
      assert.equal(persisted.currency,'INR');assert.equal(Number(persisted.total_amount),Number(saved.record.total_amount));
      assert.equal(new Date(persisted.due_date).toISOString().slice(0,10),saved.record.due_date);
      const calls=providerCalls;
      const replay=await handler({workspaceId,ownerId,customerId,phone,messageId:`qa-native-${index}`,message});
      assert.equal(replay.replayed,true);assert.equal(replay.answer,reply.answer);assert.equal(providerCalls,calls);
    }
    const existingCustomer=await turn('qa-native-existing','New invoice QA-EDGE-003 for QA Text Customer, amount INR 2,500, due 2026-10-25');
    assert.match(existingCustomer.answer,/Created invoice/);
    const sameCustomer=(await db.query("select customer_id,status from invoices where metadata->>'source_invoice_number' in ('QA-VERIFY-001','QA-EDGE-003')")).rows;
    assert.equal(sameCustomer.length,2);assert.equal(sameCustomer[0].customer_id,sameCustomer[1].customer_id);
    assert.ok(sameCustomer.every(row=>row.status==='draft'));
    const duplicate=await turn('qa-native-duplicate','New invoice QA-EDGE-002 for QA Emoji Customer, amount Rs 1,200, due 25 October 2026');
    assert.match(duplicate.answer,/already exists/);
    const repeated=await turn('qa-native-media-repeated','new invoice QA-RETEST-001 for QA Media Customer, Rs 1,500, due 30 Oct');
    assert.match(repeated.answer,/already exists/);
    const otherCustomerDuplicate=await turn('qa-native-duplicate-other-customer','new invoice QA-RETEST-001 for Different Customer, Rs 1,500, due 30 Oct');
    assert.match(otherCustomerDuplicate.answer,/already exists/);
    assert.equal((await db.query("select count(*)::int n from invoices where invoice_number='QA-RETEST-001'")).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from customers where name='Different Customer'")).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from invoices where metadata->>'source_invoice_number'='QA-RETEST-001'")).rows[0].n,1);
    const beforeTypo=(await db.query('select count(*)::int n from invoices')).rows[0].n;
    const typo=await turn('qa-native-name-confirmation','new invoice QA-TYPO-001 for QA Mdeia Customer, Rs 1,500, due 30 Oct');
    assert.match(typo.answer,/Did you mean QA Media Customer\? Reply with the full name/);
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,beforeTypo);
    assert.equal((await db.query("select count(*)::int n from whatsapp_direct_write_receipts where provider_message_id='qa-native-name-confirmation'")).rows[0].n,0);
    // Reproduce the broad SQL uniqueness handler without modifying its source:
    // payment capability fingerprints must stay valid after the invoice fix.
    await db.exec(`create function public.qa_customer_unique_failure() returns trigger language plpgsql as $$
      begin raise unique_violation using message='synthetic customer conflict';end;$$;
      create trigger qa_customer_unique_failure before insert on public.customers for each row execute function public.qa_customer_unique_failure();`);
    const unavailable=await turn('qa-native-customer-unique','New invoice QA-NONEXISTENT for No Invoice QA, amount Rs 100, due 25 October 2026');
    assert.match(unavailable.answer,/couldn’t check if the invoice was created/);assert.doesNotMatch(unavailable.answer,/already exists/);
    assert.equal((await db.query("select count(*)::int n from customers where name='No Invoice QA'")).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_direct_write_receipts where provider_message_id='qa-native-customer-unique'")).rows[0].n,0);
    await db.exec('drop trigger qa_customer_unique_failure on public.customers');
    const retry=await turn('qa-native-customer-unique-retry','New invoice QA-NONEXISTENT for No Invoice QA, amount Rs 100, due 25 October 2026');
    assert.match(retry.answer,/Created invoice QA-NONEXISTENT\. Total: INR 100\.00\./);
    const retryAgain=await turn('qa-native-customer-unique-repeated','New invoice QA-NONEXISTENT for No Invoice QA, amount Rs 100, due 25 October 2026');
    assert.match(retryAgain.answer,/already exists/);
    assert.equal((await db.query("select count(*)::int n from invoices where metadata->>'source_invoice_number'='QA-NONEXISTENT'")).rows[0].n,1);
    assert.deepEqual((await db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:4,bookkeepingInstructions:1});
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,7);
    assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
    assert.equal(f.errors.length,0,JSON.stringify(f.errors));
    assert.equal(providerCalls,0,'complete owner text must not depend on garbage planner fields or a final model reply');
    await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"buttons\"}' where workspace_id=$1",[workspaceId]);
    let confirmationModelCalls=0;
    const confirming=createOwnerMessageHandler({supabase,clock:()=>new Date(),env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:()=>({async generate({messages}){
        confirmationModelCalls++;
        const tool=messages.findLast(item=>item.role==='tool');
        if(!tool)return {model:CF_PRIMARY_MODEL,toolCalls:[{id:'confirm-existing-proposal',type:'function',function:{name:'workspaceData',arguments:'{"operation":"confirm"}'}}]};
        const result=JSON.parse(tool.content);
        assert.equal(result.ok,true);assert.equal(result.action,'invoice_created');
        return {model:CF_PRIMARY_MODEL,content:`Created invoice ${result.invoiceNumber}.`};
      }})});
    const confirmedTurn=async(messageId,message)=>{
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline',$2,'text',$3,'processing')",[messageId,phone,message]);
      return confirming({workspaceId,ownerId,customerId,phone,messageId,message});
    };
    const proposed=await confirmedTurn('qa-native-confirm-propose','new invoice QA-CONFIRM-001 for QA Confirm Customer, Rs 1,500, due 30 Oct');
    assert.match(proposed.answer,/Reply yes.*cancel/);assert.equal(confirmationModelCalls,0);
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,7);
    const pending=(await db.query("select action from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null",[workspaceId])).rows[0].action;
    assert.equal(pending.type,'owner_invoice_create');assert.equal(pending.invoice.invoiceNumber,'QA-CONFIRM-001');
    const confirmed=await confirmedTurn('qa-native-confirm-yes','yes');assert.match(confirmed.answer,/Created invoice/);
    assert.equal((await db.query("select invoice_number from invoices where metadata->>'assistant_idempotency_key'=$1",[pending.idempotencyKey])).rows[0].invoice_number,'QA-CONFIRM-001');
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,8);
    const replayed=await confirming({workspaceId,ownerId,customerId,phone,messageId:'qa-native-confirm-yes',message:'yes'});
    assert.equal(replayed.replayed,true);assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,8);
    const autoProposal=await confirmedTurn('qa-native-confirm-auto','new invoice for QA Auto Customer, Rs 1,500, due 30 Oct');
    assert.match(autoProposal.answer,/Reply yes/);
    await confirmedTurn('qa-native-confirm-auto-yes','yes');
    const automatic=(await db.query("select invoice_number from invoices where metadata->>'client_name'='QA Auto Customer'")).rows[0];
    assert.ok(automatic);assert.notEqual(automatic.invoice_number,'AUTO');assert.doesNotMatch(automatic.invoice_number,/^AUTO-/);
  }finally{await db.close();}
});

test('unnumbered owner invoice retries reuse only an exact scoped instruction and verified receipt',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f;
  let today='2026-10-18';
  try{
    const seedOwner=async(phone,label)=>{
      const ownerId=randomUUID();
      await db.query('insert into auth.users(id) values($1)',[ownerId]);
      await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
      const workspaceId=(await db.query('select (public.create_workspace($1,$2)).id',[label,label.toLowerCase()])).rows[0].id;
      const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
      await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
      assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
      const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
      await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
      return {workspaceId,ownerId,customerId,phone};
    };
    const first=await seedOwner('+919871367052','RetryQA');
    const second=await seedOwner('+919871367053','OtherRetryQA');
    const lossy=Object.create(supabase);
    lossy.rpc=async(name,args)=>{
      const result=await supabase.rpc(name,args);
      if(name==='whatsapp_apply_direct_owner_write'&&args.p_provider_message_id==='unnumbered-lost-ack')
        throw Error('Simulated lost response after the committed write');
      return result;
    };
    const handler=createOwnerMessageHandler({supabase:lossy,clock:()=>new Date(today+'T12:18:00Z'),env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:()=>({async generate(){throw Error('Complete owner invoice instructions do not need a planner');}})});
    const turn=async(scope,messageId,message)=>{
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline',$2,'text',$3,'processing')",[messageId,scope.phone,message]);
      return handler({...scope,messageId,message});
    };
    const count=async(scope)=>(await db.query('select count(*)::int n from invoices where workspace_id=$1',[scope.workspaceId])).rows[0].n;
    const message='new invoice for Retry Customer, Rs 1,500, due 30 Oct';
    const lost=await turn(first,'unnumbered-lost-ack',message);
    assert.match(lost.answer,/couldn’t check if the invoice was created/);assert.doesNotMatch(lost.answer,/Created invoice/);
    assert.equal(await count(first),1);
    assert.match((await db.query('select invoice_number from invoices where workspace_id=$1',[first.workspaceId])).rows[0].invoice_number,/^INV-2026-\d{4}$/);
    const beforeReplay=(await db.query('select * from invoices where workspace_id=$1 order by id',[first.workspaceId])).rows;
    const requestStart=f.requests.length;
    const retry=await turn(first,'unnumbered-new-id',message);
    assert.match(retry.answer,/already exists\. Total: INR 1500\.00\. No new invoice was created\./);assert.doesNotMatch(retry.answer,/Created invoice/);assert.equal(await count(first),1);
    assert.match((await turn(first,'unnumbered-repeated',message)).answer,/already exists/);assert.equal(await count(first),1);
    assert.deepEqual((await db.query('select * from invoices where workspace_id=$1 order by id',[first.workspaceId])).rows,beforeReplay);
    assert.equal(f.requests.slice(requestStart).filter(request=>/\/rpc\/whatsapp_apply_(?:direct_owner|owner_contact)_write$/.test(new URL(request.url).pathname)).length,0,'receipt reuse performs zero write RPCs');
    const original=(await db.query("select result->>'entityId' id from whatsapp_direct_write_receipts where provider_message_id='unnumbered-lost-ack'")).rows[0].id;
    const receiptBeforeSync=(await db.query("select result from whatsapp_direct_write_receipts where provider_message_id='unnumbered-lost-ack'")).rows[0].result;
    await db.query(`update invoices set metadata=metadata||$2::jsonb where id=$1`,[original,JSON.stringify({
      bookkeeping_sync_status:'synced',bookkeeping_sync_attempts:1,bookkeeping_sync_error:null,
      bookkeeping_provider:'zoho_books',bookkeeping_record_id:'remote-6783',bookkeeping_synced_at:'2026-10-24T01:48:14.459282+00:00'})]);
    const synced=(await db.query('select * from invoices where id=$1',[original])).rows[0];
    assert.notEqual(synced.updated_at.toISOString(),new Date(receiptBeforeSync.updatedAt).toISOString());
    const syncReplayStart=f.requests.length;
    const syncRetry=await turn(first,'unnumbered-after-bookkeeping-sync',message);
    assert.equal(syncRetry.answer,`Invoice ${synced.invoice_number} already exists. Total: INR 1500.00. No new invoice was created.`);
    assert.equal(await count(first),1);
    assert.deepEqual((await db.query('select * from invoices where id=$1',[original])).rows[0],synced);
    assert.equal(f.requests.slice(syncReplayStart).filter(request=>/\/rpc\/whatsapp_apply_(?:direct_owner|owner_contact)_write$/.test(new URL(request.url).pathname)).length,0);
    const redelivery=await handler({...first,messageId:'unnumbered-new-id',message});
    assert.equal(redelivery.replayed,true);assert.equal(await count(first),1);
    const changed=await turn(first,'unnumbered-changed-facts',message.replace('1,500','1,510'));
    assert.match(changed.answer,/Created invoice/);assert.equal(await count(first),2);
    today='2026-10-19';
    assert.match((await turn(first,'unnumbered-another-day',message)).answer,/already exists/);assert.equal(await count(first),2);
    assert.match((await turn(second,'unnumbered-another-business',message)).answer,/Created invoice/);assert.equal(await count(second),1);
    await db.exec(`create function public.qa_unnumbered_customer_failure() returns trigger language plpgsql as $$
      begin raise unique_violation using message='synthetic customer failure';end;$$;
      create trigger qa_unnumbered_customer_failure before insert on public.customers for each row execute function public.qa_unnumbered_customer_failure();`);
    const failedMessage='new invoice for No Write Retry, Rs 100, due 30 Oct';
    assert.match((await turn(first,'unnumbered-before-write-failed',failedMessage)).answer,/couldn’t check if the invoice was created/);
    assert.equal(await count(first),2);
    await db.exec('drop trigger qa_unnumbered_customer_failure on public.customers');
    assert.match((await turn(first,'unnumbered-after-write-retry',failedMessage)).answer,/Created invoice/);
    assert.match((await turn(first,'unnumbered-after-write-repeat',failedMessage)).answer,/already exists/);
    assert.equal(await count(first),3);
    const concurrentMessage='new invoice for Concurrent Retry, Rs 250, due 30 Oct';
    const concurrent=await Promise.all([turn(first,'unnumbered-concurrent-a',concurrentMessage),turn(first,'unnumbered-concurrent-b',concurrentMessage)]);
    assert.ok(concurrent.every(reply=>/Created invoice|already exists/.test(reply.answer)));
    assert.equal(concurrent.filter(reply=>/Created invoice/.test(reply.answer)).length,1);assert.equal(await count(first),4);
    // An old instruction cannot silently create another invoice after the
    // original row changes or disappears; its receipt must still verify.
    today='2026-10-18';
    await db.query("update invoices set total_amount=1510 where id=$1",[original]);
    assert.match((await turn(first,'unnumbered-stale-receipt',message)).answer,/couldn’t check if the invoice was created/);
    assert.equal(await count(first),4);
    const current=(await db.query('select * from invoices where id=$1',[original])).rows[0];
    const deleteMessage=`Delete invoice ${current.invoice_number}`;
    await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values('unnumbered-delete-original','offline',$1,'text',$2,'processing')",[first.phone,deleteMessage]);
    const deleted=await createDirectOwnerWriteAdapter({supabase}).apply({...first,providerMessageId:'unnumbered-delete-original',
      authorization:{kind:'instruction',quote:deleteMessage},operation:'invoice.delete',targetId:original,
      expectedUpdatedAt:current.updated_at.toISOString(),payload:{}});
    assert.equal(deleted.ok,true);
    assert.match((await turn(first,'unnumbered-deleted-receipt-record',message)).answer,/couldn’t check if the invoice was created/);
    assert.equal(await count(first),4);
    for(const issueDate of ['2026-10-17','2026-10-18']){
      const messageId='explicit-issue-'+issueDate,quote='Create an invoice with the supplied issue date '+issueDate;
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline',$2,'text',$3,'processing')",[messageId,first.phone,quote]);
      const created=await createDirectOwnerWriteAdapter({supabase}).apply({...first,providerMessageId:messageId,authorization:{kind:'instruction',quote},operation:'invoice.create',deduplicateInvoiceInstruction:true,
        payload:{customer_name:'Explicit Dates',currency:'INR',total_amount:80,issue_date:issueDate,due_date:'2026-10-30'}});
      assert.equal(created.completed,true,JSON.stringify(created));
    }
    assert.equal((await db.query("select count(*)::int n from invoices where workspace_id=$1 and total_amount=80",[first.workspaceId])).rows[0].n,2);
    assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
    assert.equal(f.errors.length,0,JSON.stringify(f.errors));
  }finally{await db.close();}
});

test('production rupee utterances commit exact facts, preserve explicit numbers, deduplicate retries, and clarify a missing date with zero writes',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+919871367059';
  // Keep the instruction and expectation on the same instant even if this
  // integration test itself straddles midnight in the business timezone.
  const now=new Date(),clock=()=>new Date(now);
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Production text QA','production-text-qa')).id")).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
    const {default_timezone:timezone}=(await db.query('select default_timezone from workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
    const issueDate=ownerCalendar(clock,timezone).currentDate;
    const novemberDue=`${issueDate.slice(0,4)}-11-20`;
    const dueDate=novemberDue<issueDate?`${Number(issueDate.slice(0,4))+1}-11-20`:novemberDue;
    let providerCalls=0;
    const handler=createOwnerMessageHandler({supabase,clock,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:()=>({generate(){providerCalls++;assert.fail('Natural complete or missing-date text must not call the model');}})});
    const turn=async(messageId,message)=>{
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline',$2,'text',$3,'processing')",[messageId,phone,message]);
      return handler({workspaceId,ownerId,customerId,phone,messageId,message});
    };
    const a='Invoice QA Dedup Customer for 3200 rupees, invoice number QA-TEXT-001, due 20 November.';
    const b='invoice QA Dedup Customer for 3200 rupees due 20 November';
    const c='can you invoice QA Question Customer for 2100 rupees?';
    assert.match((await turn('prod-text-a',a)).answer,/Created invoice QA-TEXT-001/);
    assert.match((await turn('prod-text-b',b)).answer,/Created invoice/);
    const query='select i.invoice_number,i.total_amount::text,i.currency,i.issue_date::text,i.due_date::text,c.name from invoices i join customers c on c.id=i.customer_id order by i.created_at,i.id';
    const saved=(await db.query(query)).rows;
    assert.equal(saved.length,2);assert.ok(saved.some(row=>row.invoice_number==='QA-TEXT-001'));
    for(const row of saved)assert.deepEqual({...row,invoice_number:undefined},{invoice_number:undefined,total_amount:'3200',currency:'INR',issue_date:issueDate,due_date:dueDate,name:'QA Dedup Customer'});
    assert.equal((await turn('prod-text-c',c)).answer,'What due date should I use for the INR 2100.00 invoice for QA Question Customer?');
    assert.deepEqual((await db.query(query)).rows,saved);
    assert.equal((await db.query("select count(*)::int n from customers where name='QA Question Customer'")).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_direct_write_receipts where provider_message_id='prod-text-c'")).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,0,'no attachment review or proposal for direct create/clarification');
    assert.match((await turn('prod-text-a-repeat',a)).answer,/already exists/);
    assert.match((await turn('prod-text-b-repeat',b)).answer,/already exists/);
    assert.deepEqual((await db.query(query)).rows,saved);
    assert.equal((await handler({workspaceId,ownerId,customerId,phone,messageId:'prod-text-a',message:a})).replayed,true);
    // Confirm mode stages the same explicit number and commits it only on a
    // later owner decision, through the already-applied numbering migration.
    await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"buttons\"}' where workspace_id=$1",[workspaceId]);
    const proposal=await turn('prod-text-confirm',a.replace('QA-TEXT-001','QA-CONFIRM-TEXT-009'));
    assert.match(proposal.answer,/Reply yes.*cancel/);
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,2);
    const pending=(await db.query('select action from whatsapp_pending_actions where consumed_at is null')).rows[0].action;
    assert.equal(pending.type,'owner_invoice_create');assert.equal(pending.invoice.invoiceNumber,'QA-CONFIRM-TEXT-009');
    const confirming=createOwnerMessageHandler({supabase,clock,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:()=>({async generate({messages}){
        const result=messages.findLast(item=>item.role==='tool');
        if(!result)return {toolCalls:[{id:'confirm-production',type:'function',function:{name:'workspaceData',arguments:'{"operation":"confirm"}'}}]};
        const outcome=JSON.parse(result.content);assert.equal(outcome.ok,true);return {content:`Created invoice ${outcome.invoiceNumber}.`};
      }})});
    await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values('prod-text-yes','offline',$1,'text','yes','processing')",[phone]);
    const confirmed=await confirming({workspaceId,ownerId,customerId,phone,messageId:'prod-text-yes',message:'yes'});
    assert.match(confirmed.answer,/Created invoice QA-CONFIRM-TEXT-009/);
    assert.equal((await db.query("select count(*)::int n from invoices where invoice_number='QA-CONFIRM-TEXT-009'")).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
    assert.equal(providerCalls,0);assert.deepEqual(f.errors,[]);
  }finally{await db.close();}
});

test('SQL invoice issue dates follow the saved business timezone on both sides of IST midnight',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+919871367060';
  let instant;
  const clock=()=>new Date(instant);
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Calendar QA','calendar-qa')).id")).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const handler=createOwnerMessageHandler({supabase,clock,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:()=>({generate(){assert.fail('Complete invoice instructions must not call the model');}})});
    for(const [index,[now,timezone,expectedDay]] of [
      ['2026-10-23T18:29:59Z','Asia/Kolkata','2026-10-23'],
      ['2026-10-23T18:30:01Z','Asia/Kolkata','2026-10-24'],
      ['2026-10-23T18:30:01Z','UTC','2026-10-23'],
    ].entries()){
      instant=now;
      await db.query("update workspace_settings set default_timezone=$2,owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId,timezone]);
      const settings=(await db.query('select default_timezone from workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
      const issueDate=ownerCalendar(clock,settings.default_timezone).currentDate;
      assert.equal(issueDate,expectedDay);
      const number=`QA-MIDNIGHT-${index}`,messageId=`calendar-${index}`;
      const message=`Invoice Calendar Customer for 3200 rupees, invoice number ${number}, due 20 November.`;
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline',$2,'text',$3,'processing')",[messageId,phone,message]);
      assert.match((await handler({workspaceId,ownerId,customerId,phone,messageId,message})).answer,/Created invoice/);
      const saved=(await db.query('select issue_date::text,due_date::text from invoices where workspace_id=$1 and invoice_number=$2',[workspaceId,number])).rows[0];
      assert.deepEqual(saved,{issue_date:issueDate,due_date:'2026-11-20'});
    }
    assert.equal((await db.query('select count(*)::int n from invoices where workspace_id=$1',[workspaceId])).rows[0].n,3);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
    assert.deepEqual(f.errors,[]);
  }finally{await db.close();}
});
