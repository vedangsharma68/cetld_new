import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

const phone='+919871367051';
const logger={info(){},warn(){},error(){}};

test('native repeated rejected reads log only filter structure without invoking ineligible repair or reaching the invoice',async()=>{
  // These shapes reproduce the observed failure signature, not historical raw arguments.
  const f=await fixture();try{
    const {db,supabase,scope,customerId}=f;
    const invoice=await createInvoice(db,scope.workspaceId,customerId,'INV-2026-0001',100);
    const before=(await db.query('select to_jsonb(i) value from invoices i where id=$1',[invoice.id])).rows[0].value;
    const privateValue='Synthetic Customer secret_marker_729';
    const shapes=[null,JSON.stringify(null),{invoice_number:{eq:privateValue},[privateValue]:privateValue}];
    for(const [index,filters]of shapes.entries()){
      const message=`Show invoice ${invoice.invoice_number} and its edit options. Do not change any data.`,messageId=`diagnostic-gap-${index}`;
      await addInbound(db,messageId,message);
      const logs=[];let calls=0,plans=0;
      const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',WHATSAPP_APP_SECRET:'isolated-read-diagnostic'},authorize:async()=>true,
        logger:{info(label,data){logs.push({label,data});},warn(){},error(){}},
        providerFactory:()=>new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger,
          fetchImpl:async(_url,init)=>{
            const request=JSON.parse(init.body);calls++;
            if(request.response_format?.type==='json_schema'){plans++;throw Error('Ineligible repair must not invoke the planner');}
            if(calls<=3)return Response.json({choices:[{message:{content:'',tool_calls:[{id:`repeat-${calls}`,type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices',filters})}}]},finish_reason:'tool_calls'}]});
            return Response.json({choices:[{message:{content:`I couldn't find invoice ${invoice.invoice_number}.`},finish_reason:'stop'}]});
          }})});
      const result=await handler({...scope,messageId,message});
      assert.match(result.answer,/could not prepare a safe reply/);assert.equal(plans,0);assert.equal(calls,5);
      const toolLogs=logs.filter(row=>row.label==='WhatsApp owner tool call');assert.equal(toolLogs.length,1);
      const diagnostic=toolLogs[0].data.filterShapeDiagnostic;
      assert.equal(diagnostic.structure.type,filters===null?'null':typeof filters);
      assert.deepEqual(JSON.parse(toolLogs[0].data.filterShapeStructure),diagnostic.structure);
      assert.equal(diagnostic.repair.attempted,false);assert.equal(diagnostic.repair.readEligibilityReason,'filter_object_not_catalog_valid');
      assert.doesNotMatch(JSON.stringify(logs),/Synthetic Customer|secret_marker_729/);
      assert.equal(toolLogs[0].data.validationCode,'FILTER_SHAPE');
      assert.deepEqual(toolLogs[0].data.validationShape,{operation:'read',table:'invoices',filters:[],valueFields:[]});
    }
    assert.deepEqual((await db.query('select to_jsonb(i) value from invoices i where id=$1',[invoice.id])).rows[0].value,before);
    assert.equal((await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n,0);
    assert.equal(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')),false);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

async function fixture(){
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID();
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Owner live edit regression',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const binding=(await db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  const scope={workspaceId,ownerId,customerId:binding.customer_id,phone};
  const customer=(await db.query("insert into public.customers(workspace_id,name) values($1,'John Smith') returning id",[workspaceId])).rows[0];
  await db.query("update public.workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}'::jsonb where workspace_id=$1",[workspaceId]);
  return {...f,scope,customerId:customer.id};
}

async function createInvoice(db,workspaceId,customerId,number,total){
  return (await db.query(`insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
    values($1,$2,$3,'2026-10-01','2099-01-01','USD',$4,'sent','{"invoice_direction":"receivable"}') returning *`,
  [workspaceId,customerId,number,total])).rows[0];
}

async function addInbound(db,id,message){
  await db.query(`insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status)
    values($1,'123456',$2,'text',$3,'processing') on conflict(provider_message_id) do nothing`,[id,phone,message]);
}

function handlerWithNativeCall(supabase,scope,{messageId,args,onFinal,plannerOutput=null,expectedPlannerMessage=null}={}){
  let calls=0;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger,authorize:async()=>true,
    providerFactory:()=>new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger,
      fetchImpl:async(_url,init)=>{
        calls++;const request=JSON.parse(init.body);
        if(calls===1){
          assert(request.tools?.some(tool=>tool.function.name==='workspaceData'));
          return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'cf-native-update',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}]}}]});
        }
        if(request.response_format?.type==='json_schema'){
          assert(plannerOutput,'The real owner planner should run only for the natural-language tool request');
          if(expectedPlannerMessage!==null)assert.equal(request.messages.at(-1).content,expectedPlannerMessage);
          return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plannerOutput)}}]});
        }
        const toolResult=request.messages.findLast(item=>item.role==='tool');
        assert(toolResult,'the model must receive the consolidated workspaceData result');
        const value=JSON.parse(toolResult.content);onFinal?.(value);
        const content=value.ok===true
          ?Number(value.record.overpayment_amount)>0
            ?`Corrected ${value.record.invoice_number} total to ${value.record.currency} ${value.record.total_amount}. The recorded payment remains ${value.record.currency} ${value.record.amount_paid}, leaving an overpayment of ${value.record.currency} ${value.record.overpayment_amount}.`
            :`Corrected ${value.record.invoice_number} total to ${value.record.currency} ${value.record.total_amount}. Payment and reversal history remain intact.`
          :'I could not change both the amount and currency because payment history protects this invoice. No change was made.';
        return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
      }})});
  return {handler,calls:()=>calls};
}

