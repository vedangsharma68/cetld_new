import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {applyNoFooterMigration} from './fixtures/no-footer-reminders.mjs';
import {createOwnerScopedStore} from '../ai/whatsapp-channel.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {ownerReminderRequest} from '../automation/whatsapp/owner-reminders.mjs';
import {buildInvoiceReminderParameters} from '../automation/whatsapp/reminder-parameters.mjs';
import {selectInvoiceReminderTemplate,buildReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
import {createOwnerActionButtons,verifyOwnerActionButton} from '../automation/whatsapp/owner-action-buttons.mjs';

const logger={info(){},warn(){},error(){}};
const migration='20261020130000_owner_chat_reminder_approval.sql';
const prefs={tone:'professional',contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:3,firstReminderDays:0};
const target=number=>[{column:'invoice_number',operator:'eq',value:number}];
test('common reminder requests prepare one target and never interpret a request as confirmation',()=>{
  assert.deepEqual(ownerReminderRequest('send a reminder to Ravi'),{operation:'sendReminderNow',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'Ravi'}]});
  assert.deepEqual(ownerReminderRequest('remind the customer on INV-123 now'),{operation:'sendReminderNow',table:'invoices',filters:target('INV-123')});
  assert.equal(ownerReminderRequest('show the reminder preview for INV-123').operation,'previewReminder');
  for(const text of ['yes','send a reminder to Ravi and Priya',"don't send a reminder to Ravi",'send a reminder to Ravi tomorrow'])assert.equal(ownerReminderRequest(text),null,text);
});

