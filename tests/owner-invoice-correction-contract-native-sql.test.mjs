// All contacts are synthetic fixtures using reserved 555-01xx phone numbers.
// Provider credential placeholders only reach the local stub; no network sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';
import {createDirectOwnerWriteAdapter} from '../automation/whatsapp/direct-owner-write.mjs';
import {AIProvider} from '../ai/provider.mjs';

const number='QA-CONTRACT-001';
const target=[{column:'invoice_number',operator:'eq',value:number}];
const request='For QA-CONTRACT-001, the consulting service charge is INR 6670, quantity 1, with no tax or other charges. Set both subtotal and total to INR 6670 and due date 2026-10-20. Keep it as an unsent draft with no reminders.';
const completion=content=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
const toolCall=args=>Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'correction',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}]}}]});

async function fixture(){
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+12025550101';
 await db.query('insert into auth.users(id) values($1)',[ownerId]);
 await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
 const workspaceId=(await db.query("select (create_workspace('Correction contract',$1)).id",[randomUUID()])).rows[0].id;
 const foreignId=(await db.query("select (create_workspace('Other correction contract',$1)).id",[randomUUID()])).rows[0].id;
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) v',[phone,verification.code])).rows[0].v.ok,true);
 const binding=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
 const scope={workspaceId,ownerId,customerId:binding.customer_id,phone};
 await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
 const ids=[];
 for(const tenant of [workspaceId,foreignId]){
  const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Consulting fixture') returning id",[tenant])).rows[0].id;
  ids.push((await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata,custom_fields) values($1,$2,$3,'2026-10-08','2026-10-15','USD',100,'draft',$4,$5) returning id",[tenant,customer,number,{subtotal:100,tax:0,line_items:[],invoice_direction:'receivable',source_document:{name:'isolated original'}},{description:'Consulting services',quantity:1}])).rows[0].id);
 }
 const read=async id=>(await db.query('select to_jsonb(i) row from invoices i where id=$1',[id])).rows[0].row;
 const before=await read(ids[0]),foreignBefore=await read(ids[1]);
 const count=async table=>(await db.query(`select count(*)::int n from ${table} where invoice_id=$1`,[ids[0]])).rows[0].n;
 const assertNoCustomerWrites=async()=>{
  assert.equal((await db.query("select count(*)::int n from whatsapp_messages where workspace_id=$1 and audience='customer'",[workspaceId])).rows[0].n,0);
  assert.equal(await count('payments'),0);assert.equal(await count('payment_reversals'),0);
  assert.deepEqual(await read(ids[1]),foreignBefore);assert.deepEqual(f.errors,[]);
 };
 const run=async(fetchImpl,messageId,message=request)=>{
  const outputs=[],logs=[];
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},authorize:input=>authorizeOwnerPhone({supabase,...input}),
   logger:{info(label,data){logs.push({label,data});},warn(){},error(){}},fetchImpl:async(url,init)=>{
    assert.equal(new URL(url).hostname,'api.cloudflare.com');
    const body=JSON.parse(init.body),result=body.messages.findLast(item=>item.role==='tool');
    if(result)outputs.push(JSON.parse(result.content));
    return fetchImpl(body);
   }});
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing') on conflict(provider_message_id) do nothing",[messageId,phone,message]);
  const turn={...scope,messageId,message};
  return {reply:await handler(turn),outputs,logs,handler,turn};
 };
 const seedCorrection=async(messageId,message,values)=>{
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,message]);
  const result=await createDirectOwnerWriteAdapter({supabase,invoiceCorrectionsEnabled:true}).apply({...scope,providerMessageId:messageId,
   authorization:{kind:'instruction',quote:message},operation:'invoice.update',targetId:ids[0],expectedUpdatedAt:before.updated_at,payload:values});
  assert.equal(result.ok,true,JSON.stringify(result));return result;
 };
 return {...f,scope,ids,read,before,count,assertNoCustomerWrites,run,seedCorrection};
}