test('consolidated Cloudflare workspaceData update blocks amount plus currency change after fully reversed payment without throwing or mutating',async()=>{
  const f=await fixture();
  try{
    const {db,supabase,scope,customerId}=f;
    await createInvoice(db,scope.workspaceId,customerId,'INV-2026-0001',10);
    const invoice=await createInvoice(db,scope.workspaceId,customerId,'INV-2026-0002',154.06);
    assert.equal(invoice.invoice_number,'INV-2026-0002');
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${scope.ownerId}';set role authenticated`);
    await db.query('select public.record_invoice_payment($1,$2,154.06,$3,$4,false)',[scope.workspaceId,invoice.id,'john-invoice-original-payment','Original receipt']);
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    const sourceId='john-reopen-source';await addInbound(db,sourceId,'Mark John Smith invoice unpaid');
    const prepared=(await db.query(`select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,'prepare',$6) value`,
      [scope.workspaceId,scope.ownerId,phone,sourceId,'Mark John Smith invoice unpaid',invoice.id])).rows[0].value;
    assert.equal(prepared.ok,true,JSON.stringify(prepared));
    const pending=(await db.query("select id,version from public.whatsapp_pending_actions where workspace_id=$1 and action->>'proposalId'=$2 and consumed_at is null",
      [scope.workspaceId,prepared.proposalId])).rows[0];
    const confirmId='john-reopen-confirm';await addInbound(db,confirmId,'yes');
    const reopened=(await db.query(`select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,'confirm',null,$6,$7,$8,null) value`,
      [scope.workspaceId,scope.ownerId,phone,confirmId,'yes',prepared.proposalId,pending.id,pending.version])).rows[0].value;
    assert.equal(reopened.completed,true,JSON.stringify(reopened));
    const original=(await db.query('select * from public.invoices where id=$1',[invoice.id])).rows[0];
    const history=(await db.query('select to_jsonb(p) value from public.payments p where invoice_id=$1',[invoice.id])).rows;
    const reversals=(await db.query('select to_jsonb(r) value from public.payment_reversals r where invoice_id=$1',[invoice.id])).rows;
    assert.equal(Number(original.amount_paid),0);assert.equal(history.length,1);assert.equal(reversals.length,1);

    const messageId='john-total-currency-edit',message="chnage the amount in john smiths invoice to 6670 inr";
    await addInbound(db,messageId,message);
    let actualToolResult;
    const {handler,calls}=handlerWithNativeCall(supabase,scope,{messageId,args:{operation:'update',table:'invoices',
      filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-0002'}],values:{total_amount:6670,currency:'INR'}},
      onFinal:value=>{actualToolResult=value;}});
    const result=await handler({...scope,messageId,message});
    assert.equal(result.plannerFailure,undefined,JSON.stringify(result));
    assert.equal(calls(),2,'Cloudflare tool call and final response should both complete');
    assert.equal(actualToolResult?.ok,false,JSON.stringify({result,actualToolResult,errors:f.errors}));
    assert.equal(actualToolResult?.code,'PAYMENT_GUARD',JSON.stringify(actualToolResult));
    assert.equal(actualToolResult?.operation,'update');assert.equal(actualToolResult?.table,'invoices');
    assert.match(result.answer,/payment history/i);
    const after=(await db.query('select * from public.invoices where id=$1',[invoice.id])).rows[0];
    assert.deepEqual(after,original);assert.deepEqual((await db.query('select to_jsonb(p) value from public.payments p where invoice_id=$1',[invoice.id])).rows,history);
    assert.deepEqual((await db.query('select to_jsonb(r) value from public.payment_reversals r where invoice_id=$1',[invoice.id])).rows,reversals);
    assert.equal((await db.query('select count(*)::int n from public.invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n,0);
    assert(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')));
    assert.deepEqual(f.errors,[]);

    const naturalId='john-natural-language-edit';await addInbound(db,naturalId,message);
    const natural=handlerWithNativeCall(supabase,scope,{messageId:naturalId,args:{request:message},
      plannerOutput:{operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-0002'}],
        values:{total_amount:6670,currency:'INR'}},expectedPlannerMessage:message,onFinal:value=>{actualToolResult=value;}});
    const naturalResult=await natural.handler({...scope,messageId:naturalId,message});
    assert.equal(naturalResult.plannerFailure,undefined,JSON.stringify(naturalResult));
    assert.equal(natural.calls(),3,'Cloudflare request, structured planner, and final response should complete');
    assert.equal(actualToolResult?.code,'PAYMENT_GUARD',JSON.stringify(actualToolResult));
    assert.equal(actualToolResult?.operation,'update');assert.equal(actualToolResult?.table,'invoices');
    assert.deepEqual((await db.query('select * from public.invoices where id=$1',[invoice.id])).rows[0],original);

    const totalOnlyId='john-total-only-usd-edit',totalOnlyMessage='Change John Smith invoice INV-2026-0002 total to 6670 USD';
    await addInbound(db,totalOnlyId,totalOnlyMessage);
    const totalOnly=handlerWithNativeCall(supabase,scope,{messageId:totalOnlyId,args:{operation:'update',table:'invoices',
      filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-0002'}],values:{total_amount:6670}},
      onFinal:value=>{actualToolResult=value;}});
    const totalOnlyResult=await totalOnly.handler({...scope,messageId:totalOnlyId,message:totalOnlyMessage});
    assert.equal(totalOnlyResult.plannerFailure,undefined,JSON.stringify(totalOnlyResult));
    assert.equal(actualToolResult?.ok,true,JSON.stringify(actualToolResult));
    assert.equal(Number(actualToolResult.record.total_amount),6670);assert.equal(actualToolResult.record.currency,'USD');
    assert.equal(Number(actualToolResult.record.amount_paid),0);assert.equal(Number(actualToolResult.record.overpayment_amount),0);
    const corrected=(await db.query('select * from public.invoices where id=$1',[invoice.id])).rows[0];
    assert.equal(Number(corrected.total_amount),6670);assert.equal(corrected.currency,'USD');
    assert.deepEqual((await db.query('select to_jsonb(p) value from public.payments p where invoice_id=$1',[invoice.id])).rows,history);
    assert.deepEqual((await db.query('select to_jsonb(r) value from public.payment_reversals r where invoice_id=$1',[invoice.id])).rows,reversals);
    assert.equal((await db.query('select count(*)::int n from public.invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n,1);
  }finally{await f.close();}
});

test('consolidated total-only correction preserves payment history and records overpayment',async()=>{
  const f=await fixture();
  try{
    const {db,supabase,scope,customerId}=f;
    const invoice=await createInvoice(db,scope.workspaceId,customerId,'INV-OVERPAY',100);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${scope.ownerId}';set role authenticated`);
    await db.query('select public.record_invoice_payment($1,$2,100,$3,$4,false)',[scope.workspaceId,invoice.id,'total-only-receipt','Original full payment']);
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    const beforePayments=(await db.query('select to_jsonb(p) value from public.payments p where invoice_id=$1',[invoice.id])).rows;
    const messageId='john-total-only-edit',message='Change INV-OVERPAY total to 80';await addInbound(db,messageId,message);
    let actualToolResult;
    const {handler,calls}=handlerWithNativeCall(supabase,scope,{messageId,args:{operation:'update',table:'invoices',
      filters:[{column:'invoice_number',operator:'eq',value:invoice.invoice_number}],values:{total_amount:80}},
      onFinal:value=>{actualToolResult=value;}});
    const result=await handler({...scope,messageId,message});
    assert.equal(result.plannerFailure,undefined,JSON.stringify(result));assert.equal(calls(),2);
    assert.equal(actualToolResult?.ok,true,JSON.stringify({result,actualToolResult,errors:f.errors}));
    assert.equal(actualToolResult.completed,true);assert.equal(Number(actualToolResult.record.total_amount),80);
    assert.equal(Number(actualToolResult.record.amount_paid),100);assert.equal(Number(actualToolResult.record.overpayment_amount),20);
    assert.match(result.answer,/overpayment of USD 20/);
    assert.deepEqual((await db.query('select to_jsonb(p) value from public.payments p where invoice_id=$1',[invoice.id])).rows,beforePayments);
    assert.equal((await db.query('select count(*)::int n from public.invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n,1);
    assert(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')));
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('malformed update filters return a structured validation result instead of throwing after workspaceData catches validation',async()=>{
  const f=await fixture();
  try{
    const {db,supabase,scope}=f;
    for(const [index,filters] of [
      ['object',{column:'invoice_number',operator:'eq',value:'INV-2026-0002'}],
      ['string','invoice_number eq INV-2026-0002'],
      ['null',null],
    ].entries()){
      const messageId=`malformed-live-edit-filters-${index}`,message='chnage the amount in john smiths invoice to 6670 inr';
      await addInbound(db,messageId,message);
      let actualToolResult;
      const {handler,calls}=handlerWithNativeCall(supabase,scope,{messageId,args:{operation:'update',table:'invoices',
        filters,values:{total_amount:6670,currency:'INR'}},onFinal:value=>{actualToolResult=value;}});
      const result=await handler({...scope,messageId,message});
      assert.equal(result.plannerFailure,undefined,JSON.stringify({filters,result}));
      assert.equal(actualToolResult?.ok,false,JSON.stringify({filters,result,actualToolResult,errors:f.errors}));
      assert.equal(actualToolResult?.code,'INVALID',JSON.stringify({filters,actualToolResult}));
      assert.equal(actualToolResult?.validationCode,'FILTER_SHAPE',JSON.stringify({filters,actualToolResult}));
      assert.equal(actualToolResult?.writeAttempted,false,JSON.stringify({filters,actualToolResult}));
      assert.equal(calls(),2);
    }
    assert.equal((await db.query('select count(*)::int n from public.invoices where workspace_id=$1',[scope.workspaceId])).rows[0].n,0);
    assert.equal(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')),false);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('native malformed invoice read repairs once and cannot turn validation failure or a present row into not-found edit options',async()=>{
  const f=await fixture();try{
    const {db,supabase,scope,customerId}=f;
    await createInvoice(db,scope.workspaceId,customerId,'INV-2026-0001',10);
    const invoice=await createInvoice(db,scope.workspaceId,customerId,'INV-2026-0002',154.06);
    assert.equal(invoice.invoice_number,'INV-2026-0002');
    const before=(await db.query('select to_jsonb(i) value from invoices i where id=$1',[invoice.id])).rows[0].value;
    const message='Show invoice INV-2026-0002 and its edit options. Do not change any data.',messageId='native-malformed-invoice-read';
    await addInbound(db,messageId,message);
    let nativeCalls=0,plannerCalls=0,toolResult,plannerOperation='read';
    const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',WHATSAPP_APP_SECRET:'isolated-invoice-read-menu'},logger,authorize:async()=>true,
      providerFactory:()=>new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger,
        fetchImpl:async(_url,init)=>{
          const request=JSON.parse(init.body);
          if(request.response_format?.type==='json_schema'){
            plannerCalls++;
            assert.equal(request.messages.at(-1).content,message);
            const hint=request.messages.find(turn=>turn.role==='system'&&turn.content.startsWith('Model-supplied request hint, for context only: '));
            assert.deepEqual(JSON.parse(JSON.parse(hint.content.slice('Model-supplied request hint, for context only: '.length))),{request:message,hints:{operation:'read',table:'invoices'}});
            return Response.json({choices:[{message:{content:JSON.stringify({operation:plannerOperation,table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:invoice.invoice_number}],...(plannerOperation==='update'?{values:{notes:'Unrequested change'}}:{})})},finish_reason:'stop'}]});
          }
          nativeCalls++;
          if(nativeCalls===1)return Response.json({choices:[{message:{content:'',tool_calls:[{id:'bad-read',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices',filters:{column:'invoice_number',operator:'eq',value:invoice.invoice_number}})}}]},finish_reason:'tool_calls'}]});
          toolResult=JSON.parse(request.messages.findLast(turn=>turn.role==='tool').content);
          return Response.json({choices:[{message:{content:plannerOperation==='read'?"I couldn't find the invoice INV-2026-0002.":"I couldn't check that invoice right now. No changes were made."},finish_reason:'stop'}]});
        }})});
    const result=await handler({...scope,messageId,message});
    assert.equal(result.plannerFailure,undefined,JSON.stringify({result,toolResult,plannerCalls,nativeCalls,errors:f.errors,requests:f.requests.slice(-4)}));
    assert.equal(toolResult?.ok,true,JSON.stringify({toolResult,result}));
    assert.equal(toolResult?.planningRepair?.validationCode,'FILTER_SHAPE');
    assert.equal(plannerCalls,1);assert.equal(nativeCalls,2);
    assert.match(result.answer,/Invoice INV-2026-0002/);assert.match(result.answer,/John Smith/);assert.match(result.answer,/USD 154\.06/);
    assert.match(result.answer,/No changes were made/);assert.doesNotMatch(result.answer,/couldn't find/i);
    assert(result.buttons?.some(choice=>choice.title==='Edit details'),JSON.stringify({result,errors:f.errors}));
    assert.deepEqual((await db.query('select to_jsonb(i) value from invoices i where id=$1',[invoice.id])).rows[0].value,before);
    assert.equal((await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n,0);
    assert.equal(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')),false);
    plannerOperation='update';nativeCalls=0;plannerCalls=0;
    const blockedId='malformed-read-repair-cannot-write';await addInbound(db,blockedId,message);
    const blocked=await handler({...scope,messageId:blockedId,message});
    assert.equal(blocked.plannerFailure,undefined,JSON.stringify(blocked));
    assert.equal(toolResult.ok,false);assert.equal(toolResult.code,'INVALID');
    assert.equal(plannerCalls,1);assert.equal(nativeCalls,2);
    assert.deepEqual((await db.query('select to_jsonb(i) value from invoices i where id=$1',[invoice.id])).rows[0].value,before);
    assert.equal((await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n,0);
    assert.equal(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')),false);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
