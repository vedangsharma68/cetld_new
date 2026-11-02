import test from 'node:test';import assert from 'node:assert/strict';import{fixture}from'./fixtures/private-invoice.mjs';import{AIProvider}from'../ai/provider.mjs';import{createWhatsAppBoundMessageHandler}from'../automation/whatsapp/assistant-handler.mjs';
test('ordinary native month names restate a stored invoice date',async t=>{
 const wires=[],factory=options=>new AIProvider({...options,cfAccountId:'local-native-month',cfApiToken:'local-native-month',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'A safe ordinary answer'}}]});}}),f=await fixture({providerFactory:factory});
 try{
  await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,issue_date,due_date) values($1,$2,'R4-NATIVE-MONTH',43,'INR','draft','2026-10-20','2026-10-31')",[f.scope.workspaceId,f.scope.customerId]);
  const terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term);assert.ok(terms.includes('date:2026-10-31'));
  const customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});let n=0;
  for(const audience of['owner','customer'])for(const input of['is it due 31 अक्टूबर 2026?','is it due ३१ अक्टूबर २०२६?'])await t.test(audience+'/'+input,async()=>{
   const before=wires.length;await(audience==='owner'?f.turn(input):customer({...f.scope,message:input,messageId:'native-month-'+(++n)}));const row={wires:wires.slice(before)};assert.equal(row.wires.length,0,'Ordinary known-private date reached HTTP: '+JSON.stringify(row.wires.map(w=>w.body.messages)));
  });
 }finally{await f.close();}
});