const dueOnlyMessage='Only change the due date of QA-CONTRACT-001 to 2026-10-20. Leave its amount and currency unchanged, and keep reminders off.';
test('native Gemini read and excessive date-only plan repair use compatible JSON before one audited SQL correction',async()=>{
 const f=await fixture();try{
  let calls=0,repairs=0;const outputs=[];
  const response=parts=>Response.json({candidates:[{content:{parts},finishReason:'STOP'}]});
  const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated'},authorize:input=>authorizeOwnerPhone({supabase:f.supabase,...input}),
   logger:{info(){},warn(){},error(){}},providerFactory:options=>new AIProvider({...options,primaryModel:'gemini-3.5-flash-lite',fallbackModel:null}),
   fetchImpl:async(url,init)=>{
    assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');const body=JSON.parse(init.body);calls++;
    if(body.generationConfig.responseMimeType==='application/json'){
     repairs++;if(body.generationConfig.responseJsonSchema)return Response.json({error:{code:400,message:'fixture constrained schema rejected'}},{status:400});
     assert.equal(body.tools,undefined);assert.equal(body.contents.at(-1).parts[0].text,dueOnlyMessage);
     assert.ok(body.systemInstruction.parts.some(p=>p.text.includes('INVALID_FIELDS')&&p.text.includes('validationShape')));
     return response([{text:JSON.stringify({operation:'update',table:'invoices',filters:target,values:{due_date:'2026-10-20'}})}]);
    }
    const result=body.contents.flatMap(row=>row.parts).flatMap(part=>{try{return [part.functionResponse?.response||JSON.parse(part.text)];}catch{return [];}}).findLast(row=>row.operation||row.action);
    if(result)outputs.push(result);
    if(!result)return response([{functionCall:{name:'workspaceData',args:{operation:'read',table:'invoices',filters:target,columns:['invoice_number','due_date','total_amount','currency']}}}]);
    if(result.operation==='read')return response([{functionCall:{name:'workspaceData',args:{operation:'update',table:'invoices',filters:target,values:{line_items:[],due_date:'2026-10-20',subtotal:100,total_amount:100}}}}]);
    return response([{text:'Done.'}]);
   }});
  const messageId='native-gemini-date-repair';await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,f.scope.phone,dueOnlyMessage]);
  const turn={...f.scope,messageId,message:dueOnlyMessage},reply=await handler(turn);
  assert.equal(repairs,1);assert.equal(calls,4);assert.equal(outputs.at(-1).completed,true,JSON.stringify({reply,outputs}));
  assert.deepEqual(outputs.at(-1).correction.appliedFields,['due_date']);assert.match(typeof reply==='string'?reply:reply.answer,/Due date: 2026-10-20/);
  const after=await f.read(f.ids[0]);assert.equal(after.due_date,'2026-10-20');assert.equal(after.total_amount,100);assert.equal(after.currency,'USD');assert.equal(after.status,'draft');assert.equal(after.followup_state,'paused');
  assert.equal(await f.count('invoice_correction_audits'),1);await handler(turn);assert.equal(await f.count('invoice_correction_audits'),1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});
