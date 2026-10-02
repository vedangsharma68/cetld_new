import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider,CF_PRIMARY_MODEL,cloudflareBreakerState} from '../ai/provider.mjs';

const ok=(body)=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(body)});
const make=fetchImpl=>new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:'gemini-3.5-flash',cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'g',fetchImpl,maxAttempts:1,retryDelayMs:0,logger:{warn(){},info(){},error(){}}});

test('Cloudflare serves the owner model call and returns tool calls',async()=>{
 const urls=[];
 const p=make(async url=>{urls.push(String(url));return ok({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'1',type:'function',function:{name:'find_invoices',arguments:'{"customer":"John"}'}}]}}]});});
 const r=await p.generate({messages:[{role:'user',content:'johns invoice'}],tools:[{type:'function',function:{name:'find_invoices',parameters:{type:'object',properties:{}}}}]});
 assert.match(urls[0],/api\.cloudflare\.com\/client\/v4\/accounts\/acc\/ai\/v1\/chat\/completions/);
 assert.equal(r.toolCalls[0].function.name,'find_invoices');
});

test('a Cloudflare failure falls through to Gemini within the same call',async()=>{
 const p=make(async url=>String(url).includes('cloudflare')?{ok:false,status:429,headers:{get:()=>null},text:async()=>'{"errors":[{"message":"daily neuron cap"}]}'}:ok({candidates:[{content:{parts:[{text:'from gemini'}]},finishReason:'STOP'}]}));
 const r=await p.generate({messages:[{role:'user',content:'hi'}]});
 assert.equal(r.content,'from gemini');
 assert.equal(typeof cloudflareBreakerState().failures,'number');
});
