import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider,CF_PRIMARY_MODEL,CF_BACKUP_MODEL,CF_QWEN_MODEL,GEMINI_FALLBACK_MODEL} from '../ai/provider.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE,DEFAULT_NOW} from './fixtures/owner-chat-battery.mjs';

const logger={info(){},warn(){},error(){}};
const response=(status,body)=>Response.json(body,{status});
const cloudflare=content=>response(200,{choices:[{finish_reason:'stop',message:{content}}]});
const quota=()=>response(429,{errors:[{code:3036,message:'daily free allocation exceeded'}]});
const google=parts=>response(200,{candidates:[{content:{parts},finishReason:'STOP'}]});
const messages=[{role:'user',content:'Read current invoices.'}];

function healthStore(){
  const rows=new Map();
  const key=identity=>`${identity.provider}:${identity.model}`;
  return {async getUnavailableUntil(identity){return rows.get(key(identity))||null;},
    async markUnavailable(identity,{disabledUntil}){rows.set(key(identity),disabledUntil);return true;}};
}

test('a plain primary 429 immediately uses the existing selected fallback without retry delay',async()=>{
  const requested=[];let sleeps=0;
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:CF_BACKUP_MODEL,
    cfAccountId:'fixture-account',cfApiToken:'fixture-token',geminiApiKey:'',logger,
    maxAttempts:2,retryDelayMs:120,sleepImpl:async()=>{sleeps++;},fetchImpl:async(_url,init)=>{
      const model=JSON.parse(init.body).model;requested.push(model);
      return model===CF_PRIMARY_MODEL?response(429,{error:{message:'Too many requests'}}):cloudflare('Recovered through configured Scout.');
    }});
  const result=await provider.generate({messages});
  assert.equal(result.model,CF_BACKUP_MODEL);assert.equal(result.usedFallback,true);
  assert.deepEqual(requested,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);assert.equal(sleeps,0);
});

test('unconfigured candidates cannot mask quota exhaustion after one account-scoped Cloudflare 429',async()=>{
  const requested=[];let sleeps=0;
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL,
    cfAccountId:'fixture-account',cfApiToken:'fixture-token',geminiApiKey:'',healthStore:healthStore(),logger,
    maxAttempts:2,sleepImpl:async()=>{sleeps++;},fetchImpl:async(_url,init)=>{
      requested.push(JSON.parse(init.body).model);return quota();
    }});
  await assert.rejects(provider.generate({messages}),error=>{
    assert.equal(error.code,'RATE_LIMITED');assert.equal(error.status,429);
    assert.equal(error.rateLimitExhausted,true);assert.equal(error.quotaExhausted,true);
    assert.equal(error.providerReason,'quota_exceeded');assert.deepEqual(error.quotaProviders,['cloudflare']);return true;
  });
  assert.deepEqual(requested,[CF_PRIMARY_MODEL]);assert.equal(sleeps,0);
});

test('all available plain-429 legs retain rate-limit exhaustion without pretending to know daily quotas',async()=>{
  const requested=[];
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:CF_BACKUP_MODEL,
    cfAccountId:'fixture-account',cfApiToken:'fixture-token',geminiApiKey:'',logger,maxAttempts:2,
    sleepImpl:async()=>assert.fail('429 must not retry a leg'),fetchImpl:async(_url,init)=>{
      requested.push(JSON.parse(init.body).model);return response(429,{error:{message:'Too many requests'}});
    }});
  await assert.rejects(provider.generate({messages}),error=>{
    assert.equal(error.code,'RATE_LIMITED');assert.equal(error.rateLimitExhausted,true);
    assert.notEqual(error.quotaExhausted,true);assert.notEqual(error.providerReason,'quota_exceeded');return true;
  });
  assert.deepEqual(requested,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);
});

test('structured-output recovery retains quota exhaustion when other candidates have no credentials',async()=>{
  const requested=[];
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL,
    cfAccountId:'fixture-account',cfApiToken:'fixture-token',geminiApiKey:'',healthStore:healthStore(),logger,
    fetchImpl:async(_url,init)=>{
      const model=JSON.parse(init.body).model;requested.push(model);
      return model===CF_PRIMARY_MODEL?cloudflare('unusable structured output'):quota();
    }});
  await assert.rejects(provider.generateStructured({messages,name:'read_result',schema:{type:'object',properties:{value:{type:'string'}}},
    validate:value=>value}),error=>error.quotaExhausted===true&&error.rateLimitExhausted===true);
  assert.deepEqual(requested,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);
});

