import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAccountingRequest } from '../automation/accounting-routes.mjs';
const workspaceId = '00000000-0000-0000-0000-000000000001';
const userId = '00000000-0000-0000-0000-000000000002';
const env = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'secret', QUICKBOOKS_REDIRECT_URI: 'https://app.example/api/accounting?provider=quickbooks' };
function response() { return { code: null, payload: null, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.code=code; return this; }, json(payload) { this.payload=payload; return this; } }; }
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
test('OAuth callback binds realm and browser session without reflecting tokens', async () => {
  const res=response();
  await handleAccountingRequest({method:'GET',url:'/api/accounting?provider=quickbooks&code=code&state=state&realmId=123',headers:{cookie:'__Host-cetld-accounting-quickbooks=nonce'}},res,{env,integration:{async callback(input){assert.equal(input.browserSession,'nonce');assert.equal(input.realmId,'123');return{provider:'quickbooks',workspaceId,accessToken:'do-not-return'};}}});
  assert.equal(res.code,200);assert.ok(!JSON.stringify(res.payload).includes('do-not-return'));
  assert.match(res.headers['Set-Cookie'],/Max-Age=0/);
});
