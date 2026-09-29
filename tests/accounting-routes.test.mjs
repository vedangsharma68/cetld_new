import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAccountingRequest } from '../automation/accounting-routes.mjs';
const workspaceId = '00000000-0000-0000-0000-000000000001';
const userId = '00000000-0000-0000-0000-000000000002';
const env = { SUPABASE_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'secret', QUICKBOOKS_REDIRECT_URI: 'https://app.example/api/integrations/quickbooks/callback', ZOHO_BOOKS_REDIRECT_URI: 'https://app.example/api/integrations/zoho/callback' };
function response() { return { code: null, payload: null, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.code=code; return this; }, json(payload) { this.payload=payload; return this; }, send(payload) { this.payload=payload; return this; } }; }
test('OAuth initiation sets browser-bound HttpOnly cookie after workspace verification', async () => {
  const res=response(); let call=0; let passed;
  await handleAccountingRequest({ method:'POST', url:'/api/accounting', headers:{authorization:'Bearer verified'},body:{ action:'start', provider:'quickbooks', workspaceId } },res,{env,fetchImpl:async()=>({ok:true,json:async()=>++call===1?{id:userId}:[{id:workspaceId,owner_id:userId}]}),integration:{async startOAuth(input){passed=input;return{authorizationUrl:'https://appcenter.intuit.com/connect/oauth2',expiresAt:1};}}});
  assert.equal(res.code,200); assert.ok(passed.browserSession.length>=32); assert.equal(passed.userId,userId);
  assert.match(res.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!JSON.stringify(res.payload).includes(passed.browserSession));
});
test('OAuth callback without browser cookie never exchanges code', async () => {
  const res=response();let called=false;
  await handleAccountingRequest({ method:'GET',url:'/api/accounting?provider=quickbooks&code=code&state=state',headers:{} },res,{env,integration:{callback(){called=true;}}});
  assert.equal(res.code,401);assert.equal(called,false);
});
test('QuickBooks callback binds realm, performs initial sync, and returns an in-app page', async () => {
  const res=response();
  let synced=false;
  await handleAccountingRequest({method:'GET',url:'/api/integrations/quickbooks/callback?provider=quickbooks&code=code&state=state&realmId=123',headers:{cookie:'__Host-cetld-accounting-quickbooks=nonce'}},res,{env,integration:{async callback(input){assert.equal(input.browserSession,'nonce');assert.equal(input.realmId,'123');return{provider:'quickbooks',workspaceId,userId,providerAccountId:'123',status:'connected',accessToken:'do-not-return'};},async sync(){synced=true;return{syncStatus:'synced'};}}});
  assert.equal(res.code,200);assert.equal(synced,true);assert.match(res.payload,/QuickBooks connected/);assert.match(res.headers['Content-Type'],/text\/html/);assert.ok(!JSON.stringify(res.payload).includes('do-not-return'));
  assert.match(res.headers['Set-Cookie'],/Max-Age=0/);
});

test('QuickBooks callback configuration rejects query parameters', async () => {
  const res=response();const badEnv={...env,QUICKBOOKS_REDIRECT_URI:'https://app.example/api/integrations/quickbooks/callback?provider=quickbooks'};
  let call=0;
  await handleAccountingRequest({method:'POST',url:'/api/accounting',headers:{authorization:'Bearer verified'},body:{action:'start',provider:'quickbooks',workspaceId}},res,{env:badEnv,fetchImpl:async()=>({ok:true,json:async()=>++call===1?{id:userId}:[{id:workspaceId,owner_id:userId}]}),integration:{startOAuth(){throw new Error('must not run')}}});
  assert.equal(res.code,503);assert.match(res.payload.error,/without query parameters/);
});

test('Zoho callback returns a CSP-compatible success page rather than raw JSON', async () => {
  const res=response();
  let callbackInput;
  await handleAccountingRequest({method:'GET',url:'/api/integrations/zoho/callback?provider=zoho_books&code=code&state=state&location=in',headers:{cookie:'__Host-cetld-accounting-zoho_books=nonce'}},res,{env,integration:{async callback(input){callbackInput=input;return{provider:'zoho_books',workspaceId,userId,providerAccountId:'org-1',status:'connected',organizations:[{id:'org-1',name:'Acme'}]};},async sync(){return{syncStatus:'synced'};}}});
  assert.equal(res.code,200);assert.equal(res.headers['Content-Type'],'text/html; charset=utf-8');
  assert.equal(callbackInput.location,'in');
  assert.match(res.payload,/Zoho Books connected/);assert.match(res.payload,/src="\/oauth-callback\.js"/);assert.match(res.payload,/href="\/oauth-callback\.css"/);assert.doesNotMatch(res.payload,/<script>/);assert.doesNotMatch(res.payload,/<style>/);assert.doesNotMatch(res.payload,/"workspaceId"/);
  assert.match(res.payload,/\?page=Connections/);assert.match(res.payload,/data-payload=/);
});

test('Zoho callback failure returns a friendly cetld page', async () => {
  const res=response();
  await handleAccountingRequest({method:'GET',url:'/api/integrations/zoho/callback?provider=zoho_books&error=access_denied',headers:{cookie:'__Host-cetld-accounting-zoho_books=nonce'}},res,{env,integration:{async callback(){throw Object.assign(new Error('denied'),{code:'ACCOUNTING_OAUTH_DENIED'});}}});
  assert.equal(res.code,400);assert.match(res.payload,/Could not connect Zoho Books/);assert.match(res.payload,/Return to cetld/);assert.doesNotMatch(res.payload,/"error"/);
});