test('actual live date-only instruction refuses the observed amount-only plan and a still-incomplete repair before SQL',async()=>{
 const f=await fixture();try{
  let plans=0;
  const turn=await f.run(body=>{
   if(body.response_format){plans++;assert.equal(body.messages.at(-1).content,dueOnlyMessage);return completion(JSON.stringify({operation:'update',table:'invoices',filters:target,values:{total_amount:100,subtotal:100}}));}
   if(body.tools&&!body.messages.some(m=>m.role==='tool'))return toolCall({operation:'read',table:'invoices',filters:target,columns:['invoice_number','due_date','total_amount','currency']});
   if(body.tools&&JSON.parse(body.messages.findLast(m=>m.role==='tool').content).operation==='read')return toolCall({operation:'update',table:'invoices',filters:target,values:{total_amount:100,subtotal:100}});
   return completion('I successfully updated the due date to 2026-10-20.');
  },'observed-amount-only',dueOnlyMessage);
  assert.equal(plans,1);assert.equal(turn.outputs.at(-1).validationCode,'INVALID_FIELDS');assert.equal(turn.outputs.at(-1).writeAttempted,false);
  assert.equal(turn.outputs[0].rows[0].due_date,'2026-10-15');
  assert.doesNotMatch(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/successfully updated|due date (?:changed|updated)/i);
  assert.deepEqual(await f.read(f.ids[0]),f.before);assert.equal(await f.count('invoice_correction_audits'),0);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,0);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('date-only preflight replans the omitted date once, saves it through native SQL, and grounds generic Done in the persisted field',async()=>{
 const f=await fixture();try{
  let plans=0;
  const turn=await f.run(body=>{
   if(body.response_format){plans++;return completion(JSON.stringify({operation:'update',table:'invoices',filters:target,values:{due_date:'2026-10-20'}}));}
   if(body.tools&&!body.messages.some(m=>m.role==='tool')){
    const values=body.tools.find(t=>t.function.name==='workspaceData').function.parameters.properties.values.properties;
    assert.deepEqual(values.due_date.type,['string','null']);
    return toolCall({operation:'update',table:'invoices',filters:target,values:{total_amount:100,subtotal:100}});
   }
   return completion('Done.');
  },'repair-only-date',dueOnlyMessage);
  assert.equal(plans,1);assert.equal(turn.outputs.at(-1).completed,true);
  assert.deepEqual(turn.outputs.at(-1).correction.appliedFields,['due_date']);assert.deepEqual(turn.outputs.at(-1).correction.changedFields,['due_date']);
  assert.match(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/Due date: 2026-10-20/,JSON.stringify(turn.outputs));assert.doesNotMatch(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/not applied|could not confirm/i);
  const after=await f.read(f.ids[0]);assert.equal(after.due_date,'2026-10-20');assert.equal(after.total_amount,100);assert.equal(after.currency,'USD');
  assert.equal(after.status,'draft');assert.equal(after.followup_state,'paused');assert.equal(await f.count('invoice_correction_audits'),1);
  await turn.handler(turn.turn);assert.equal(await f.count('invoice_correction_audits'),1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('a retained native amount-only receipt cannot authorize a false date success or a second correction on recovery',async()=>{
 const f=await fixture();try{
  const receipt=await f.seedCorrection('recover-observed-amount-only',dueOnlyMessage,{total_amount:100,subtotal:100});
  assert.deepEqual(receipt.correction.changedFields,[]);
  const turn=await f.run(()=>completion('I successfully updated the due date to 2026-10-20.'),'recover-observed-amount-only',dueOnlyMessage);
  assert.match(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/requested due date change was not applied/);assert.match(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/Due date: 2026-10-15/);
  assert.match(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/No invoice business fields changed/);assert.doesNotMatch(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/2026-10-20|could not confirm|successfully updated/);
  assert.equal((await f.read(f.ids[0])).due_date,'2026-10-15');assert.equal(await f.count('invoice_correction_audits'),1);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('recovered partial native correction reports its actual fields and stored date without claiming the whole request succeeded',async()=>{
 const f=await fixture();try{
  await f.seedCorrection('recover-partial-date',dueOnlyMessage,{notes:'Retained business note'});
  const turn=await f.run(()=>completion('Done.'),'recover-partial-date',dueOnlyMessage);
  assert.match(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/requested due date change was not applied/);assert.match(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/Due date: 2026-10-15/);assert.match(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/Notes changed/);
  assert.doesNotMatch(typeof turn.reply==='string'?turn.reply:turn.reply.answer,/No invoice business fields changed|2026-10-20/);
  assert.equal((await f.read(f.ids[0])).notes,'Retained business note');assert.equal(await f.count('invoice_correction_audits'),1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

// Native default owner/provider HTTP, consolidated tool, SDK and SQL. The exact
// serialized canonical filter shape was observed live; malformed field values
// below are reconstructions because production intentionally logs no values.
test('serialized correction values and filters select the native audited route and expose only safe transport types',async()=>{
 const f=await fixture();try{
  const turn=await f.run(body=>{
   if(body.tools&&!body.messages.some(m=>m.role==='tool'))return toolCall({operation:'update',table:'invoices',filters:JSON.stringify(target),values:JSON.stringify({due_date:'2026-10-20'})});
   return completion('Invoice QA-CONTRACT-001 due date changed to 2026-10-20.');
  },'serialized-both','Change QA-CONTRACT-001 due date to 2026-10-20.');
  const result=turn.outputs.at(-1);assert.equal(result.completed,true,JSON.stringify(result));
  assert.equal(result.correctionTransport.valuesType,'string');assert.equal(result.correctionTransport.decodedValuesType,'object');
  assert.equal(result.correctionTransport.valuesDecoded,true);assert.equal(result.correctionTransport.filtersDecoded,true);
  assert.equal(result.correctionTransport.exactTarget,true);assert.equal(result.correctionTransport.route,'invoice_correction');
  assert.equal((await f.read(f.ids[0])).due_date,'2026-10-20');assert.equal(await f.count('invoice_correction_audits'),1);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);
  const diagnostic=turn.logs.find(row=>row.label==='WhatsApp owner tool call').data.correctionTransport;
  assert.deepEqual(diagnostic,result.correctionTransport);assert.doesNotMatch(JSON.stringify(diagnostic),/QA-CONTRACT|2026-10-20|Consulting/);
  await turn.handler(turn.turn);assert.equal(await f.count('invoice_correction_audits'),1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('missing correction values gets one current-message plan with the original serialized target before native persistence',async()=>{
 const f=await fixture();try{
  let plans=0;
  const message='Change QA-CONTRACT-001 due date to 2026-10-20.';
  const turn=await f.run(body=>{
   if(body.response_format){plans++;assert.equal(body.messages.at(-1).content,message);return completion(JSON.stringify({operation:'update',table:'invoices',filters:target,values:{due_date:'2026-10-20'}}));}
   if(body.tools&&!body.messages.some(m=>m.role==='tool'))return toolCall({operation:'update',table:'invoices',filters:JSON.stringify(target)});
   return completion('Invoice QA-CONTRACT-001 due date changed to 2026-10-20.');
  },'missing-values',message);
  const result=turn.outputs.at(-1);assert.equal(plans,1);assert.equal(result.completed,true,JSON.stringify(result));
  assert.equal(result.planningRepair.route,'invoice_correction');assert.equal(result.correctionTransport.valuesType,'undefined');
  assert.deepEqual(result.correctionTransport.valueFields,[]);assert.equal(result.correctionTransport.filtersDecoded,true);
  assert.equal((await f.read(f.ids[0])).due_date,'2026-10-20');assert.equal(await f.count('invoice_correction_audits'),1);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('serialized canonical invoice correction target saves a due date once through the native production toolset',async()=>{
 const f=await fixture();try{
  let calls=0;
  const turn=await f.run(body=>{
   calls++;
   if(body.tools&&!body.messages.some(m=>m.role==='tool')){
    const schema=body.tools.find(t=>t.function.name==='workspaceData').function;
    assert.match(schema.description,/Invoice update/);assert.doesNotMatch(schema.description,/status update only/);
    assert.equal(schema.parameters.properties.values.properties.subtotal.type,'number');
    return toolCall({operation:'update',table:'invoices',filters:JSON.stringify(target),values:{due_date:'2026-10-20'}});
   }
   return completion('Invoice QA-CONTRACT-001 due date changed to 2026-10-20.');
  },'serialized-due','Change QA-CONTRACT-001 due date to 2026-10-20.');
  assert.equal(turn.outputs.at(-1).completed,true,JSON.stringify(turn));assert.equal(calls,2);
  const after=await f.read(f.ids[0]);assert.equal(after.due_date,'2026-10-20');assert.equal(after.total_amount,100);assert.equal(after.currency,'USD');assert.equal(after.status,'draft');
  assert.equal(await f.count('invoice_correction_audits'),1);
  await turn.handler(turn.turn);
  assert.equal(await f.count('invoice_correction_audits'),1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('a rejected correction field shape replans once from typed catalog and current owner request before native SQL save',async()=>{
 const f=await fixture();try{
  let plans=0;
  const turn=await f.run(body=>{
   if(body.response_format){
    plans++;
    assert.equal(body.response_format.json_schema.name,'workspace_operation');
    const shape=body.response_format.json_schema.schema.properties.values.properties;
    assert.equal(shape.subtotal.type,'number');assert.deepEqual(shape.line_items.items.required,['description','amount']);
    assert.equal(shape.line_items.items.additionalProperties,false);assert.ok(shape.line_items.items.properties.unitPrice);
    assert.equal(body.messages.at(-1).content,request);
    assert.ok(body.messages.some(m=>m.content.includes('correctionValuesSchema')));
    // Derive the item keys from the advertised contract rather than bypassing
    // workspaceData with an injected direct operation/SQL call.
    const keys=Object.keys(shape.line_items.items.properties);
    const line=Object.fromEntries(keys.filter(k=>['description','quantity','unitPrice','amount'].includes(k)).map(k=>[k,{description:'Consulting service',quantity:1,unitPrice:6670,amount:6670}[k]]));
    return completion(JSON.stringify({operation:'update',table:'invoices',filters:target,values:{currency:'INR',subtotal:6670,total_amount:6670,tax:0,discount:0,line_items:[line],due_date:'2026-10-20'}}));
   }
   if(body.tools&&!body.messages.some(m=>m.role==='tool'))return toolCall({operation:'update',table:'invoices',filters:JSON.stringify(target),values:{currency:'INR',subtotal:'6,670',total_amount:6670,line_items:[{description:'Consulting service',quantity:1,unit_price:6670,amount:6670}],due_date:'2026-10-20'}});
   return completion('Invoice QA-CONTRACT-001 corrected to INR 6670, due 2026-10-20. It remains a draft with no reminders.');
  },'typed-correction');
  assert.equal(plans,1);const result=turn.outputs.at(-1);assert.equal(result.completed,true,JSON.stringify({reply:turn.reply,result}));
  assert.equal(result.planningRepair.route,'invoice_correction');assert.equal(result.planningRepair.validationCode,'INVALID_FIELDS');
  const after=await f.read(f.ids[0]);assert.equal(after.total_amount,6670);assert.equal(after.currency,'INR');assert.equal(after.metadata.subtotal,6670);assert.equal(after.metadata.tax,0);assert.equal(after.metadata.discount,0);
  assert.deepEqual(after.metadata.line_items,[{description:'Consulting service',quantity:1,unitPrice:6670,amount:6670}]);
  assert.deepEqual(after.metadata.source_document,f.before.metadata.source_document);assert.deepEqual(after.custom_fields,f.before.custom_fields);
  assert.equal(after.status,'draft');assert.equal(after.followup_state,'paused');assert.equal(after.next_follow_up_at,null);
  assert.equal(await f.count('invoice_correction_audits'),1);assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);
  assert.doesNotMatch(JSON.stringify(turn.logs),/QA-CONTRACT|6670|Consulting service/);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('catalog repair cannot change the original invoice target or widen into a status/payment action',async()=>{
 const f=await fixture();try{
  for(const [suffix,patch]of [['retarget',{filters:[{...target[0],value:'OTHER-INVOICE'}]}],['status',{values:{status:'paid'}}],['batch',{operation:'batch',operations:[]}]] ){
   let plans=0;
   const turn=await f.run(body=>{
    if(body.response_format){plans++;return completion(JSON.stringify({operation:'update',table:'invoices',filters:target,values:{total_amount:6670,subtotal:6670},...patch}));}
    if(body.tools&&!body.messages.some(m=>m.role==='tool'))return toolCall({operation:'update',table:'invoices',filters:target,values:{subtotal:'6,670',total_amount:6670}});
    return completion('No change was made.');
   },'repair-'+suffix);
   assert.equal(plans,1);assert.notEqual(turn.outputs.at(-1).completed,true);assert.notEqual(turn.outputs.at(-1).writeAttempted,true);
   assert.deepEqual(await f.read(f.ids[0]),f.before);assert.equal(await f.count('invoice_correction_audits'),0);
  }
  assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,0);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('native Gemini cached reads keep one bounded current-date execution opportunity despite prior failure history',async()=>{
 const f=await fixture();try{
  for(const [i,direction,body] of [[0,'inbound','Set amount to INR 6670 and due date 2026-10-20.'],[1,'outbound','Done, the due date was changed.'],[2,'outbound','The edit tool was not successfully run.']]){
   await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key,created_at) values($1,$2,$3,$4,'owner',$5,'normal',$6,$7,now()+$8::interval)",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,direction,body,direction==='inbound'?'received':'sent','history-'+i,i+' seconds']);
  }
  const outputs=[],sent=[],readArgs={operation:'read',table:'invoices',filters:target,columns:['invoice_number','due_date','total_amount','currency']};
  const response=parts=>Response.json({candidates:[{content:{parts},finishReason:'STOP'}]});
  const native=(args,id)=>response([{functionCall:{name:'workspaceData',args,id},thoughtSignature:'c2ln'+id}]);
  const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated'},authorize:input=>authorizeOwnerPhone({supabase:f.supabase,...input}),
   logger:{info(){},warn(){},error(){}},providerFactory:options=>new AIProvider({...options,primaryModel:'gemini-3.5-flash-lite',fallbackModel:null}),
   fetchImpl:async(url,init)=>{
    assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');const body=JSON.parse(init.body);sent.push(body);
    const replies=body.contents.flatMap(row=>row.parts).filter(p=>p.functionResponse).map(p=>p.functionResponse);
    const result=replies.at(-1)?.response;if(result)outputs.push(result);
    if(!result){assert.ok(body.contents.some(c=>c.parts.some(p=>p.text==='The edit tool was not successfully run.')));return native(readArgs,'read-first');}
    assert.equal(replies[0].id,'read-first');
    const original=body.contents.find(c=>c.role==='model'&&c.parts.some(p=>p.functionCall?.id==='read-first'));
    assert.equal(original.parts.find(p=>p.functionCall).thoughtSignature,'c2lnread-first');
    if(result.completed)return response([{text:'Done.'}]);
    if(replies.length===1)return native(readArgs,'read-cached');
    if(!body.tools)return response([{text:'The due date could not be updated because the edit tool was not successfully run.'}]);
    assert.match(body.systemInstruction.parts.map(p=>p.text).join('\n'),/cached invoice read is evidence only/);
    assert.equal(replies.at(-1).id,'read-cached');
    return native({operation:'update',table:'invoices',filters:target,values:{due_date:'2026-10-20'}},'update-current');
   }});
  const messageId='native-cached-current-date';await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,f.scope.phone,dueOnlyMessage]);
  const turn={...f.scope,messageId,message:dueOnlyMessage},reply=await handler(turn);
  assert.equal(sent.length,4,JSON.stringify({reply,outputs}));assert.ok(sent[2].tools,'current write opportunity must remain enabled');
  assert.equal(outputs.at(-1).completed,true,JSON.stringify({reply,outputs}));assert.deepEqual(outputs.at(-1).correction.changedFields,['due_date']);
  const after=await f.read(f.ids[0]);assert.equal(after.due_date,'2026-10-20');assert.equal(after.currency,'USD');assert.equal(after.total_amount,100);assert.equal(after.status,'draft');assert.equal(after.followup_state,'paused');
  assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);assert.equal(await f.count('invoice_correction_audits'),1);
  assert.match(reply.answer,/Due date: 2026-10-20/);await handler(turn);assert.equal(await f.count('invoice_correction_audits'),1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

async function runNativeMoney(f,initialValues,repairedValues,id,instruction=request){
 const outputs=[],sent=[];let repairs=0;
 const response=parts=>Response.json({candidates:[{content:{parts},finishReason:'STOP'}]});
 const native=(args,callId)=>response([{functionCall:{name:'workspaceData',args,id:callId},thoughtSignature:'isolated-signature-'+callId}]);
 const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated'},authorize:input=>authorizeOwnerPhone({supabase:f.supabase,...input}),
  logger:{info(){},warn(){},error(){}},providerFactory:options=>new AIProvider({...options,primaryModel:'gemini-3.5-flash-lite',fallbackModel:null}),
  fetchImpl:async(url,init)=>{
   assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');const body=JSON.parse(init.body);sent.push(body);
   if(body.generationConfig.responseMimeType==='application/json'){
    repairs++;assert.equal(body.contents.at(-1).parts[0].text,instruction);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,0,'repair must precede SQL dispatch');
    assert.ok(body.systemInstruction.parts.some(p=>p.text.includes('INVALID_FIELDS')));
    return response([{text:JSON.stringify({operation:'update',table:'invoices',filters:target,values:repairedValues})}]);
   }
   const result=body.contents.flatMap(row=>row.parts).filter(p=>p.functionResponse).at(-1)?.functionResponse.response;
   if(result)outputs.push(result);
   if(!result)return native({operation:'read',table:'invoices',filters:target,columns:['invoice_number','total_amount','currency','due_date']},'read');
   if(result.operation==='read')return native({operation:'update',table:'invoices',filters:target,values:initialValues},'money');
   return response([{text:'Done.'}]);
  }});
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,f.scope.phone,instruction]);
 const turn={...f.scope,messageId:id,message:instruction};return {reply:await handler(turn),outputs,sent,repairs,handler,turn};
}
const observedMoneyValues={due_date:'2026-10-20',subtotal:6670,total_amount:6670,line_items:[{description:'Consulting service charge',amount:6670}]};
test('observed native amount-only plan repairs explicit INR before one complete audited correction',async()=>{
 const f=await fixture();try{
  // A failed earlier instruction must not replace the current money evidence.
  await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key) values($1,$2,$3,'outbound','owner','The prior edit was not successfully run.','normal','sent','money-prior-failure')",[f.scope.workspaceId,f.scope.customerId,f.scope.phone]);
  const turn=await runNativeMoney(f,observedMoneyValues,{...observedMoneyValues,currency:'INR'},'native-explicit-money');
  assert.equal(turn.repairs,1);const result=turn.outputs.at(-1);assert.equal(result.completed,true,JSON.stringify(turn));
  assert.equal(result.planningRepair.route,'invoice_correction');assert.ok(result.correction.appliedFields.includes('currency'));assert.ok(result.correction.changedFields.includes('currency'));
  const after=await f.read(f.ids[0]);assert.equal(after.currency,'INR');assert.equal(after.total_amount,6670);assert.equal(after.metadata.subtotal,6670);assert.equal(result.record.outstanding_amount,6670);assert.equal(after.due_date,'2026-10-20');
  assert.equal(after.status,'draft');assert.equal(after.followup_state,'paused');assert.equal(after.next_follow_up_at,null);assert.deepEqual(after.metadata.source_document,f.before.metadata.source_document);
  assert.equal(await f.count('invoice_correction_audits'),1);assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);
  const audit=(await f.db.query('select to_jsonb(a) row from invoice_correction_audits a where invoice_id=$1',[f.ids[0]])).rows[0].row;
  assert.equal(audit.after_snapshot.currency,'INR');assert.equal(Number(audit.after_snapshot.total_amount),6670);
  assert.match(turn.reply.answer,/INR 6670/);await turn.handler(turn.turn);assert.equal(await f.count('invoice_correction_audits'),1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});
test('native repairs still missing currency or requested amounts stop before any invoice SQL',async()=>{
 for(const [suffix,values] of [['missing-currency',observedMoneyValues],['wrong-currency',{...observedMoneyValues,currency:'USD'}],['missing-total',{currency:'INR',subtotal:6670,due_date:'2026-10-20'}],['wrong-total',{...observedMoneyValues,currency:'INR',total_amount:6600}]]){
  const f=await fixture();try{
   const turn=await runNativeMoney(f,observedMoneyValues,values,'native-money-'+suffix);
   assert.equal(turn.repairs,1);assert.equal(turn.outputs.at(-1).validationCode,'INVALID_FIELDS');assert.equal(turn.outputs.at(-1).writeAttempted,false);
   assert.deepEqual(await f.read(f.ids[0]),f.before);assert.equal(await f.count('invoice_correction_audits'),0);assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,0);
   assert.doesNotMatch(turn.reply.answer,/corrected to INR|successfully|INR 6670/);await f.assertNoCustomerWrites();
  }finally{await f.close();}
 }
});

test('native explicit currency repair cannot bypass recorded payment history',async()=>{
 const f=await fixture();try{
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.scope.ownerId}';set role authenticated`);
  await f.db.query('select record_invoice_payment($1,$2,50,$3,$4,false)',[f.scope.workspaceId,f.ids[0],'money-protected-payment','Isolated original receipt']);
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const before=await f.read(f.ids[0]),payments=(await f.db.query('select to_jsonb(p) row from payments p where invoice_id=$1',[f.ids[0]])).rows;
  const turn=await runNativeMoney(f,observedMoneyValues,{...observedMoneyValues,currency:'INR'},'native-money-payment-guard');
  assert.equal(turn.repairs,1);assert.equal(turn.outputs.at(-1).code,'PAYMENT_GUARD');assert.deepEqual(await f.read(f.ids[0]),before);
  assert.deepEqual((await f.db.query('select to_jsonb(p) row from payments p where invoice_id=$1',[f.ids[0]])).rows,payments);assert.equal(await f.count('payment_reversals'),0);assert.equal(await f.count('invoice_correction_audits'),0);
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('unchanged currency read is version-bound and concurrent currency edits prevent SQL dispatch',async()=>{
 const f=await fixture();try{
  let readSeen=false,changed=false;
  f.intercept(async(url,options,db)=>{
   if(url.pathname.endsWith('/invoices')&&options.method==='GET'){
    if(url.searchParams.get('select').startsWith('id,currency,updated_at'))readSeen=true;
    else if(readSeen&&!changed&&url.searchParams.get('select')==='id,invoice_number,updated_at,metadata'){
     changed=true;await db.query("update invoices set currency='INR',updated_at=updated_at+interval '1 second' where id=$1",[f.ids[0]]);
    }
   }
  });
  const turn=await f.run(body=>{
   if(body.tools&&!body.messages.some(m=>m.role==='tool'))return toolCall({operation:'update',table:'invoices',filters:target,values:{total_amount:200,subtotal:200}});
   return completion('Done.');
  },'money-read-race','Set total to USD 200.');
  assert.equal(changed,true,JSON.stringify({outputs:turn.outputs,reads:f.requests.filter(r=>r.method==='GET').map(r=>new URL(r.url).searchParams.get('select'))}));assert.equal(turn.outputs.at(-1).code,'STALE');assert.equal((await f.read(f.ids[0])).total_amount,100);
  assert.equal(await f.count('invoice_correction_audits'),0);assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,0);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('recovered prior USD partial receipt reports incomplete INR correction and never replays a financial write',async()=>{
 const f=await fixture();try{
  await f.seedCorrection('recover-partial-money',request,observedMoneyValues);
  const turn=await f.run(()=>completion('Done.'),'recover-partial-money',request);
  assert.match(turn.reply.answer,/requested currency and amount correction was not fully applied/);assert.match(turn.reply.answer,/USD 6670/);assert.doesNotMatch(turn.reply.answer,/INR 6670/);
  assert.equal((await f.read(f.ids[0])).currency,'USD');assert.equal(await f.count('invoice_correction_audits'),1);assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});

test('native trailing monetary assignments require every explicit amount before SQL',async()=>{
 const f=await fixture();try{
  const instruction='Set subtotal to INR 6670 and total to 6670 and tax to 0 for QA-CONTRACT-001. Keep reminders off.';
  const initial={...observedMoneyValues,currency:'INR'},corrected={...initial,tax:0};
  const turn=await runNativeMoney(f,initial,corrected,'native-money-trailing',instruction);
  assert.equal(turn.repairs,1);assert.equal(turn.outputs.at(-1).completed,true);assert.ok(turn.outputs.at(-1).correction.appliedFields.includes('tax'));
  assert.equal((await f.read(f.ids[0])).metadata.tax,0);assert.equal(await f.count('invoice_correction_audits'),1);assert.equal(f.requests.filter(r=>r.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,1);await f.assertNoCustomerWrites();
 }finally{await f.close();}
});
