import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleAccountingRequest} from '../automation/accounting-routes.mjs';

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const workspaceId='00000000-0000-0000-0000-000000000001';
const userId='00000000-0000-0000-0000-000000000002';
const env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-public',
  ZOHO_BOOKS_REDIRECT_URI:'https://fixture.invalid/api/integrations/zoho/callback'};
function response(){return {code:null,payload:null,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(payload){this.payload=payload;return this;}};}
async function request(action,keepExistingInvoices){
  const calls=[],res=response();let authCalls=0;
  await handleAccountingRequest({method:'POST',url:'/api/accounting',headers:{authorization:'Bearer fixture'},
    body:{provider:'zoho_books',workspaceId,action,organizationId:'new-org',keepExistingInvoices}},res,{
    env,fetchImpl:async()=>({ok:true,json:async()=>++authCalls===1?{id:userId}:[{id:workspaceId,owner_id:userId}]}),
    integration:{async startOAuth(input){calls.push(['start',input]);return {authorizationUrl:'https://fixture.invalid/authorize',expiresAt:1};},
      async selectOrganization(input){calls.push(['select',input]);return {status:'connected'};},
      async sync(){calls.push(['sync']);return {syncStatus:'synced'};}}});
  return {res,calls};
}
for(const action of ['start','select-organization']){
  test(`Zoho ${action} rejects missing or non-boolean acknowledgement before changing connection or syncing`,async()=>{
    for(const value of [undefined,false,'true',1]){
      const {res,calls}=await request(action,value);
      assert.equal(res.code,409);assert.match(res.payload.error,/previous organization/);
      assert.match(res.payload.error,/Nothing is automatically archived or deleted/);
      assert.deepEqual(calls,[]);assert.equal(res.headers['Set-Cookie'],undefined);
    }
  });
  test(`Zoho ${action} proceeds after explicit owner acknowledgement`,async()=>{
    const {res,calls}=await request(action,true);
    assert.equal(res.code,200);assert.equal(calls[0][0],action==='start'?'start':'select');
    assert.equal(calls[0][1].workspaceId,workspaceId);assert.equal(calls[0][1].userId,userId);
    assert.equal(calls.filter(([name])=>name==='sync').length,action==='start'?0:1);
  });
}

function between(start,end){const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);return app.slice(a,b);}
function confirmRetention(confirm){return new Function('window',`return (${between('function confirmZohoLedgerRetention()', 'async function refreshZohoLedger(').trim()})();`)({confirm});}
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
for(const [action,end] of [['select-zoho-organization','connect-zoho'],['connect-zoho','connect-quickbooks']]){
  test(`cancelling ${action} makes no requests and leaves the current ledger and connection intact`,async()=>{
    const state={user:{id:userId},workspace:{id:workspaceId},accountingStatus:{status:'connected',organizationId:'old-org'},invoices:[{id:'old-invoice'}]};
    const before=structuredClone(state);let asked=0;
    const run=new AsyncFunction('action','state','$','confirmZohoLedgerRetention',
      between(`if(action==='${action}')`,`if(action==='${end}')`));
    await run(action,state,()=>({value:'new-org'}),()=>confirmRetention(message=>{
      asked++;assert.match(message,/previous organization/);assert.match(message,/not be automatically archived or deleted/);return false;
    }));
    assert.equal(asked,1);assert.deepEqual(state,before);
  });
}
test('both UI mutation requests acknowledge retention only after confirmation',()=>{
  const selection=between("if(action==='select-zoho-organization')","if(action==='connect-zoho')");
  const connect=between("if(action==='connect-zoho')","if(action==='connect-quickbooks')");
  assert.match(selection,/if\(!confirmZohoLedgerRetention\(\)\)return;const syncResult=await accountingRequest\('select-organization',\{organizationId,keepExistingInvoices:true\}\)/);
  assert.match(connect,/if\(!confirmZohoLedgerRetention\(\)\)return;const popup=window.open/);
  assert.match(connect,/body:JSON.stringify\(\{workspaceId:state.workspace.id,keepExistingInvoices:true\}\)/);
  const connections=between('function connections()','function settings(');
  assert.match(connections,/zoho-ledger-retention-note/);
  assert.match(connections,/Invoices from the previous organization are not automatically archived or deleted/);
});
