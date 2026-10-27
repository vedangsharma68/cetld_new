import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {createHmac,createHash} from 'node:crypto';
import {waitUntil} from '@vercel/functions';
import {next} from '@vercel/functions/middleware';
import landingAuthRedirect from '../middleware.js';
import {LANDING_SESSION_COOKIE} from '../session-cookie.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';

const require=createRequire(import.meta.url),contextKey=Symbol.for('@vercel/request-context');
const root=new URL('../',import.meta.url);
const json=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const quiet={log(){},error(){}};
function isolate(t){
 const context=globalThis[contextKey],fetch=globalThis.fetch;let requests=0;
 delete globalThis[contextKey];
 globalThis.fetch=async()=>{requests++;throw Error('Unexpected external request');};
 t.after(()=>{if(context===undefined)delete globalThis[contextKey];else globalThis[contextKey]=context;globalThis.fetch=fetch;assert.equal(requests,0);});
}

test('installed artifact removes upstream OIDC and its entire vulnerable subtree',async()=>{
 const pkg=await json('package.json'),lock=await json('package-lock.json');
 assert.equal(pkg.dependencies['@vercel/functions'],'3.9.9');
 assert.equal(pkg.dependencies['@vercel/oidc'],'file:vendor/vercel-oidc-disabled');
 assert.deepEqual(pkg.overrides,{'@vercel/oidc':'$@vercel/oidc'});
 assert.deepEqual(lock.packages['node_modules/@vercel/oidc'],{resolved:'vendor/vercel-oidc-disabled',link:true});
 assert.equal((await json('node_modules/@vercel/oidc/package.json')).version,'0.0.0-cetld-disabled');
 const stub=await json('vendor/vercel-oidc-disabled/package.json');
 assert.equal(stub.private,true);assert.equal(stub.dependencies,undefined);assert.equal(stub.scripts,undefined);
 for(const [file,hash] of Object.entries({
  'index.js':'3f15b477f331868ca7dff124126ca9de0f44ae998a25eafdf1591077296e9a3d',
  'middleware.js':'445a1a1196e64341cd0969f599847ebfe9257cdf20624dfe78705297c6dd48e9',
  'wait-until.js':'dd593a912523ff6d7d3846bce6b5177eba5866a21149e25a4da8278992cebedd',
  'get-context.js':'4331b07d75d102e20b6faabae865fd9f52e53a56f59761224452f926b9c010e2',
 }))assert.equal(createHash('sha256').update(await readFile(new URL('node_modules/@vercel/functions/'+file,root))).digest('hex'),hash,'review dependency boundary when Vercel source changes');

 for(const name of ['@vercel/cli-config','@vercel/cli-exec','zod','jose']){
  assert(!Object.keys(lock.packages).some(p=>p.endsWith('/node_modules/'+name)||p==='node_modules/'+name));
  await assert.rejects(access(new URL('node_modules/'+name,root)));
 }
 assert(!Object.keys(require.cache).some(p=>/[/\\](?:oidc|cli-config|zod)[/\\]/.test(p)));
});

