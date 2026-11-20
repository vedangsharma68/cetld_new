import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {INVITE_NOTICE,prepareGoogleSignup,signupError} from '../signup-invite.mjs';
import {issueSignupInvite} from '../scripts/issue-signup-invite.mjs';

test('Google signup prepares the email-bound invite before redirect; existing Google sign-in requires none',async()=>{
 const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function googleSignIn()'),source.indexOf('async function ensureAccount('));
 for(const mode of ['signup','login']){
  const calls=[],context={state:{authMode:mode},location:{origin:'https://app.example.test'},authRedirectUrl:origin=>origin+'/app/',prepareGoogleSignup,
   $:()=>({elements:{email:{value:' Invitee@Example.test '},inviteCode:{value:'secret-code'}}}),
   db:{rpc:async(name,args)=>{calls.push({name,args});return{data:{ok:true}};},auth:{signInWithOAuth:async request=>{calls.push(request);return{};}}}};
  await vm.runInNewContext(fn+'googleSignIn()',context);
  assert.equal(calls.length,mode==='signup'?2:1);
  assert.equal(calls.at(-1).provider,'google');
  if(mode==='signup'){assert.equal(calls[0].name,'prepare_signup_invite');assert.equal(calls[0].args.p_email,'Invitee@Example.test');}
 }
});
test('missing and rejected invite preparation never authorizes Google signup',async()=>{
 let calls=0;const client={rpc:async()=>{calls++;return{error:{message:'invalid'}};}};
 for(const fields of [{},{email:'a@example.test'},{email:'a@example.test',code:'wrong'}])await assert.rejects(prepareGoogleSignup(client,fields),{message:INVITE_NOTICE});
 assert.equal(calls,1);
 assert.equal(signupError({message:'Database error saving new user'}),INVITE_NOTICE);
});
test('operator issuance uses the service-only RPC and bounds expiry',async()=>{
 let args;const result=await issueSignupInvite({email:'a@example.test',client:{rpc:async(...a)=>{args=a;return{data:{code:'one-use'}};}}});
 assert.equal(result.code,'one-use');assert.equal(args[0],'issue_signup_invite');assert.equal(args[1].p_email,'a@example.test');
 await assert.rejects(issueSignupInvite({email:'a@example.test',hours:169}),/168/);
});
test('password signup sends its invite credential while existing password sign-in remains unchanged',async()=>{
 const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function submitAuth('),source.indexOf('async function googleSignIn('));
 for(const mode of ['signup','login']){
  const calls=[],button={innerHTML:'Submit'},form={querySelector:selector=>selector==='[type=submit]'?button:{classList:{add(){}}}};
  const context={state:{authMode:mode},location:{origin:'https://app.example.test'},authRedirectUrl:origin=>origin+'/app/',signupError,
   FormData:class{get(key){return {email:'a@example.test',password:'correct-horse-password',inviteCode:'email-bound-code'}[key];}},
   authPage(){},showError(_,error){throw error;},syncLandingSessionCookie(){},enterAccount:async user=>calls.push({user}),
   db:{auth:{signUp:async request=>{calls.push(request);return{data:{session:null}};},signInWithPassword:async request=>{calls.push(request);return{data:{session:{},user:{id:'existing'}}};}}}};
  await vm.runInNewContext(fn+'submitAuth(event)',{...context,event:{preventDefault(){},currentTarget:form}});
  if(mode==='signup')assert.equal(calls[0].options.data.signup_invite_code,'email-bound-code');
  else{assert.equal(calls[0].email,'a@example.test');assert.equal(calls[0].options,undefined);assert.equal(calls[1].user.id,'existing');}
 }
});
