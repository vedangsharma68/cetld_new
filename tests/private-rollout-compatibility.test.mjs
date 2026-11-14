import test from 'node:test';import{createHash}from'node:crypto';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{createServer}from'node:http';import{fixture}from'./fixtures/private-invoice.mjs';import{AIProvider}from'../ai/provider.mjs';import{runPrivateInvoiceBackfill}from'../scripts/backfill-private-invoice-terms.mjs';
const name='20261101120327_private_whatsapp_chat_memory.sql';
test('legacy main handler is schema compatible but ignores readiness; external ingress fence and drain are required',async()=>{
 const wire=[],factory=o=>new AIProvider({...o,cfAccountId:'local-legacy',cfApiToken:'local-legacy',maxAttempts:1,fetchImpl:async(u,i)=>{wire.push(JSON.parse(i.body));return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}}),f=await fixture({providerFactory:factory,sqlNetworkOptions:{excludeMigrations:[name]}});
 let server;try{
 const source=await readFile(new URL('./fixtures/legacy-main-owner-handler.source',import.meta.url),'utf8');assert.equal(createHash('sha256').update(source).digest('hex'),'159420a0601731847426ec36e104e2ea569ac755a0866de2b076bf579718276c');const origin=new URL('../automation/whatsapp/owner-handler.mjs',import.meta.url);const linked=source.replace(/(from\s+|import\s*)['"](\.[^'"]+)['"]/g,(all,lead,path)=>lead+JSON.stringify(new URL(path,origin).href));const legacy=await import('data:text/javascript;base64,'+Buffer.from(linked).toString('base64'));
 await f.db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 const handler=legacy.createOwnerMessageHandler({supabase:f.supabase,authorize:async()=>true,replyStore:null,providerFactory:factory,logger:{info(){},warn(){},error(){}}});
 await handler({...f.scope,message:'Tell me a joke',messageId:'legacy-before-ready'});assert.ok(wire.length>0,'Baseline main ignores new readiness; migration alone is not a fence');const n=wire.length;
 let invocations=0,fenced=true;server=createServer(async(req,res)=>{if(fenced){res.writeHead(503);res.end('Maintenance; retry');return;}invocations++;const result=await handler({...f.scope,message:'Tell me a joke',messageId:'legacy-open-control'});res.writeHead(200);res.end(JSON.stringify(result));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/whatsapp',{method:'POST',body:'retry me'});assert.equal(response.status,503);assert.equal(invocations,0);assert.equal(wire.length,n);
 assert.match((await f.turn('Tell me a joke')).answer,/temporarily unavailable/);assert.equal(wire.length,n);
 await runPrivateInvoiceBackfill({execute:async sql=>{const r=await f.db.exec(sql);return r.find(r=>r.rows?.[0]?.result)?.rows[0].result;}});
 await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'LEGACY-WRITE',137,'INR','draft')",[f.scope.workspaceId,f.scope.customerId]);
 fenced=false;assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/whatsapp',{method:'POST'})).status,200);assert.equal(invocations,1);assert.ok(wire.length>n,'Unchanged legacy query contract survives additive schema');
 }finally{await new Promise(r=>server?server.close(r):r());await f.close();}
});