test('owner reminder approval uses native pending confirmations and leaves delivery gates authoritative',async t=>{
 const f=await createOfflineSqlNetwork();const {db,supabase}=f;
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])
   await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  await applyNoFooterMigration(db,{approve:true});
  await db.exec(await readFile(new URL('../supabase/migrations/20261020105604_invoice_reminder_full_customer_name.sql',import.meta.url),'utf8'));
  const ownerId=randomUUID(),phone='+12025550107',recipient='+12025550108';
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (create_workspace('Chat fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const debtor=(await db.query("insert into customers(workspace_id,name,phone) values($1,'  Ravi Kumar  ',$2) returning id",[workspaceId,recipient])).rows[0].id;
  await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'inbound_message','fixture',array['invoice_updates'])",[workspaceId,debtor,recipient]);
  const settings=async()=> (await db.query('select * from workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
  const setPrefs=async p=>db.query("update workspace_settings set default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,p]);
  await setPrefs(prefs);
  const scope={workspaceId,ownerId,customerId,phone};
  const pending=createWhatsAppPendingActionStore({supabase});
  const invoice=async number=>(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,current_date-2,current_date-1,'USD',125,'sent','{\"invoice_direction\":\"receivable\"}') returning *",[workspaceId,debtor,number])).rows[0];
  const row=async id=>(await db.query('select * from invoices where id=$1',[id])).rows[0];
  let seq=0;
  const inbound=async(message,id='reminder-'+(++seq),interactionId=null)=>{
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,interaction_id,status) values($1,'fixture',$2,'text',$3,$4,'processing')",[id,phone,message,interactionId]);return id;
  };
  const tools=async(message,{id=null,interactionId=null,owner=ownerId,authorized=true}={})=>{
   id=id||await inbound(message,undefined,interactionId);
   const pendingAtStart=await pending.loadPendingAction(scope),pendingInitialState=await pending.loadPendingActionState(scope);
   return {id,tool:createOwnerWorkspaceTools({supabase,scope:{...scope,ownerId:owner},message,messageId:id,pending,pendingAtStart,pendingInitialState,
    authorize:async()=>authorized,ownerStore:createOwnerScopedStore({supabase,...scope,authorize:async()=>authorized}),botPreferences:{confirmationMode:'direct'},interactiveAvailable:true,env:{CRON_SECRET:'fixture'},clock:()=>new Date()})};
  };
  const execute=async(message,args,options)=>{const run=await tools(message,options);return {...run,result:await run.tool.execute('workspaceData',args)};};
  const cancel=()=>execute('cancel',{operation:'cancel'});
  const propose=number=>execute(`send a reminder for ${number} now`,{operation:'sendReminderNow',table:'invoices',filters:target(number)});
  const confirm=()=>execute('yes',{operation:'confirm'});
  const noSends=async()=>{
   assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer' and direction='outbound'")).rows[0].n,0);
   assert.equal(f.requests.some(r=>r.url.includes('graph.facebook.com')),false);
  };
  await t.test('preview is exact, request is not approval, later confirmation reapproves and queues now once',async()=>{
   const i=await invoice('INV-CHAT-1'),before=await row(i.id),p=await propose(i.invoice_number);
   assert.equal(p.result.requiresConfirmation,true,JSON.stringify({result:p.result,errors:f.errors}));
   assert.deepEqual(await row(i.id),before);
   const customer=(await db.query('select * from customers where id=$1',[debtor])).rows[0],s=await settings();
   const entry=selectInvoiceReminderTemplate(s.follow_up_preferences),rendered=buildReminderTemplate(entry,buildInvoiceReminderParameters({invoice:{...i,due_date:new Date(i.due_date).toISOString().slice(0,10)},settings:s,customer}));
   assert.equal(p.result.preview,rendered.body);assert.ok(p.tool.getReminderReply().includes(rendered.body));assert.match(rendered.body,/Hi Ravi Kumar,/);
   assert.equal((await p.tool.execute('workspaceData',{operation:'confirm'})).ok,false);assert.deepEqual(await row(i.id),before);
   const start=Date.now(),c=await confirm();assert.equal(c.result.completed,true,JSON.stringify({result:c.result,errors:f.errors}));
   const saved=await row(i.id);assert.equal(saved.followup_state,'approved');assert.ok(Math.abs(new Date(saved.next_follow_up_at).getTime()-start)<5000);
   assert.equal(new Date(saved.metadata.approved_preferences_updated_at).toISOString(),new Date(s.updated_at).toISOString());
   assert.equal(saved.metadata.approved_reminder_text,rendered.body+'\n\nChat fixture');
   const replay=await supabase.rpc('whatsapp_owner_reminder',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_message_id:c.id,p_user_message:'yes',p_action:'confirm',
    p_pending_id:(await db.query("select id from whatsapp_pending_actions where action->>'invoiceId'=$1",[i.id])).rows[0].id,p_pending_version:1});
   assert.equal(replay.data.replayed,true);assert.deepEqual(await row(i.id),saved);await noSends();
   // Claim once and recheck suppression through the untouched scheduler RPCs.
   const claimArgs={p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:i.id,p_now:new Date().toISOString()};
   const claims=await supabase.rpc('cetld_core_claim_due_followups',claimArgs);assert.equal(claims.data.length,1,JSON.stringify(claims));
   assert.equal((await supabase.rpc('cetld_core_claim_due_followups',claimArgs)).data.length,0);
   await db.query('insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,$2,\'manual\')',[workspaceId,recipient]);
   const auth=await supabase.rpc('cetld_core_authorize_delivery',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_claim_id:claims.data[0].claim_id,p_preferences_version:s.updated_at});
   assert.equal(auth.data[0].authorized,false);await db.query('delete from whatsapp_suppressions where workspace_id=$1 and phone=$2',[workspaceId,recipient]);
  });
  await t.test('approve-only matches dashboard metadata and fact/preferences/name changes still revoke approval',async()=>{
   for(const change of ['preferences','facts','name']){
    const i=await invoice('INV-APPROVE-'+change);
    const p=await execute('show reminder preview',{operation:'previewReminder',table:'invoices',filters:target(i.invoice_number)});assert.equal(p.result.requiresConfirmation,true,JSON.stringify(p.result));
    assert.equal((await confirm()).result.completed,true);
    const approved=await row(i.id);assert.equal(new Date(approved.metadata.approved_preferences_updated_at).toISOString(),new Date((await settings()).updated_at).toISOString());assert.equal(approved.followup_state,'approved');
    if(change==='preferences')await setPrefs({...prefs,cadenceDays:2});
    if(change==='facts')await db.query('update invoices set total_amount=126 where id=$1',[i.id]);
    if(change==='name')await db.query("update workspace_settings set business_name='Chat renamed' where workspace_id=$1",[workspaceId]);
    const revoked=await row(i.id);assert.ok(!['approved','active','scheduled'].includes(revoked.followup_state));assert.ok(!revoked.metadata.approved_reminder_text);
   }
   await db.query("update workspace_settings set business_name='Chat fixture' where workspace_id=$1",[workspaceId]);await setPrefs(prefs);await noSends();
  });
  await t.test('ambiguous customer, foreign scope, missing consent, STOP and paid/terminal guards write no approval',async()=>{
   const i=await invoice('INV-GUARDS');
   const ambiguous=await execute('send a reminder to Ravi',{operation:'sendReminderNow',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'Ravi'}]});
   assert.equal(ambiguous.result.code,'AMBIGUOUS');assert.match(ambiguous.result.message,/Which invoice/);
   assert.equal((await execute('send reminder',{operation:'sendReminderNow',table:'invoices',filters:target(i.invoice_number)},{authorized:false})).result.ok,false);
   assert.equal((await execute('send reminder',{operation:'sendReminderNow',table:'invoices',filters:target(i.invoice_number)},{owner:randomUUID()})).result.ok,false);
   await db.query("update whatsapp_consents set revoked_at=now(),revoked_via='stop' where workspace_id=$1 and phone=$2",[workspaceId,recipient]);
   assert.equal((await propose(i.invoice_number)).result.ok,false);
   await db.query('update whatsapp_consents set revoked_at=null,revoked_via=null where workspace_id=$1 and phone=$2',[workspaceId,recipient]);
   await db.query("insert into whatsapp_global_suppressions(phone) values($1)",[recipient]);
   assert.equal((await propose(i.invoice_number)).result.code,'globally_suppressed');
   await db.query('delete from whatsapp_global_suppressions where phone=$1',[recipient]);
   for(const status of ['paid','void','cancelled','draft']){
    await db.query('update invoices set status=$2 where id=$1',[i.id,status]);assert.equal((await propose(i.invoice_number)).result.code,'ineligible_invoice');
   }
   assert.ok(!(await row(i.id)).metadata.approved_reminder_text);await noSends();
  });
  await t.test('contact hours, max reminders, unresolved exceptions, claims and uncertain delivery are refused',async()=>{
   const i=await invoice('INV-LIMITS');
   await setPrefs({...prefs,allowedWeekdays:[(new Date().getUTCDay()+1)%7]});
   assert.equal((await propose(i.invoice_number)).result.code,'contact_hours');
   // Approval can be reviewed outside contact hours, as on the dashboard.
   assert.equal((await execute('preview reminder',{operation:'previewReminder',table:'invoices',filters:target(i.invoice_number)})).result.requiresConfirmation,true);await cancel();
   await setPrefs(prefs);await db.query('update invoices set reminder_count=3 where id=$1',[i.id]);
   assert.equal((await propose(i.invoice_number)).result.code,'reminder_limit');
   await db.query("update invoices set reminder_count=0,metadata=metadata||'{\"followup_exception\":{\"type\":\"dispute\"}}' where id=$1",[i.id]);
   assert.equal((await propose(i.invoice_number)).result.code,'unresolved_exception');
   await db.query("update invoices set metadata=metadata-'followup_exception' where id=$1",[i.id]);
   for(const state of ['claimed','sending','quarantined']){
    await db.query("insert into cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until) values($1,$2,now(),0,now(),$3,now()+interval '1 minute')",[workspaceId,i.id,state]);
    assert.equal((await propose(i.invoice_number)).result.code,'delivery_in_progress');
    await db.query('delete from cetld_core_automation_delivery_claims where invoice_id=$1',[i.id]);
   }await noSends();
  });
  await t.test('stale facts, preferences, customer, consent, expiry and pending version cannot be confirmed',async()=>{
   for(const change of ['facts','preferences','customer','consent','expiry','version']){
    const i=await invoice('INV-STALE-'+change);assert.equal((await propose(i.invoice_number)).result.requiresConfirmation,true);
    const current=await pending.loadPendingAction(scope);
    if(change==='facts')await db.query('update invoices set total_amount=130 where id=$1',[i.id]);
    if(change==='preferences')await setPrefs({...prefs,cadenceDays:4});
    if(change==='customer')await db.query("update customers set name='Ravi changed' where id=$1",[debtor]);
    if(change==='consent')await db.query("update whatsapp_consents set revoked_at=now(),revoked_via='stop' where workspace_id=$1 and phone=$2",[workspaceId,recipient]);
    if(change==='expiry')await db.query("update whatsapp_pending_actions set action=action||jsonb_build_object('expiresAt',now()-interval '1 minute') where id=$1",[current.id]);
    let out;
    if(change==='version'){
     const id=await inbound('yes');out=(await supabase.rpc('whatsapp_owner_reminder',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_message_id:id,p_user_message:'yes',p_action:'confirm',p_pending_id:current.id,p_pending_version:current.version+1})).data;
    }else out=(await confirm()).result;
    assert.equal(out.ok,false,JSON.stringify({change,out}));assert.ok(!(await row(i.id)).metadata.approved_reminder_text);
    // Expiration retires this action; other refusals keep it for cancellation.
    if(await pending.loadPendingAction(scope))await cancel();
    await db.query('update whatsapp_consents set revoked_at=null,revoked_via=null where workspace_id=$1 and phone=$2',[workspaceId,recipient]);
    await setPrefs(prefs);
   }await noSends();
  });
  await t.test('new suppression, contact window or reminder-limit failures after preview never queue',async()=>{
   for(const change of ['suppression','hours','limit','paid']){
    const i=await invoice('INV-LATER-'+change);assert.equal((await propose(i.invoice_number)).result.requiresConfirmation,true);
    if(change==='suppression')await db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,$2,'manual')",[workspaceId,recipient]);
    if(change==='hours')await setPrefs({...prefs,allowedWeekdays:[(new Date().getUTCDay()+1)%7]});
    if(change==='limit')await db.query('update invoices set reminder_count=3 where id=$1',[i.id]);
    if(change==='paid')await db.query("update invoices set status='paid' where id=$1",[i.id]);
    const c=await confirm();assert.equal(c.result.ok,false);assert.ok(!(await row(i.id)).metadata.approved_reminder_text);
    await cancel();
    await db.query('delete from whatsapp_suppressions where workspace_id=$1 and phone=$2',[workspaceId,recipient]);await setPrefs(prefs);
   }await noSends();
  });
  await t.test('an expired preview can be replaced by a fresh request without reviving its approval',async()=>{
   const i=await invoice('INV-REFRESH');assert.equal((await propose(i.invoice_number)).result.requiresConfirmation,true);
   const old=await pending.loadPendingAction(scope);
   await db.query("update whatsapp_pending_actions set action=action||jsonb_build_object('expiresAt',now()-interval '1 minute') where id=$1",[old.id]);
   assert.equal((await propose(i.invoice_number)).result.requiresConfirmation,true);
   const fresh=await pending.loadPendingAction(scope);assert.notEqual(fresh.id,old.id);assert.ok(!(await row(i.id)).metadata.approved_reminder_text);await cancel();
  });
  await t.test('signed buttons use existing HMAC, pending version, later inbound event and receipt',async()=>{
   const i=await invoice('INV-BUTTON'),p=await propose(i.invoice_number),current=await pending.loadPendingAction(scope);
   assert.equal(p.tool.getReplyRequirement().buttonsAvailable,true);
   const buttons=createOwnerActionButtons({scope,action:current,env:{CRON_SECRET:'fixture'}});assert.equal(buttons.length,2);
   assert.equal(verifyOwnerActionButton({id:buttons[0].id,scope,action:current,env:{CRON_SECRET:'fixture'}}).valid,true);
   const run=await tools('Confirm',{interactionId:buttons[0].id});
   const saved=await run.tool.decideButton({pending:current,decision:'confirm',interactionId:buttons[0].id});assert.equal(saved.completed,true,JSON.stringify({saved,errors:f.errors}));
   assert.match(run.tool.getReminderReply(),/has not been sent yet/);await noSends();
  });
  await t.test('production handler returns exact preview and explicit confirmation in direct mode with no model or WhatsApp network',async()=>{
   const i=await invoice('INV-HANDLER');
   const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger,providerFactory:()=>({}),agentFactory:()=>{throw Error('unexpected model call');}});
   const message=`send a reminder for ${i.invoice_number} now`,id=await inbound(message);
   const preview=await handler({...scope,message,messageId:id});assert.match(preview.answer,/Reminder preview/,JSON.stringify(f.errors));assert.match(preview.answer,/Hi Ravi changed,/);assert.match(preview.answer,/Reply yes/);
   assert.ok(!(await row(i.id)).metadata.approved_reminder_text);
   const yes=await inbound('yes'),confirmed=await handler({...scope,message:'yes',messageId:yes});assert.match(confirmed.answer,/Approved and queued/);assert.equal((await row(i.id)).followup_state,'approved');
   const after=await row(i.id),retry=await handler({...scope,message:'yes',messageId:yes});
   assert.match(retry.answer,/Approved and queued/);assert.deepEqual(await row(i.id),after);
   await noSends();
  });
  await t.test('first pronoun reminder after text creation decodes model filters and preserves specific refusals and preview',async()=>{
   const history=[];let mode='create',modelCalls=0,filters;
   const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger,historyReader:async()=>history,
    providerFactory:()=>({async generate({messages}){
     modelCalls++;
     if(mode==='create'&&messages.some(m=>m.role==='tool'))return {content:'Created invoice.'};
     if(mode!=='create')assert.equal(modelCalls,1,'Reminder result needs no model reply repair');
     return {toolCalls:[{id:'fresh-reminder',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(mode==='create'
      ?{request:'new invoice QA-REPRO-001, QA Repro Customer, Rs 1,500, due tomorrow'}
      :{operation:'sendReminderNow',table:'invoices',filters:JSON.stringify(filters)})}}]};
    }})});
   const turn=async message=>{
    const id=await inbound(message),result=await handler({...scope,message,messageId:id});
    history.push({role:'user',content:message},{role:'assistant',content:result.answer});
    return result;
   };
   const created=await turn('new invoice QA-REPRO-001, QA Repro Customer, Rs 1,500, due tomorrow');
   assert.match(created.answer,/Created invoice/);
   const fresh=(await db.query("select * from invoices where workspace_id=$1 and metadata->>'source_invoice_number'='QA-REPRO-001'",[workspaceId])).rows[0];
   assert.ok(fresh);assert.equal(Number(fresh.total_amount),1500);assert.equal(fresh.status,'draft');
   filters=target(fresh.invoice_number);mode='reminder';
   const remind=async()=>{modelCalls=0;const reply=await turn('send him a reminder to pay');assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));assert.equal(modelCalls,1);return reply;};
   assert.match((await remind()).answer,/usable WhatsApp number/);
   await db.query('update customers set phone=$2 where id=$1',[fresh.customer_id,'+12025550109']);
   assert.match((await remind()).answer,/agreed to WhatsApp reminders/);
   await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,'+12025550109','inbound_message','fixture',array['invoice_updates'])",[workspaceId,fresh.customer_id]);
   assert.match((await remind()).answer,/sent, unpaid receivable invoice/);
   await db.query("update invoices set status='sent' where id=$1",[fresh.id]);
   const before=await row(fresh.id),preview=await remind();
   assert.match(preview.answer,/Reminder preview/);assert.match(preview.answer,/Reply yes/);
   assert.deepEqual(await row(fresh.id),before);await cancel();
   filters=[...target(fresh.invoice_number),{column:'customer_name',operator:'eq',value:'QA Repro Customer'}];
   assert.match((await remind()).answer,/identify one invoice/);assert.deepEqual(await row(fresh.id),before);
   await noSends();
  });
  await t.test('RPC cannot be called by authenticated or anonymous roles',async()=>{
   const id=await inbound('yes');
   for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query('select whatsapp_owner_reminder($1,$2,$3,$4,$5,$6)',[workspaceId,ownerId,phone,id,'yes','confirm']),/permission denied/);
    await db.exec('reset role');
   }
  });
 }finally{await f.close();}
});
