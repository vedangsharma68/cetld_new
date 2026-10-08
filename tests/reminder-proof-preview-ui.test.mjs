import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const previewSource=app.slice(app.indexOf('let reminderProofAuthSession=null;'),app.indexOf('async function reminderProofSend('));
const clickSource=app.slice(app.indexOf("document.addEventListener('click',async e=>"),app.indexOf("document.addEventListener('change',e=>"));
const accountingSource=app.split('\n').find(line=>line.startsWith("document.addEventListener('click',async event=>{const buttonEl=event.target.closest('button[data-action]');"));
const closeSource=app.split('\n').find(line=>line.startsWith("$('#dialog').addEventListener('close',"));
const preview={test:true,synthetic:true,recipient:'+919871367051',language:'en',templateName:'cetld_invoice_update_v2',text:'Clearly labelled offline test.'};
function deferred(){let resolve;return {promise:new Promise(r=>{resolve=r}),resolve:value=>resolve(value)}}
function fixture({token=async()=>'offline-token',fetchImpl=async()=>({ok:true,json:async()=>preview})}={}){
  const state={demo:false,user:{id:'owner'},workspace:{id:'workspace',owner_id:'owner'},invoices:[]},requests=[],listeners={},timers=new Map();
  const dialog={open:false,head:null,html:'',status:{textContent:''},error:{textContent:''},retry:{hidden:true,classList:{remove(){}}},body:{removeAttribute(){}},addEventListener(name,fn){listeners[name]=fn},close(){this.open=false;listeners.close?.()},querySelector(selector){return selector==='[data-error]'?this.error:null}};
  const control={disabled:false,dataset:{action:'reminder-proof-review'}};
  const sandbox={state,AbortController,URLSearchParams,Error,Promise,accessToken:token,fetch:async(url,options)=>{requests.push({url,options});return fetchImpl(url,options)},
    $:selector=>({'#dialog':dialog,'#dialog .dialog-head':dialog.head,'#dialog .dialog-body':dialog.body,'#dialog [data-reminder-preview-status]':dialog.status,'#dialog [data-action="reminder-proof-review"]':dialog.retry}[selector]),
    openDialog(_title,html){dialog.open=true;dialog.html=html;dialog.head={};dialog.error.textContent='';dialog.retry.hidden=true},
    showError(container,error){container.error.textContent=error.message},escape:s=>String(s),button:(action,label)=>`<button data-action="${action}">${label}</button>`,
    Date,document:{addEventListener(name,fn){if(name==='click')(listeners.click??=[]).push(fn)}},toast(message){throw Error('unexpected transient error: '+message)},dialogOpener:null,
    setTimeout(fn,ms){const id=timers.size+1;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},
  };
  const context=vm.createContext(sandbox);vm.runInContext(previewSource+clickSource+accountingSource+closeSource,context);
  return {state,requests,dialog,control,timers,capture:session=>vm.runInContext('captureReminderPreviewSession',context)(session),click:()=>Promise.all(listeners.click.map(fn=>fn({target:{closest:()=>control}}))),expire(){assert.equal([...timers.values()][0].ms,30000);[...timers.values()][0].fn()}};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('fresh same-owner auth snapshot avoids a second stalled session-lock acquisition',async()=>{
  let lookups=0;const f=fixture({token:()=>{lookups++;return new Promise(()=>{})}});
  f.capture({user:{id:'owner'},access_token:'current-owner-token',expires_at:Date.now()/1000+3600});await f.click();
  assert.equal(lookups,0);assert.equal(f.requests[0].options.headers.Authorization,'Bearer current-owner-token');assert.match(f.dialog.html,/reminder-proof-send/);
});
test('expired, foreign, cleared and missing-expiry snapshots use the bounded auth fallback',async()=>{
  for(const session of [null,{user:{id:'owner'},access_token:'expired',expires_at:0},{user:{id:'other'},access_token:'foreign',expires_at:Date.now()/1000+3600},{user:{id:'owner'},access_token:'missing-expiry'}]){
    let lookups=0;const f=fixture({token:async()=>{lookups++;return 'fresh-token'}});f.capture({user:{id:'owner'},access_token:'old-token',expires_at:Date.now()/1000+3600});f.capture(session);await f.click();assert.equal(lookups,1);assert.equal(f.requests[0].options.headers.Authorization,'Bearer fresh-token');
  }
});

test('actual delegated preview click shows progress before authentication and suppresses duplicate clicks',async()=>{
  const auth=deferred(),f=fixture({token:()=>auth.promise});const work=f.click();
  assert.equal(f.dialog.open,true);assert.match(f.dialog.html,/Preparing test preview/);assert.match(f.dialog.html,/No message has been sent/);assert.doesNotMatch(f.dialog.html,/reminder-proof-send/);assert.equal(f.control.disabled,true);
  await f.click();assert.equal(f.requests.length,0);auth.resolve('offline-token');await work;
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,'GET');assert.match(f.requests[0].url,/action=approved-template-test/);assert.match(f.dialog.html,/reminder-proof-send/);assert.equal(f.state.reminderProofPreview.workspaceId,'workspace');assert.equal(f.control.disabled,false);assert.equal(f.timers.size,0);
});
test('preview deadline includes a stalled session lookup and prevents a late GET after timeout',async()=>{
  const auth=deferred(),f=fixture({token:()=>auth.promise});const work=f.click();f.expire();await work;
  assert.match(f.dialog.error.textContent,/Preview timed out/);assert.equal(f.dialog.retry.hidden,false);assert.doesNotMatch(f.dialog.html,/reminder-proof-send/);assert.equal(f.state.reminderProofPreview,null);
  auth.resolve('late-token');await turn();assert.equal(f.requests.length,0);assert.equal(f.control.disabled,false);
});
test('preview deadline aborts a stalled GET and cannot promote a late response',async()=>{
  const response=deferred(),f=fixture({fetchImpl:()=>response.promise});const work=f.click();await turn();assert.equal(f.requests.length,1);
  f.expire();await work;assert.equal(f.requests[0].options.signal.aborted,true);assert.match(f.dialog.error.textContent,/Preview timed out/);
  response.resolve({ok:true,json:async()=>preview});await turn();assert.equal(f.state.reminderProofPreview,null);assert.doesNotMatch(f.dialog.html,/reminder-proof-send/);
});
test('preview deadline includes a stalled response body',async()=>{
  const body=deferred(),f=fixture({fetchImpl:async()=>({ok:true,json:()=>body.promise})});const work=f.click();await turn();f.expire();await work;
  assert.match(f.dialog.error.textContent,/Preview timed out/);body.resolve(preview);await turn();assert.equal(f.state.reminderProofPreview,null);
});
test('closing the loading dialog cancels preview and prevents a late authentication request',async()=>{
  const auth=deferred(),f=fixture({token:()=>auth.promise});const work=f.click();f.dialog.close();await work;auth.resolve('late-token');await turn();
  assert.equal(f.dialog.open,false);assert.equal(f.requests.length,0);assert.equal(f.state.reminderProofPreview,null);assert.equal(f.control.disabled,false);
});
test('late preview cannot replace another dialog or populate another workspace',async()=>{
  for(const change of [f=>{f.dialog.head={}},f=>{f.state.workspace={id:'other',owner_id:'owner'}},f=>{f.state.user={id:'other-owner'}}]){
    const response=deferred(),f=fixture({fetchImpl:()=>response.promise});const work=f.click();await turn();change(f);response.resolve({ok:true,json:async()=>preview});await work;assert.equal(f.state.reminderProofPreview,null);assert.doesNotMatch(f.dialog.html,/reminder-proof-send/);
  }
});
test('failed or malformed preview stays in the dialog without exposing a send action',async()=>{
  for(const result of [{ok:false,json:async()=>({error:'TEST_RECIPIENT_INELIGIBLE'})},{ok:true,json:async()=>({...preview,recipient:'+15555550101'})},{ok:true,json:async()=>{throw Error('Invalid response body')}}]){
    const f=fixture({fetchImpl:async()=>result});await f.click();assert.ok(f.dialog.error.textContent);assert.equal(f.dialog.retry.hidden,false);assert.equal(f.state.reminderProofPreview,null);assert.doesNotMatch(f.dialog.html,/reminder-proof-send/);assert.equal(f.requests.every(r=>r.options.method==='GET'),true);
  }
});
test('missing session and non-owner preview fail visibly without requesting the endpoint',async()=>{
  for(const setup of [f=>{f.state.user.id='member'},()=>{}]){
    const f=fixture({token:async()=>null});setup(f);await f.click();assert.ok(f.dialog.error.textContent);assert.equal(f.requests.length,0);assert.doesNotMatch(f.dialog.html,/reminder-proof-send/);
  }
});
