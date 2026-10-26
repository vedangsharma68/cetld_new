import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {ownerConsentRequest} from '../automation/whatsapp/owner-consent.mjs';
import {getSendEligibility} from '../automation/whatsapp/consent.mjs';

test('consent confirmations use a bounded, supported owner operation',()=>{
  assert.deepEqual(ownerConsentRequest('record consent: John Smith agreed to WhatsApp reminders on +12025550119'),{
    operation:'recordConsent',table:'customers',filters:[{column:'name',operator:'eq',value:'John Smith'}]});
  assert.equal(ownerConsentRequest('he consented to reminders on +12025550119').filters[0].value,'+12025550119');
  assert.equal(ownerConsentRequest('yes, he has agreed to get reminders on this number').filters.length,0);
  assert.equal(ownerConsentRequest('John Smith has agreed to reminders').filters[0].value,'John Smith');
  assert.equal(ownerConsentRequest('send a reminder for INV-2026-1234'),null);
  assert.equal(ownerConsentRequest('approve'),null,'bare proposal fallback is not customer consent');
  assert.equal(ownerConsentRequest('they approve, send them a reminder (the invoice is due tommrow)').filters.length,0,'an unquoted pronoun cannot select recent customers');
});

test('owner consent commits with evidence and a receipt; owner bindings and STOP remain intact',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f;
 try{
  await db.exec(await readFile(new URL('../supabase/migrations/20261018060000_customer_reminder_tone.sql',import.meta.url),'utf8'));
  const ownerId=randomUUID(),phone='+12025550107';
  await db.query("insert into auth.users(id,email) values($1,'owner@example.test')",[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (create_workspace('Consent test',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const debtor=(await db.query("insert into customers(workspace_id,name,phone) values($1,'John Smith','+12025550119') returning id",[workspaceId])).rows[0].id;
  const invoice=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
    values($1,$2,'CONSENT-001',current_date,current_date+1,'USD',125,'draft','{"invoice_direction":"receivable"}') returning id,invoice_number`,[workspaceId,debtor])).rows[0];
  const scope={workspaceId,ownerId,customerId,phone},history=[];let seq=0;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},providerFactory:()=>({}),historyReader:async()=>history,
    logger:{info(){},warn(){},error(){}},agentFactory:async()=>{throw Error('consent must not depend on model guesses');}});
  const event=async(message,sender=phone)=>{
    const messageId='consent-'+(++seq);
    await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,sender,message]);
    return messageId;
  };
  const turn=async message=>{
    const messageId=await event(message),result=await handler({...scope,message,messageId});
    history.push({role:'user',content:message},{role:'assistant',content:result.answer});return {messageId,...result};
  };
  const row=async target=>(await db.query('select * from whatsapp_consents where workspace_id=$1 and phone=$2',[workspaceId,target])).rows[0];
  const rpc=async(messageId,message,changes={})=>supabase.rpc('whatsapp_owner_record_consent',{
    p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_customer_id:debtor,p_contact_phone:'+12025550119',p_message_id:messageId,p_user_message:message,...changes});
  assert.equal(await row('+12025550119'),undefined);
  // Questions, negation, future intent and a bare YES cannot attest consent.
  for(const text of ['Has John Smith consented to reminders on +12025550119?','Has John Smith consented to reminders on +12025550119',"John Smith hasn't agreed to reminders on +12025550119",
    'John Smith will consent to reminders on +12025550119','record consent for John Smith','yes','record consent: John Smith agreed to reminders on +1202']){
    const result=await rpc(await event(text),text);assert.equal(result.data.ok,false,JSON.stringify(result));
    assert.equal(await row('+12025550119'),undefined);
  }
  const missingTarget=await turn('yes, he has agreed to get reminders on this number');
  assert.match(missingTarget.answer,/customer name and current number/);assert.equal(await row('+12025550119'),undefined);
  const message='record consent: John Smith agreed to WhatsApp reminders on +12025550119';
  const saved=await turn(message);assert.match(saved.answer,/Recorded reminder consent for John Smith on \+12025550119/);
  assert.match(saved.answer,/No reminder was sent/);
  const consent=await row('+12025550119');assert.equal(consent.customer_id,debtor);assert.equal(consent.source,'verbal');
  assert.equal(consent.consented_by,ownerId);assert.equal(consent.consent_text_version,'owner_confirmed_v1');
  assert.deepEqual(consent.categories,['invoice_updates']);
  assert.equal((await getSendEligibility({supabase,workspaceId,phone:'+12025550119'})).allowed,true);
  const replay=await rpc(saved.messageId,message);assert.equal(replay.data.replayed,true);assert.deepEqual(await row('+12025550119'),consent);
  assert.equal((await db.query('select count(*)::int n from whatsapp_direct_write_receipts where provider_message_id=$1',[saved.messageId])).rows[0].n,1);
  assert.equal((await rpc('missing-event',message)).data.code,'DENIED');
  const validEvent=await event(message);
  assert.equal((await rpc(validEvent,message,{p_owner_id:randomUUID()})).data.code,'DENIED');
  assert.equal((await rpc(validEvent,message,{p_workspace_id:randomUUID()})).data.code,'DENIED');
  assert.equal((await rpc(validEvent,message,{p_user_message:message+' forged'})).data.code,'DENIED');
  assert.equal((await rpc(validEvent,message,{p_contact_phone:'+12025550118'})).data.code,'STALE');
  assert.deepEqual(await row('+12025550119'),consent);
  // A failed receipt insert rolls the consent update back in the same RPC.
  await db.exec(`create function public.fixture_consent_receipt_failure() returns trigger language plpgsql as $$
    begin if new.request->>'operation'='consent.record' then raise exception 'fixture receipt unavailable'; end if; return new; end $$;
    create trigger fixture_consent_receipt_failure before insert on whatsapp_direct_write_receipts
    for each row execute function public.fixture_consent_receipt_failure();`);
  const unavailable=await turn(message);assert.match(unavailable.answer,/could not reach the consent record.*Try recording consent again/);
  assert.deepEqual(await row('+12025550119'),consent);
  await db.exec('drop trigger fixture_consent_receipt_failure on whatsapp_direct_write_receipts;drop function public.fixture_consent_receipt_failure()');
  // An invoice number can also identify the recipient without a model or an
  // implicit customer-name guess; it never approves that invoice's reminder.
  const byInvoice=await turn(`record consent for ${invoice.invoice_number}: they agreed to WhatsApp reminders`);
  assert.match(byInvoice.answer,/Recorded reminder consent for John Smith/);
  const latestConsent=await row('+12025550119');
  // Reproduce #158: saved debtor phone equals the verified owner phone. The
  // contact saves, but its existing owner consent must not move to the debtor.
  const ownerConsent=await row(phone);
  await db.query('update customers set phone=null where id=$1',[debtor]);
  assert.match((await turn(`send a reminder for ${invoice.invoice_number}`)).answer,/usable WhatsApp number/);
  const correction=await turn(phone);assert.match(correction.answer,/Saved/);assert.match(correction.answer,/verified owner WhatsApp number/);
  assert.match(correction.answer,/Send a different number/);
  for(const text of [`record consent: John Smith agreed to WhatsApp reminders on ${phone}`,`he consented to reminders on ${phone}`]){
    const blocked=await turn(text);assert.match(blocked.answer,/verified owner WhatsApp number/);assert.match(blocked.answer,/Send a different number/);
    assert.deepEqual(await row(phone),ownerConsent);
  }
  assert.equal((await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id,customerId);
  // Neither active consent for a different customer nor revoked consent can
  // be rebound or revived by an owner's attestation.
  await db.query('update customers set phone=$2 where id=$1',[debtor,'+12025550119']);
  const other=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Other Buyer','+12025550119') returning id",[workspaceId])).rows[0].id;
  const conflictText='record consent: Other Buyer agreed to reminders on +12025550119';
  assert.equal((await rpc(await event(conflictText),conflictText,{p_customer_id:other})).data.code,'CONFLICT');
  assert.deepEqual(await row('+12025550119'),latestConsent);
  await db.query("update whatsapp_consents set revoked_at=now(),revoked_via='stop' where workspace_id=$1 and phone='+12025550119'",[workspaceId]);
  const revoked=await row('+12025550119');
  assert.match((await turn(message)).answer,/withdrew consent.*opt back in/);
  assert.deepEqual(await row('+12025550119'),revoked);
  await db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,'+12025550119','stop')",[workspaceId]);
  const suppressions=(await db.query('select * from whatsapp_suppressions where workspace_id=$1',[workspaceId])).rows;
  assert.match((await turn(message)).answer,/stopped WhatsApp reminders.*opt back in/);
  assert.deepEqual(await row('+12025550119'),revoked);
  assert.deepEqual((await db.query('select * from whatsapp_suppressions where workspace_id=$1',[workspaceId])).rows,suppressions);
  assert.equal((await getSendEligibility({supabase,workspaceId,phone:'+12025550119'})).allowed,false);
  await db.query("insert into whatsapp_global_suppressions(phone) values('+12025550119')");
  assert.match((await turn(message)).answer,/stopped WhatsApp messages.*opt back in/);
  const privilege=await db.query("select has_function_privilege('authenticated','public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text)','execute') authenticated, has_function_privilege('anon','public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text)','execute') anon");
  assert.deepEqual(privilege.rows[0],{authenticated:false,anon:false});
  assert.equal((await db.query('select status from invoices where id=$1',[invoice.id])).rows[0].status,'draft');
  assert.equal(f.requests.some(r=>r.url.includes('graph.facebook.com')),false);
 }finally{await db.close();}
});
