import test from'node:test';import assert from'node:assert/strict';import{fixture}from'./fixtures/private-invoice.mjs';import{AIProvider}from'../ai/provider.mjs';import{normalizePrivateValue}from'../ai/private-value-matcher.mjs';
// The supplied external harness was not attached. These unchanged assertions
// use the actual SQL-backed owner handler and AIProvider fetch boundary instead.
for(const[stored,other]of[['किरण','करण'],['कमल','कोमल']])test('unrelated native-script name '+other+' must remain ordinary',async()=>{
 const wires=[],f=await fixture({providerFactory:o=>new AIProvider({...o,cfAccountId:'local-review',cfApiToken:'local-review',fetchImpl:async(u,i)=>{wires.push(JSON.parse(i.body));return Response.json({choices:[{message:{content:'A safe answer'}}]});}})});try{
 await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,[stored]]);assert.notEqual(normalizePrivateValue(stored),normalizePrivateValue(other));await f.turn('Ask '+other+' for advice');assert.equal(wires.length,1);
 }finally{await f.close();}
});
