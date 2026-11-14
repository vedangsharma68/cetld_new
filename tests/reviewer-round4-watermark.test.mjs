import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{fixture}from'./fixtures/private-invoice.mjs';import{AIProvider}from'../ai/provider.mjs';import{createWhatsAppBoundMessageHandler}from'../automation/whatsapp/assistant-handler.mjs';import{runPrivateInvoiceBackfill}from'../scripts/backfill-private-invoice-terms.mjs';
const migrationName='20261101120327_private_whatsapp_chat_memory.sql',out={};
test('allComplete must cover historical review IDs beyond nine',async t=>{
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'local-watermark',cfApiToken:'local-watermark',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'A safe ordinary answer'}}]});}});
 const f=await fixture({providerFactory:factory,sqlNetworkOptions:{excludeMigrations:[migrationName]}});
 try{
  await f.db.query(`insert into whatsapp_pending_actions(id,workspace_id,customer_id,phone,action,source,consumed_at,expires_at)
    select n,$1,$2,$3,case when n=10 then jsonb_build_object('type','invoice_review_draft','invoice',jsonb_build_object('customerName','Hidden Historical Studio','total',45678))else jsonb_build_object('type','other')end,'whatsapp',now(),now()+interval '1 day'
    from generate_series(1,10)n`,[f.scope.workspaceId,f.scope.customerId,f.scope.phone]);
  await f.db.exec(await readFile('supabase/migrations/'+migrationName,'utf8'));
  const batches=[];out.finalStatus=await runPrivateInvoiceBackfill({batchSize:25,execute:async sql=>{const result=await f.db.exec(sql);return result.find(r=>r.rows?.[0]?.result)?.rows[0].result;},onBatch:s=>batches.push(s)});
  out.batches=batches;out.progress=(await f.db.query('select * from whatsapp_private_invoice_backfill order by source')).rows;
  out.watermark=(await f.db.query('select max(id) numeric_max,(select id::text from whatsapp_pending_actions order by id desc limit 1) candidate_watermark from whatsapp_pending_actions')).rows[0];
  out.terms=(await f.db.query('select term from whatsapp_private_invoice_terms order by term')).rows.map(r=>r.term);
  assert.equal(out.finalStatus.allComplete,true);
  await t.test('historical private alias is actually retained',()=>assert.ok(out.terms.includes('number:45678'),JSON.stringify(out)));
  const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});out.payloads=[];
  for(const audience of ['owner','customer'])await t.test(audience,async()=>{
   const before=wires.length,input='send 45678 today',result=audience==='owner'?await f.turn(input):await customer({...f.scope,message:input,messageId:'watermark-customer'});
   const row={audience,input,result,wires:wires.slice(before)};out.payloads.push(row);assert.equal(row.wires.length,0,'Skipped historical private amount reached provider: '+JSON.stringify(row.wires.map(w=>w.body.messages)));
  });
 }finally{await f.close();}
});