test('an explicitly disabled non-default-model fallback does not activate another provider',async()=>{
  const requested=[];
  const provider=new AIProvider({primaryModel:CF_QWEN_MODEL,fallbackModel:null,
    cfAccountId:'fixture-account',cfApiToken:'fixture-token',geminiApiKey:'unused-configured-key',logger,maxAttempts:2,
    fetchImpl:async(_url,init)=>{requested.push(JSON.parse(init.body).model);return quota();}});
  await assert.rejects(provider.generate({messages}),error=>error.rateLimitExhausted===true);
  assert.deepEqual(requested,[CF_QWEN_MODEL]);
});

function readHandler({allQuota=false,googleConfigured=true,plainRateLimit=false}={}){
  const db=createOwnerChatDatabase();const requests=[];let sleeps=0;
  const before=structuredClone(Object.fromEntries(['invoices','customers','payments','workspace_settings','workspace_ai_settings','whatsapp_pending_actions'].map(name=>[name,db.tables[name]])));
  const store=healthStore();
  const fetchImpl=async(url,init)=>{
    const body=JSON.parse(init.body);
    if(String(url).includes('cloudflare.com')){requests.push({provider:'cloudflare',model:body.model});return plainRateLimit
      ?response(429,{error:{message:'Too many requests'}}):quota();}
    assert.ok(googleConfigured,'an unconfigured Google leg cannot make an HTTP request');
    assert.match(String(url),/generativelanguage\.googleapis\.com/);
    requests.push({provider:'google',model:decodeURIComponent(String(url).match(/\/models\/([^:]+):/)?.[1]||'')});
    if(allQuota)return plainRateLimit?response(429,{error:{message:'Too many requests'}})
      :response(429,{error:{status:'RESOURCE_EXHAUSTED',message:'Daily request quota exceeded'}});
    const outputs=body.contents.flatMap(item=>item.parts||[]).filter(part=>part.functionResponse);
    if(!outputs.length)return google([{functionCall:{name:'workspaceData',args:{operation:'read',table:'invoices',
      columns:['invoice_number','currency','total_amount','amount_paid','status'],limit:10}}}]);
    const evidence=outputs.at(-1).functionResponse.response;
    assert.equal(evidence.ok,true);assert.equal(evidence.readOnly,true);
    assert.equal(evidence.rows.length,5);assert.ok(evidence.rows.every(row=>!row.invoice_number.includes('SECRET')));
    const total=evidence.rows.reduce((sum,row)=>sum+Number(row.total_amount)-Number(row.amount_paid),0);
    assert.equal(total,910);
    return google([{text:`Your total outstanding is USD ${total.toFixed(2)}.`}]);
  };
  const handler=createOwnerMessageHandler({supabase:db.supabase,replyStore:null,healthStore:store,logger,clock:()=>DEFAULT_NOW,
    env:{CLOUDFLARE_ACCOUNT_ID:'fixture-account',CLOUDFLARE_API_TOKEN:'fixture-token',GEMINI_API_KEY:googleConfigured?'fixture-google-key':''},
    providerFactory:options=>new AIProvider({...options,fetchImpl,logger,sleepImpl:async()=>{sleeps++;}})});
  return {db,handler,requests,before,sleeps:()=>sleeps};
}

function assertNoBusinessMutation(f){
  assert.deepEqual(Object.fromEntries(Object.keys(f.before).map(name=>[name,f.db.tables[name]])),f.before);
}

test('the real owner read handler answers from verified records through its configured fallback after primary quota',async()=>{
  const f=readHandler();
  const result=await f.handler({...OWNER_CHAT_SCOPE,messageId:'wamid.provider-fallback-read',message:'what is my total outstanding?'});
  assert.equal(result.answer,'Your total outstanding is USD 910.00.');
  assert.equal(result.plannerFailure,undefined);
  assert.equal(f.requests.filter(item=>item.provider==='cloudflare').length,1);
  assert.ok(f.requests.filter(item=>item.provider==='google').length>=2);
  assert.equal(f.sleeps(),0);assertNoBusinessMutation(f);
});

for(const {googleConfigured,plainRateLimit} of [{googleConfigured:true},{googleConfigured:false},{googleConfigured:true,plainRateLimit:true}])test(`all usable legs exhausted returns honest busy without data or writes (Google configured=${googleConfigured}, plain429=${Boolean(plainRateLimit)})`,async()=>{
  const f=readHandler({allQuota:true,googleConfigured,plainRateLimit});
  const result=await f.handler({...OWNER_CHAT_SCOPE,messageId:`wamid.provider-quota-${googleConfigured}`,message:'what is my total outstanding?'});
  assert.equal(result.answer,'I’m temporarily busy. Nothing was changed. Try again shortly.');
  assert.equal(result.plannerFailure?.code,'OWNER_AI_QUOTA_EXHAUSTED');
  assert.doesNotMatch(result.answer,/910|9999|INV-|USD|out of juice|reset/i);
  assert.equal(f.sleeps(),0);assertNoBusinessMutation(f);
});
