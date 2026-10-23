import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './offline-sql-network.mjs';
import {applyNoFooterMigration} from './no-footer-reminders.mjs';
import {createAIHandler} from '../../ai/routes.mjs';
import {CoreAutomationStore} from '../../automation/core-store.mjs';
import {createAutomationRuntime} from '../../automation/runtime.mjs';

// Actual handlers, SDK and PostgreSQL; all credentials and recipients are isolated fixtures.
export async function createReminderReviewNetwork(){
 const graph=[],phone='+919871367051';
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261023061702_shared_owner_assistant.sql'],externalFetch:async(url,options)=>{
  if(url.origin!=='https://graph.facebook.com')throw Error('Unexpected fixture network');graph.push(JSON.parse(options.body));return Response.json({messages:[{id:'wamid.browser.'+graph.length}]});
 }});const {db}=f;
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
  await applyNoFooterMigration(db,{approve:true});
  for(const file of ['20261020105604_invoice_reminder_full_customer_name.sql','20261022221930_default_payment_reminder_draft.sql','20261023061702_shared_owner_assistant.sql','20261023083356_per_message_reminder_review.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
  const ownerId=randomUUID();await db.query('insert into auth.users(id) values($1)',[ownerId]);
  const asUser=()=>db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}'`);
  const service=()=>db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  await asUser();const workspaceId=(await db.query("select (create_workspace('Browser business',$1)).id",[randomUUID()])).rows[0].id;
  await service();await db.query("update workspace_settings set business_name='Browser business',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,{tone:'professional',contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:5,firstReminderDays:0,cadenceDays:3}]);
  const customerId=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Full customer name',$2) returning id",[workspaceId,phone])).rows[0].id;
  await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','fixture',array['invoice_updates'])",[workspaceId,customerId,phone]);
  const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'public-fixture-key',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',AI_ACCOUNTING_CONFIRMATION_SECRET:'a'.repeat(32),WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_GRAPH_API_VERSION:'v24.0',AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])};
  const handler=createAIHandler({env,logger:{info(){},error(){},warn(){}},fetchImpl:async(raw,init)=>new URL(raw).pathname==='/auth/v1/user'?Response.json({id:ownerId}):f.fetchImpl(raw,init)});
  const api=async(action,body={},method='POST')=>{
   await asUser();const res={setHeader(){},status(code){this.code=code;return this},json(data){this.data=data;return this}};
   await handler({method,headers:{authorization:'Bearer fixture-owner-token'},query:{action,workspaceId},body:{workspaceId,...body}},res);return res;
  };
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:'fixture-key',fetchImpl:f.fetchImpl});
  const runtime=createAutomationRuntime({env,store,supabase:f.supabase,fetchImpl:f.fetchImpl});
  return {...f,graph,api,asUser,service,workspaceId,ownerId,customerId,
   async seed(){
    await service();await db.query("delete from whatsapp_messages where workspace_id=$1 and direction='inbound'",[workspaceId]);
    await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key,created_at) values($1,$2,$3,'inbound','customer','Hello','text','received',$4,clock_timestamp()-interval '1 hour')",[workspaceId,customerId,phone,randomUUID()]);
    const invoice=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,current_date-3,current_date-1,'USD',125,'sent','{\"invoice_direction\":\"receivable\"}') returning *",[workspaceId,customerId,randomUUID()])).rows[0];
    return {invoice,customer:(await db.query('select * from customers where id=$1',[customerId])).rows[0],settings:await store.getWorkspacePreferences({workspaceId}),workspace:{id:workspaceId,owner_id:ownerId,name:'Browser business'},user:{id:ownerId,email:'fixture@example.test'}};
   },
   async expireWindow(){await service();await db.query("update whatsapp_messages set created_at=clock_timestamp()-interval '25 hours' where workspace_id=$1 and direction='inbound'",[workspaceId]);},
   async tick(){await service();return runtime.tick({ownerId,workspaceId});}
  };
 }catch(e){await f.close();throw e}
}
