import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';

// Default production handler/provider over the native Cloudflare HTTP wire,
// consolidated tool, real SDK, full local SQL chain and readback. All HTTP is
// isolated. The repaired numeric patch is a local reconstruction: production
// retained TARGET_REQUIRED then UNKNOWN, but not the second call's values.
test('inconsistent draft total explains the arithmetic refusal; only an explicit consistent correction persists',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+919871367051';
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (create_workspace('Correction diagnostics',$1)).id",[randomUUID()])).rows[0].id;
  const otherWorkspaceId=(await db.query("select (create_workspace('Other correction scope',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) v',[phone,verification.code])).rows[0].v.ok,true);
  const binding=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  const scope={workspaceId,ownerId,customerId:binding.customer_id,phone};
  await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
  const metadata={invoice_direction:'receivable',subtotal:100,tax:0,line_items:[],source_document:{name:'isolated fixture'}};
  const ids=[];
  for(const tenant of [workspaceId,otherWorkspaceId]){
   const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Consulting fixture') returning id",[tenant])).rows[0].id;
   ids.push((await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata,custom_fields) values($1,$2,'QA-OVERNIGHT-001','2026-07-20','2026-08-19','USD',100,'draft',$3,$4) returning id",[tenant,customer,metadata,{description:'Consulting services',quantity:1}])).rows[0].id);
  }
  const read=async id=>(await db.query('select to_jsonb(i) row from invoices i where id=$1',[id])).rows[0].row;
  const before=await read(ids[0]),otherBefore=await read(ids[1]),logs=[],outputs=[];
  let values={total_amount:6670,currency:'INR',due_date:'2026-10-20'},missingTarget=true,providerCalls=0;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},authorize:input=>authorizeOwnerPhone({supabase,...input}),
   logger:{info(label,data){logs.push({label,data});},warn(){},error(){}},
   fetchImpl:async(url,init)=>{
    providerCalls++;assert.equal(new URL(url).hostname,'api.cloudflare.com');
    assert.match(new URL(url).pathname,/\/ai\/v1\/chat\/completions$/);
    const body=JSON.parse(init.body);
    if(body.tools)assert.deepEqual(body.tools.map(tool=>tool.function.name),['getAIProviderConfiguration','workspaceData']);
    const toolResult=body.messages.findLast(item=>item.role==='tool');
    const request=args=>Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'correct-draft',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}]}}]});
    const correction={operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'QA-OVERNIGHT-001'}],values};
    if(!toolResult)return request(missingTarget?{operation:'update',table:'invoices',values:{invoice_number:'QA-OVERNIGHT-001',...values}}:correction);
    const result=JSON.parse(toolResult.content);outputs.push(result);
    if(result.validationCode==='TARGET_REQUIRED')return request(correction);
    return Response.json({choices:[{finish_reason:'stop',message:{content:result.completed?'Invoice QA-OVERNIGHT-001 corrected to INR 6670 with due date 2026-10-20. It remains a draft with no reminders.':result.message}}]});
   }});
  const run=async(messageId,message)=>{
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,message]);
   return handler({...scope,messageId,message});
  };
  const rejected=await run('inconsistent-draft-total','Correct QA-OVERNIGHT-001 to INR 6,670 and change its due date to 2026-10-20. Keep it as an unsent draft with no reminders.');
  assert.deepEqual(outputs.map(result=>result.validationCode||result.code),['TARGET_REQUIRED','INVALID_TOTAL']);assert.equal(providerCalls,3);
  assert.equal(outputs[0].code,'INVALID');assert.equal(outputs[0].validationCode,'TARGET_REQUIRED');
  assert.equal(outputs[0].writeAttempted,false);
  assert.equal(outputs.at(-1).code,'INVALID_TOTAL');assert.equal(outputs.at(-1).completed,false);
  assert.match(outputs.at(-1).message,/subtotal plus tax minus discount/);assert.match(rejected.answer,/Provide the corrected amounts together/);assert.match(rejected.answer,/No change was made/);
  const diagnostic=logs.find(row=>row.label==='WhatsApp owner tool call'&&row.data.code==='INVALID_TOTAL').data;
  assert.equal(diagnostic.code,'INVALID_TOTAL');assert.equal(diagnostic.operation,'update');assert.equal(diagnostic.table,'invoices');
  assert.doesNotMatch(JSON.stringify(logs),/QA-OVERNIGHT|6670|Consulting services/);
  assert.deepEqual(await read(ids[0]),before);assert.deepEqual(await read(ids[1]),otherBefore);
  const count=async(table,column,value)=>(await db.query(`select count(*)::int n from ${table} where ${column}=$1`,[value])).rows[0].n;
  const customerMessages=async()=>(await db.query("select count(*)::int n from whatsapp_messages where workspace_id=$1 and audience='customer'",[workspaceId])).rows[0].n;
  assert.equal(await count('invoice_correction_audits','invoice_id',ids[0]),0);
  assert.equal(await count('whatsapp_direct_write_receipts','provider_message_id','inconsistent-draft-total'),0);
  assert.equal(await count('payments','invoice_id',ids[0]),0);assert.equal(await count('payment_reversals','invoice_id',ids[0]),0);
  assert.equal(await customerMessages(),0);assert.equal(await count('whatsapp_messages','invoice_id',ids[0]),0);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);
  missingTarget=false;values={total_amount:6670,subtotal:6670,tax:0,currency:'INR',due_date:'2026-10-20'};
  const corrected=await run('consistent-draft-total','Change QA-OVERNIGHT-001 total and subtotal to INR 6670, keep tax zero and due date 2026-10-20. Keep it as an unsent draft with no reminders.');
  assert.equal(outputs.at(-1).completed,true,JSON.stringify({corrected,outputs,errors:f.errors}));
  assert.equal(providerCalls,5);
  const after=await read(ids[0]);assert.equal(after.currency,'INR');assert.equal(after.total_amount,6670);
  assert.equal(after.metadata.subtotal,6670);assert.equal(after.metadata.tax,0);assert.deepEqual(after.metadata.line_items,[]);
  assert.equal(after.due_date,'2026-10-20');assert.equal(after.status,'draft');assert.equal(after.amount_paid,0);
  assert.equal(after.followup_state,'paused');assert.equal(after.next_follow_up_at,null);
  assert.deepEqual(after.custom_fields,before.custom_fields);assert.deepEqual(after.metadata.source_document,before.metadata.source_document);
  assert.deepEqual(await read(ids[1]),otherBefore);assert.equal(await count('invoice_correction_audits','invoice_id',ids[0]),1);
  assert.equal(await count('whatsapp_direct_write_receipts','provider_message_id','consistent-draft-total'),1);
  assert.equal(await count('payments','invoice_id',ids[0]),0);assert.equal(await count('payment_reversals','invoice_id',ids[0]),0);
  assert.equal(await customerMessages(),0);assert.equal(await count('whatsapp_messages','invoice_id',ids[0]),0);
  assert.ok(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
