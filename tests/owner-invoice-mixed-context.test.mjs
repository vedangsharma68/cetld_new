import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';

const logger={info(){},warn(){},error(){}};
const clock=()=>new Date('2026-10-04T22:00:00Z');
const history=[
 {role:'user',content:'Mark OLD-PAID unpaid and change the OLD-DRAFT invoice to 1 USD.'},
 {role:'assistant',content:'There is an old reopening proposal. Confirm to reverse its original payment allocation; no refund will be sent.'},
 {role:'user',content:'Earlier I meant John in the old invoice. Keep its source file.'},
 {role:'assistant',content:'An earlier due date was 2019-02-26. Awaiting confirmation for the old invoice only.'},
];

test('mixed proposal history and adversarial serialized Gemini plans remain scoped, current, honest and interruptible',async t=>{
 const fixture=await createOfflineSqlNetwork(),{db,supabase}=fixture,ownerId=randomUUID(),foreignOwner=randomUUID(),phone='+919871367051';
 let sequence=0;
 try{
  await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
  async function workspace(actor,label){
   await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
   return (await db.query('select (public.create_workspace($1,$2)).id',[label,label+'-'+randomUUID()])).rows[0].id;
  }
  const workspaceId=await workspace(ownerId,'mixed-own');
  const code=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0].code;
  const foreignWorkspace=await workspace(foreignOwner,'mixed-foreign');
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,code])).rows[0].value.ok,true);
  const customerId=(await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const scope={workspaceId,ownerId,customerId,phone};
  const john=(await db.query("insert into customers(workspace_id,name,phone) values($1,'John Smith','+919822222222') returning id",[workspaceId])).rows[0];
  const foreignJohn=(await db.query("insert into customers(workspace_id,name,phone) values($1,'John Smith','+919833333333') returning id",[foreignWorkspace])).rows[0];
  await db.exec('reset role'); // Seed isolated historical fixtures as their database owner.
  const source={invoice_direction:'receivable',source_file:'immutable-original.pdf',printed_invoice_number:'SOURCE-2019',extraction_raw:{due_date:'2019-02-26'},subtotal:100,tax:0,line_items:[{description:'Original service',amount:100}]};
  const ownInvoice=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency,notes,metadata) values($1,$2,'MIX-1','2026-10-01','2026-10-05',100,'USD','Own notes',$3::jsonb) returning *",[workspaceId,john.id,JSON.stringify(source)])).rows[0];
  const foreignInvoice=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency,notes,metadata) values($1,$2,'MIX-FOREIGN','2026-10-01','2026-10-05',100,'USD','Foreign private notes',$3::jsonb) returning *",[foreignWorkspace,foreignJohn.id,JSON.stringify(source)])).rows[0];
  const oldPaid=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency,metadata) values($1,$2,'OLD-PAID','2026-10-01','2026-10-05',100,'USD',$3::jsonb) returning *",[workspaceId,john.id,JSON.stringify({...source,printed_invoice_number:'SOURCE-OLD-PAID'})])).rows[0];
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  await db.query('select public.record_invoice_payment($1,$2,null,$3,$4,true)',[workspaceId,oldPaid.id,'mixed-original-receipt','Actual fixture payment']);
  await db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values('mixed-old-reopen','123456',$1,'text','Reopen the old paid invoice','processing')",[phone]);
  assert.equal((await db.query("select public.whatsapp_invoice_reopening($1,$2,$3,'mixed-old-reopen','Reopen the old paid invoice','prepare',$4) value",[workspaceId,ownerId,phone,oldPaid.id])).rows[0].value.ok,true);
  const pending=createWhatsAppPendingActionStore({supabase}),pendingAtStart=await pending.loadPendingAction(scope);
  assert.equal(pendingAtStart.action.type,'owner_invoice_reopen');
  const target=[{column:'invoice_number',operator:'eq',value:ownInvoice.invoice_number}];
  const facts=async()=> (await db.query(`select jsonb_build_object(
   'foreignInvoice',(select to_jsonb(i) from invoices i where id=$1),
   'foreignCustomer',(select to_jsonb(c) from customers c where id=$2),
   'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from payments p),
   'reversals',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from payment_reversals r),
   'auditCount',(select count(*) from invoice_correction_audits),
   'receiptCount',(select count(*) from whatsapp_direct_write_receipts),
   'ownInvoice',(select to_jsonb(i) from invoices i where id=$3)) value`,[foreignInvoice.id,foreignJohn.id,ownInvoice.id])).rows[0].value;
  const oldFacts=async()=>(await db.query(`select jsonb_build_object('invoice',(select to_jsonb(i) from invoices i where id=$1),'proposals',(select jsonb_agg(to_jsonb(q) order by id) from invoice_reopening_proposals q),'pending',(select jsonb_agg(to_jsonb(p) order by id) from whatsapp_pending_actions p)) value`,[oldPaid.id])).rows[0].value;
  const initial=await facts();
  const initialOld=await oldFacts();
  async function turn(message,args,answer,{abort=false,turnHistory=history}={}){
   const id='mixed-'+(++sequence),controller=new AbortController();
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text',$3,'processing')",[id,phone,message]);
   const tools=createOwnerWorkspaceTools({supabase,scope,message,messageId:id,authorize:async()=>true,clock,timezone:'Asia/Kolkata',signal:controller.signal,
    botPreferences:{confirmationMode:'direct'},pending,pendingAtStart,ownerHistory:turnHistory,logger,ownerStore:{async query(){throw Error('Legacy command path must not run');}}});
   let calls=0,wire,evidence;
   const provider=new AIProvider({primaryModel:'gemini-3.5-flash-lite',fallbackModel:null,geminiApiKey:'isolated-fixture',maxAttempts:1,logger,
    fetchImpl:async(_url,init)=>{
     calls++;wire=JSON.parse(init.body);
     if(calls===1){if(abort)controller.abort('Fixture cancellation before dispatch');return Response.json({candidates:[{content:{parts:[{functionCall:{name:'workspaceData',args}}]},finishReason:'STOP'}]});}
     evidence=wire.contents.flatMap(row=>row.parts).flatMap(part=>{try{return [JSON.parse(part.text)];}catch{return [];}}).filter(row=>row.operation||row.code).at(-1);
     return Response.json({candidates:[{content:{parts:[{text:answer}]},finishReason:'STOP'}]});
    }});
   const result=await runOwnerAgent({provider,message,tools,history:turnHistory,clock,timezone:'Asia/Kolkata',signal:controller.signal});
   return {result,evidence,tools,calls,wire};
  }
  await t.test('current JohnSmith read ignores old confirmation and foreign same-name contact',async()=>{
   const output=await turn("What is JohnSmith's phone? Read it only.",{operation:'read',table:'customers',filters:[{column:'name',operator:'eq',value:'JohnSmith'}],columns:['name','phone']},"John Smith's phone is +919822222222.");
   assert.equal(output.evidence.ok,true,JSON.stringify(output.result));assert.equal(output.evidence.rows[0].phone,'+919822222222');
   assert(!JSON.stringify(output.wire).includes('+919833333333'));assert.equal(output.tools.getWriteAttempted(),false);
   assert(!/awaiting|confirm|revers|updated/i.test(output.result.answer));assert.deepEqual(await facts(),initial);
  });
  await t.test('foreign ids and forbidden scope/security plans cannot read or mutate business facts',async()=>{
   const attacks=[
    {operation:'confirm'},
    {operation:'read',table:'invoices',filters:[{column:'id',operator:'eq',value:foreignInvoice.id}],columns:['invoice_number','notes']},
    {operation:'update',table:'invoices',filters:[{column:'id',operator:'eq',value:foreignInvoice.id}],values:{notes:'Cross-tenant edit'}},
    {operation:'update',table:'invoices',filters:target,values:{customer_id:foreignJohn.id}},
    {operation:'update',table:'invoices',filters:target,values:{metadata:{invoice_direction:'payable',owner_id:foreignOwner}}},
    {operation:'update',table:'invoices',filters:target,values:{custom_fields:{owner_id:foreignOwner}}},
    {operation:'update',table:'invoices',filters:target,values:{custom_fields:{api_key:'must-not-persist'}}},
    {operation:'update',table:'invoices',filters:target,values:{notes:'Bad scope'},workspace_id:foreignWorkspace},
   ];
   for(const args of attacks){
    const start=fixture.requests.length;
    const output=await turn('Show or change only my current invoice; never touch another workspace.',args,'No changes were made.');
    assert.equal(fixture.requests.slice(start).filter(request=>request.method==='POST'&&/rpc\/(?:whatsapp_correct_owner_invoice|whatsapp_apply_direct_owner_write|whatsapp_apply_owner_batch)/.test(request.url)).length,0,JSON.stringify(args));
    assert(!JSON.stringify(output.wire).includes('Foreign private notes'));assert(!/updated|saved|awaiting confirmation/i.test(output.result.answer));
    if(args.operation==='read')assert.equal(output.evidence.rows.length,0);else assert.equal(output.evidence.ok,false);
    assert.deepEqual(await facts(),initial);
   }
  });
  await t.test('current tomorrow wins over stale dates without changing source or payment history',async()=>{
   const output=await turn(`Set ${ownInvoice.invoice_number} due date to tomorrow.`,{operation:'update',table:'invoices',filters:target,values:{due_date:'2019-02-26'}},`Updated ${ownInvoice.invoice_number} due date to 2026-10-06.`);
   assert.equal(output.evidence.completed,true,JSON.stringify(output.result));assert.equal(output.evidence.record.due_date,'2026-10-06');assert(!Object.hasOwn(output.evidence.record,'metadata'));
   const current=await facts();assert.equal(current.ownInvoice.due_date,'2026-10-06');assert.equal(current.ownInvoice.metadata.source_file,source.source_file);assert.deepEqual(current.ownInvoice.metadata.extraction_raw,source.extraction_raw);
   assert.equal(current.auditCount,1);assert.equal(current.receiptCount,1);assert.deepEqual(current.foreignInvoice,initial.foreignInvoice);assert.deepEqual(current.foreignCustomer,initial.foreignCustomer);assert.deepEqual(current.payments,initial.payments);assert.deepEqual(current.reversals,initial.reversals);
  });
  await t.test('listed John contact supports a pronoun phone edit, normalized reread and persisted replay without foreign changes',async()=>{
   const listed=await turn('List my customers.',{operation:'read',table:'customers',columns:['name','phone']},"John Smith's phone is +919822222222.");
   assert(listed.evidence.rows.some(row=>row.name==='John Smith'&&row.phone==='+919822222222'));
   const turnHistory=[...history,{role:'user',content:'List my customers.'},{role:'assistant',content:listed.result.answer}];
   const changed=await turn('Set his phone number to +919844444444.',{operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'John'}],values:{phone:'+919844444444'}},"Updated John Smith's phone to +919844444444.",{turnHistory});
   assert.equal(changed.evidence.completed,true,JSON.stringify(changed.result));
   assert.equal(changed.evidence.record.name,'John Smith');assert.equal(changed.evidence.record.phone,'+919844444444');
   assert.equal((await changed.tools.lookupCompleted()).completed,true);assert.equal((await changed.tools.lookupCompleted()).completed,true);
   assert.equal((await db.query('select phone from customers where id=$1',[john.id])).rows[0].phone,'+919844444444');
   const reread=await turn("What is JohnSmith's phone now?",{operation:'read',table:'customers',filters:[{column:'name',operator:'eq',value:'JohnSmith'}],columns:['name','phone']},"John Smith's phone is +919844444444.");
   assert.equal(reread.evidence.rows[0].phone,'+919844444444');assert(!/confirm|awaiting/i.test(changed.result.answer));
   const current=await facts();assert.deepEqual(current.foreignCustomer,initial.foreignCustomer);assert.deepEqual(current.foreignInvoice,initial.foreignInvoice);assert.deepEqual(current.payments,initial.payments);assert.deepEqual(current.reversals,initial.reversals);
  });
  await t.test('own ambiguity and caller cancellation stop writes before dispatch',async()=>{
   await db.query("insert into customers(workspace_id,name) values($1,'John Jones')",[workspaceId]);
   const before=await facts();
   const ambiguous=await turn(`Assign ${ownInvoice.invoice_number} to John.`,{operation:'update',table:'invoices',filters:target,values:{customer_name:'John'}},'No changes were made.');
   assert.equal(ambiguous.evidence.code,'AMBIGUOUS');assert.equal(ambiguous.tools.getWriteAttempted(),false);assert.deepEqual(await facts(),before);
   const cancelled=await turn('Set its notes to a cancelled edit.',{operation:'update',table:'invoices',filters:target,values:{notes:'Must never persist'}},'No changes were made.',{abort:true});
   assert.equal(cancelled.tools.getWriteAttempted(),false);assert.deepEqual(await facts(),before);assert(!/updated|saved/i.test(cancelled.result.answer));
  });
  for(const request of fixture.requests.filter(request=>request.method==='GET'))assert.equal(new URL(request.url).searchParams.get('workspace_id'),'eq.'+workspaceId);
  assert.deepEqual(await oldFacts(),initialOld,'old paid invoice, immutable receipts and unrelated reopening proposal must remain unchanged');
  assert.deepEqual(fixture.errors,[]);
 }finally{await fixture.close();}
});
