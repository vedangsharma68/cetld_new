import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createInvoiceLifecycleClient} from '../invoice/lifecycle-client.mjs';

const proposal={ok:true,pending:true,proposalId:'proposal-1',invoiceId:'invoice-1',invoiceNumber:'INV-42',customerName:'Customer A',totalAmount:'125.50',currency:'INR',status:'sent',expiresAt:'2026-10-24T00:00:00Z',requiresExactConfirmation:true};
const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function invoiceDeleteStatus('),app.indexOf("document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button)return;const action=button.dataset.action;if(action==='delete-invoice')"));
function harness(responses,options={}){
 const calls=[],dialogs=[];let sequence=0;
 const client=createInvoiceLifecycleClient({accessToken:async()=>'token',origin:'http://localhost',...options,fetchImpl:async(_,init)=>{
  calls.push(JSON.parse(init.body));const result=responses.shift();if(result instanceof Error)throw result;
  if(typeof result==='function')return result();
  return new Response(JSON.stringify(result),{status:result.ok?200:409});
 }});
 const state={invoices:[{id:'invoice-1'}],workspace:{id:'workspace-1',owner_id:'owner-1'},user:{id:'owner-1'},ownerDeleteAvailable:true};
 const context=vm.createContext({state,invoiceLifecycleClient:client,crypto:{randomUUID:()=>`request-${++sequence}`},toMinor:x=>Math.round(Number(x)*100),escape:String,money:(x,c)=>`${c} ${x/100}`,button:(action,label)=>`<button data-action="${action}">${label}</button>`,openDialog:(title,html)=>dialogs.push({title,html}),$:()=>({addEventListener(){},querySelector(){return null},close(){}}),toast(){assert.fail('failure should be visible in dialog')}});
 vm.runInContext(source+"openInvoiceDelete('invoice-1')",context);
 return {calls,dialogs,state,context};
}
async function settled(h){for(let i=0;i<30&&h.dialogs.length<2;i++)await new Promise(r=>setTimeout(r,2));assert.equal(h.dialogs.length,2);return h.dialogs.at(-1);}

test('409 ACTION_PENDING precheck loads the existing proposal into the real dashboard confirm form',async()=>{
 const h=harness([{ok:false,code:'ACTION_PENDING'},proposal]);const dialog=await settled(h);
 assert.equal(h.calls.map(x=>x.action).join(','),'prepareDelete,pendingDelete');
 assert.equal(dialog.title,'Delete invoice?');assert.match(dialog.html,/id="invoice-delete-form"/);assert.match(dialog.html,/data-proposal-id="proposal-1"/);
 for(const text of ['INV-42','Customer A','125.5','Sent','DELETE INV-42','name="confirmation"'])assert.ok(dialog.html.includes(text));
 assert.equal(h.state.pendingInvoiceDeletion.expiresAt,proposal.expiresAt);
});
for(const expired of [{ok:true,pending:false},{ok:false,code:'ACTION_EXPIRED'}])test(`expired pending proposal transparently prepares fresh: ${JSON.stringify(expired)}`,async()=>{
 const h=harness([{ok:false,code:'ACTION_PENDING'},expired,{...proposal,proposalId:'fresh'}]);assert.match((await settled(h)).html,/data-proposal-id="fresh"/);
 assert.equal(h.calls.map(x=>x.action).join(','),'prepareDelete,pendingDelete,prepareDelete');assert.equal(h.calls[0].idempotencyKey,h.calls[2].idempotencyKey);
});
test('normal preparation preserves the existing exact confirmation form',async()=>{
 const h=harness([proposal]);assert.match((await settled(h)).html,/Type <strong>DELETE INV-42/);assert.equal(h.calls.length,1);
});
for(const [name,responses,options] of [
 ['pending lookup failure',[{ok:false,code:'ACTION_PENDING'},{ok:false,code:'DATABASE_UNAVAILABLE'}]],
 ['network failure',[new Error('Connection lost. Close and try again.')]],
 ['missing proposal',[{ok:true}]],
 ['malformed pending lookup',[{ok:false,code:'ACTION_PENDING'},{ok:true}]],
 ['different invoice',[{ok:false,code:'ACTION_PENDING'},{...proposal,invoiceId:'other'}]],
 ['repeated expiration',[{ok:false,code:'ACTION_PENDING'},{ok:true,pending:false},{ok:false,code:'ACTION_PENDING'},{ok:true,pending:false}]],
 ['timeout',[()=>new Promise(()=>{})],{precheckTimeoutMs:5}],
])test(`${name} leaves a visible, dismissible error and allows another attempt`,async()=>{
 const h=harness(responses,options);const dialog=await settled(h);assert.equal(dialog.title,'Could not check invoice details');assert.match(dialog.html,/role="alert">[^<]+/);assert.match(dialog.html,/data-action="close"/);assert.equal(h.state.pendingInvoiceDeletion,null);
 responses.push(proposal);vm.runInContext("openInvoiceDelete('invoice-1')",h.context);
 for(let i=0;i<30&&h.dialogs.length<4;i++)await new Promise(r=>setTimeout(r,2));
 assert.match(h.dialogs.at(-1).html,/id="invoice-delete-form"/);
});

test('cancel during pending lookup restores a usable review if cancellation fails',async()=>{
 let release;
 const h=harness([()=>new Promise(resolve=>{release=resolve}),{...proposal,pending:true},{ok:false,code:'DATABASE_UNAVAILABLE'}]);
 for(let i=0;i<30&&!release;i++)await new Promise(r=>setTimeout(r,2));
 await vm.runInContext('cancelPendingInvoiceDeletion()',h.context);
 assert.equal(h.dialogs.at(-1).title,'Cancelling deletion request');
 release(new Response(JSON.stringify({ok:false,code:'ACTION_PENDING'}),{status:409}));
 for(let i=0;i<30&&h.dialogs.length<3;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(h.dialogs.at(-1).title,'Delete invoice?');assert.match(h.dialogs.at(-1).html,/temporarily unavailable/);assert.match(h.dialogs.at(-1).html,/name="confirmation"/);
 assert.equal(h.state.pendingInvoiceDeletion.cancelRequested,false);
 assert.equal(h.calls.map(x=>x.action).join(','),'prepareDelete,pendingDelete,cancelDelete');
});
