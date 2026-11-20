import test from 'node:test';import assert from 'node:assert/strict';import {redeemInvitation} from '../invite-entry.mjs';import {assertSignupServerReady} from '../signup-rollout.mjs';import {readFile} from 'node:fs/promises';
const current={version:2,accountInvites:true,tenantInvites:true,identityCredentialScrub:true,globalPrivacyIndex:true,dispatchProtocol:true};
function client(capability=current,session=null){const calls=[];return {calls,rpc:async(name,args)=>{calls.push({name,args});if(name==='signup_invite_status')return capability?{data:capability}:{error:{code:'PGRST202'}};return {data:{ok:true,schemaVersion:2,ticket:'opaque-one-use-ticket'}};},auth:{getSession:async()=>({data:{session}}),signUp:async request=>{calls.push({signUp:request});return {data:{session:null}};},signInWithOAuth:async request=>{calls.push({oauth:request});return {};}}};}
test('R7 production publication rejects pre-gate/v1/incomplete schemas, and accepts the enforced v2 contract',async()=>{
 for(const capability of [null,{version:1},{version:2,tenantInvites:false,identityCredentialScrub:true},{version:2,tenantInvites:true,identityCredentialScrub:false},current]){
  const action=assertSignupServerReady({url:'https://fixture.supabase.test',key:'publishable-test'},{fetchImpl:async()=>capability?Response.json(capability):new Response('',{status:404})});if(capability===current)assert.deepEqual(await action,current);else await assert.rejects(action,/migrations before publishing/);
 }
 const source=await readFile(new URL('../scripts/build-frontend.mjs',import.meta.url),'utf8');assert.match(source,/VERCEL_ENV==='production'\)await assertSignupServerReady/);
});
test('new signup fails closed on unsupported schemas, before any Auth create or OAuth request',async()=>{
 for(const capability of [null,{version:1}, {version:2,tenantInvites:true,identityCredentialScrub:false}])for(const provider of ['email','google']){const c=client(capability);await assert.rejects(redeemInvitation(c,{email:'a@example.test',code:'private-code',password:'new-password',provider}),/signup is being updated/);assert.ok(!c.calls.some(x=>x.signUp||x.oauth));}
});
test('a dedicated compatible entry works independently of either cached main UI, for password and Google',async()=>{
 for(const cachedUI of ['pre-invite','v1','v2'])for(const provider of ['email','google']){const c=client();const result=await redeemInvitation(c,{email:'a@example.test',code:'private-code',password:'new-password',provider,redirectTo:'https://app.example.test/app/'});const request=c.calls.find(x=>x.signUp||x.oauth);assert.ok(request,cachedUI);assert.ok(!JSON.stringify(request).includes('private-code'));if(provider==='email'){assert.equal(request.signUp.options.data.signup_invite_ticket,'opaque-one-use-ticket');assert.equal(result.checkEmail,true);}else assert.equal(request.oauth.provider,'google');assert.ok(c.calls.some(x=>x.name==='prepare_signup_invite'&&x.args.p_code==='private-code'));}
 const html=await readFile(new URL('../invite.html',import.meta.url),'utf8');assert.match(html,/invite-entry.mjs/);assert.ok(!html.includes('app.js'));assert.ok(!html.includes('<style>'));
});
test('existing signed-in accounts redeem a tenant grant without a new auth user or session replacement',async()=>{
 const c=client(current,{user:{email:'existing@example.test'}});assert.deepEqual(await redeemInvitation(c,{email:'forged@example.test',code:'bound-code'}),{tenantReady:true});assert.ok(c.calls.some(x=>x.name==='redeem_workspace_invite'));assert.ok(!c.calls.some(x=>x.signUp||x.oauth||x.name==='prepare_signup_invite'));
});