test('every application import keeps the two reviewed Vercel entry points and forbids OIDC',async()=>{
 const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0');
 const imports=[];
 for(const file of files.filter(p=>/\.[cm]?[jt]sx?$/.test(p)&&!p.startsWith('tests/')&&!p.startsWith('vendor/'))){
  const text=await readFile(new URL(file,root),'utf8');
  for(const item of text.matchAll(/['"](@vercel\/[^'"]+)['"]/g))imports.push([file,item[1]]);
 }
 assert.deepEqual(imports.sort(),[['api/whatsapp.js','@vercel/functions'],['middleware.js','@vercel/functions/middleware']]);
 const api=await readFile(new URL('api/whatsapp.js',root),'utf8');
 assert.match(api,/createWhatsAppWebhookHandler\(\{ waitUntil,/);
});

test('direct OIDC and the functions OIDC subpath fail loudly instead of simulating authentication',async t=>{
 isolate(t);
 assert.throws(()=>require('@vercel/oidc'),{code:'CETLD_VERCEL_OIDC_DISABLED'});
 assert.throws(()=>require('@vercel/functions/oidc'),{code:'CETLD_VERCEL_OIDC_DISABLED'});
 await assert.rejects(import('@vercel/oidc'),{code:'CETLD_VERCEL_OIDC_DISABLED'});
});

test('unchanged actual waitUntil delegates the original promise, validates inputs and retains absent-context behavior',async t=>{
 isolate(t);
 for(const value of [null,undefined,1,'task',{},()=>{}])assert.throws(()=>waitUntil(value),TypeError);
 const task=Promise.resolve('synthetic');assert.equal(waitUntil(task),undefined);
 let delegated;
 globalThis[contextKey]={get:()=>({waitUntil:p=>{delegated=p;return 'runtime-result';}})};
 assert.equal(waitUntil(task),'runtime-result');assert.equal(delegated,task);assert.equal(await delegated,'synthetic');
 globalThis[contextKey]={get:()=>({waitUntil:()=>{throw Error('synthetic runtime failure');}})};
 assert.throws(()=>waitUntil(task),/synthetic runtime failure/);
});

function signedInbound(){
 const env={WHATSAPP_APP_SECRET:'synthetic-only-secret',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_WABA_ID:'987654321'};
 const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:env.WHATSAPP_WABA_ID,changes:[{field:'messages',value:{
  metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},messages:[{id:'wamid.synthetic',from:'919871367051',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'hello'}}],
 }}]}]});
 const req=Readable.from([Buffer.from(body)]);req.method='POST';req.url='/api/whatsapp';
 req.headers={'x-hub-signature-256':'sha256='+createHmac('sha256',env.WHATSAPP_APP_SECRET).update(body).digest('hex')};
 return {env,req};
}
const response=()=>({statusCode:0,setHeader(){return this;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
test('signed webhook returns fast 200 while real package waitUntil retains unresolved inbox work, without cron fallback',async t=>{
 isolate(t);let release,processed=0,delegated;const pending=new Promise(resolve=>{release=resolve;});
 globalThis[contextKey]={get:()=>({waitUntil:p=>{delegated=p;}})};
 const {env,req}=signedInbound(),res=response();
 const runtime={enqueue:async rows=>rows,processPending:async()=>{processed++;await pending;return {completed:1};}};
 const handler=createWhatsAppWebhookHandler({env,runtime,waitUntil,logger:quiet});
 let timer;
 try{await Promise.race([handler(req,res),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Webhook blocked on inbox processing')),1000);})]);}
 finally{clearTimeout(timer);release();}
 assert.equal(res.statusCode,200);assert.deepEqual(res.body,{received:true});assert.equal(processed,1);assert(delegated instanceof Promise);await delegated;
});
test('continuation registration failure is visible as webhook 503, not a silent successful fallback',async t=>{
 isolate(t);globalThis[contextKey]={get:()=>({waitUntil:()=>{throw Error('synthetic unavailable runtime');}})};
 const {env,req}=signedInbound(),res=response();let durable=0;
 await createWhatsAppWebhookHandler({env,runtime:{enqueue:async rows=>{durable+=rows.length;return rows;},processPending:async()=>({completed:0})},waitUntil,logger:quiet})(req,res);
 assert.equal(durable,1);assert.equal(res.statusCode,503);
});
test('actual next and landing middleware preserve anonymous, invalid-auth, outage and verified redirect behavior',async t=>{
 isolate(t);
 const result=next({headers:{'x-synthetic':'kept'},request:{headers:new Headers({'x-input':'value'})}});
 assert.equal(result.headers.get('x-middleware-next'),'1');assert.equal(result.headers.get('x-synthetic'),'kept');
 assert.equal(result.headers.get('x-middleware-request-x-input'),'value');
 assert.throws(()=>next({request:{headers:{}}}),/Headers/);
 assert.equal((await landingAuthRedirect(new Request('https://synthetic.invalid/'))).headers.get('x-middleware-next'),'1');
 let calls=0;
 for(const status of [401,200,'outage']){
  globalThis.fetch=async(url,options)=>{calls++;assert.match(url,/\/auth\/v1\/user$/);assert.equal(options.headers.authorization,'Bearer synthetic-token');if(status==='outage')throw Error('synthetic outage');return new Response('{}',{status});};
  const r=await landingAuthRedirect(new Request('https://synthetic.invalid/?code=synthetic',{headers:{cookie:LANDING_SESSION_COOKIE+'=synthetic-token'}}));
  if(status===200){assert.equal(r.status,307);assert.equal(r.headers.get('location'),'https://synthetic.invalid/app/?code=synthetic');}
  else assert.equal(r.headers.get('x-middleware-next'),'1');
 }
 assert.equal(calls,3);
});
