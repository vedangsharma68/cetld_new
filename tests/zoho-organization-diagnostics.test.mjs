import test from 'node:test';
import assert from 'node:assert/strict';
import {TokenCipher,connectionAad,InMemoryAccountingStore,createAccountingIntegration,createZohoBooksProvider} from '../automation/accounting/index.mjs';
import {handleAccountingRequest} from '../automation/accounting-routes.mjs';

const context={userId:'40ff343c-4334-4aec-b49a-ca772f0cf8ad',workspaceId:'9a83b58d-6b02-4b17-8de5-c67136f26434',provider:'zoho_books'};
const secrets=['fixture-access-secret','fixture-refresh-secret','fixture-client-secret'];
async function setup(body,{httpStatus=200}={}){
  const store=new InMemoryAccountingStore(),cipher=new TokenCipher(Buffer.alloc(32,9));
  const token={accessToken:secrets[0],refreshToken:secrets[1],expiresAt:Date.now()+3600000,
    accountsDomain:'https://accounts.zoho.com',apiDomain:'https://www.zohoapis.com',region:'com'};
  await store.insertConnection({...context,...cipher.encrypt(token,connectionAad(context.provider,context.workspaceId)),
    tokenExpiresAt:token.expiresAt,status:'needs_attention',providerAccountId:null,region:'com',accountsDomain:token.accountsDomain,apiDomain:token.apiDomain});
  const calls=[];
  const adapter=createZohoBooksProvider({clientId:'fixture-client',clientSecret:secrets[2],fetchImpl:async(url,options)=>{
    calls.push({url:String(url),method:options.method||'GET'});
    return new Response(typeof body==='string'?body:JSON.stringify(body),{status:httpStatus,headers:{'Content-Type':'application/json'}});
  }});
  adapter.refreshToken=async()=>token;
  const integration=createAccountingIntegration({store,cipher,providers:{zoho_books:adapter,quickbooks:{}}});
  return {integration,store,calls,async status(){return integration.connectionStatus(context);}};
}

test('successful empty organizations are diagnosed without asking for reconnect or starting sync',async()=>{
  const f=await setup({code:0,message:'success',organizations:[]});const result=await f.status();
  assert.equal(result.status,'needs_attention');assert.equal(result.problem,'No Zoho Books organization is available.');
  assert.deepEqual(result.organizationDiscovery,{status:'empty',httpStatus:200,providerCode:'0',organizationCount:0,message:'Zoho returned no organizations.'});
  assert.equal(result.syncStatus,'never');assert.equal(result.lastSyncedAt,null);assert.deepEqual(result.organizations,[]);
  assert.equal(f.calls.length,1);assert.ok(f.calls.every(c=>c.method==='GET'&&c.url.endsWith('/books/v3/organizations')));
});

test('HTTP 200 provider error is distinct from successful empty discovery and exposes only safe diagnostics',async()=>{
  const f=await setup({code:57,message:`Permission denied; access_token=${secrets[0]} refresh_token=${secrets[1]} client_secret=${secrets[2]}`,access_token:secrets[0]});
  const result=await f.status();assert.equal(result.status,'needs_attention');
  assert.deepEqual(result.organizationDiscovery,{status:'error',httpStatus:200,providerCode:'57',organizationCount:null,message:'Zoho organization discovery failed (provider code 57).'});
  assert.equal(result.problem,result.organizationDiscovery.message);assert.equal(result.syncStatus,'never');
  const serialized=JSON.stringify({result,connection:await f.store.getConnection(context)});
  for(const secret of secrets)assert.ok(!serialized.includes(secret));
  assert.ok(!JSON.stringify(result).includes('Permission denied'));assert.equal(f.calls.length,1);
});

for(const body of [{code:secrets[0],message:secrets.join(' ')},{code:{access_token:secrets[0]},message:secrets.join(' ')},
  {code:0},{error:secrets[0]},'not JSON'])test(`malformed/error envelope never becomes empty success ${JSON.stringify(body).slice(0,45)}`,async()=>{
  const f=await setup(body),result=await f.status();assert.equal(result.organizationDiscovery.status,'error');
  assert.equal(result.organizationDiscovery.organizationCount,null);for(const secret of secrets)assert.ok(!JSON.stringify(result).includes(secret));
  assert.notEqual(result.problem,'No Zoho Books organization is available.');
});

test('non-200 discovery errors retain only safe provider code and HTTP status after bounded auth retry',async()=>{
  const f=await setup({code:14,message:secrets.join(' ')},{httpStatus:401}),result=await f.status();
  assert.equal(f.calls.length,2);assert.equal(result.organizationDiscovery.httpStatus,401);
  assert.equal(result.organizationDiscovery.providerCode,'14');assert.equal(result.organizationDiscovery.status,'error');
  for(const secret of secrets)assert.ok(!JSON.stringify(result).includes(secret));
});

test('available organizations retain normal selection/status without performing sync',async()=>{
  const f=await setup({code:0,message:'success',organizations:[{organization_id:'fixture-org',name:'Fixture Books'}]});
  const result=await f.status();assert.equal(result.status,'connected');assert.equal(result.organizationId,'fixture-org');
  assert.equal(result.organizationDiscovery.status,'available');assert.equal(result.organizationDiscovery.organizationCount,1);
  assert.equal(result.syncStatus,'never');assert.equal(f.calls.length,1);
});

const response=()=>({code:null,payload:null,setHeader(){},status(code){this.code=code;return this;},json(payload){this.payload=payload;return this;}});
test('authenticated status route returns diagnostics for the verified workspace without sync',async()=>{
  const f=await setup({code:57,message:secrets.join(' ')}),res=response();let syncs=0;
  const integration={...f.integration,async sync(){syncs++;throw Error('no sync allowed');}};
  await handleAccountingRequest({method:'POST',url:'/api/accounting',body:{workspaceId:context.workspaceId,provider:'zoho_books',action:'status'},headers:{authorization:'Bearer fixture-session'}},res,
    {integration,env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-public'},fetchImpl:async url=>{
      if(url.endsWith('/auth/v1/user'))return Response.json({id:context.userId});
      assert.ok(url.includes(`id=eq.${context.workspaceId}&owner_id=eq.${context.userId}`));return Response.json([{id:context.workspaceId,owner_id:context.userId}]);
    }});
  assert.equal(res.code,200);assert.equal(res.payload.organizationDiscovery.providerCode,'57');assert.equal(syncs,0);
});

for(const mode of ['signed-out','foreign-workspace'])test(`status diagnostics unavailable to ${mode} caller before integration/provider access`,async()=>{
  const res=response();let calls=0;
  await handleAccountingRequest({method:'POST',url:'/api/accounting',body:{workspaceId:context.workspaceId,provider:'zoho_books',action:'status'},headers:mode==='signed-out'?{}:{authorization:'Bearer fixture-session'}},res,
    {integration:{async connectionStatus(){calls++;}},env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-public'},fetchImpl:async url=>
      url.endsWith('/auth/v1/user')?Response.json({id:context.userId}):Response.json([])});
  assert.equal(res.code,mode==='signed-out'?401:403);assert.equal(calls,0);
});
