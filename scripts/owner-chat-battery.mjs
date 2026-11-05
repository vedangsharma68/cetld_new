#!/usr/bin/env node
// Production conversations only. Legacy adversarial engine checks remain in
// owner-engine-unit-battery.mjs and execute as explicit unit tests in npm test.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {PRIVATE_CHAT_REPLY,CHAT_UNAVAILABLE_REPLY} from '../ai/private-chat.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE,DEFAULT_NOW} from '../tests/fixtures/owner-chat-battery.mjs';
export {OWNER_CHAT_LIVE_SCENARIO_NAMES,runLiveBattery} from './owner-engine-unit-battery.mjs';
import {runLiveBattery} from './owner-engine-unit-battery.mjs';

const retained=['1250','anurag','2026-10-31','INV-2026-0142'];
function context({response='An ordinary answer',fail=false}={}){
  const db=createOwnerChatDatabase(),requests=[];
  db.tables.whatsapp_private_invoice_terms=retained.map((term,index)=>({workspace_id:OWNER_CHAT_SCOPE.workspaceId,term_hash:String(index),term}));
  db.tables.whatsapp_provider_memory=[];
  const factory=()=>({async generate(request){requests.push(JSON.parse(JSON.stringify(request.messages)));if(fail)throw Error('temporary outage');return {content:response};}});
  const owner=createOwnerMessageHandler({supabase:db.supabase,env:{},authorize:async()=>true,replyStore:null,clock:()=>DEFAULT_NOW,providerFactory:factory,logger:{info(){},warn(){},error(){}}});
  const customer=createWhatsAppBoundMessageHandler({supabase:db.supabase,env:{},audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});
  let i=0;
  const turn=async(message,audience='owner')=>audience==='owner'?(await owner({...OWNER_CHAT_SCOPE,message,messageId:'production-'+(++i)})).answer
    :customer({...OWNER_CHAT_SCOPE,message,messageId:'production-'+(++i)});
  return {db,requests,turn};
}
const scenario=(name,run)=>({name,run});
const PRIVATE=[
  'Explain 1250','send 1,250 today','send 1 250 today','send 1.250,00 today',"send 1'250 today",'send 1\u200b250 today',
  'The amounts are 1250, 77','The amounts are 1250, 2500','The pair is 1250 77',
  '31/10/26','31.10.26','10/31/26','31/10','31.10','10-31',
  'one thousand, two hundred and fifty','one thousand two hundred & fifty','1.25k','INV–2026–0142','INV 2026 0142','INV/2026/0142',
];
const ORDINARY=['Help me plan a walk','Can you suggest a lentil recipe','77, 2500','The pair is 77 2500','send 1,2500 today','send 12500 today',
  'top up 100','we are 100 people coming','2027-10-31','31 Oct 2025','is it due next Friday?'];
const FAST_SCENARIOS=[
  ...PRIVATE.map((message,index)=>scenario('production_private_variant_'+index,async()=>{
    const h=context();for(const audience of ['owner','customer']){assert.equal(await h.turn(message,audience),PRIVATE_CHAT_REPLY);assert.deepEqual(h.requests,[]);}
  })),
  ...ORDINARY.map((message,index)=>scenario('production_ordinary_control_'+index,async()=>{
    const h=context();for(const audience of ['owner','customer']){assert.equal(await h.turn(message,audience),'An ordinary answer');assert.equal(h.requests.at(-1).at(-1).content,message);}
  })),
  ...['Help me plan a walk','Can you suggest a lentil recipe','Write a packing checklist','Explain how rain forms'].map((ordinary,index)=>scenario('production_independent_mixed_clause_'+index,async()=>{
    const h=context();for(const audience of ['owner','customer']){assert.match(await h.turn(ordinary+'; 1250, 77',audience),/An ordinary answer/);assert.equal(h.requests.at(-1).at(-1).content,ordinary);}
  })),
  scenario('production_twenty_message_ordinary_memory_is_audience_isolated',async()=>{
    const h=context();for(const audience of ['owner','customer']){
      for(const subject of ['poetry','music','chess','gardening','hiking','cooking','painting','cycling','swimming','reading','singing'])await h.turn('I enjoy '+subject+' as '+(audience==='owner'?'host':'guest'),audience);
      await h.turn('What have I told you about myself?',audience);const messages=h.requests.at(-1);assert.equal(messages.length,22);
      assert.ok(messages.some(turn=>turn.content==='I enjoy music as '+(audience==='owner'?'host':'guest')));assert.ok(!messages.some(turn=>turn.content==='I enjoy poetry as '+(audience==='owner'?'host':'guest')));
      assert.ok(!messages.some(turn=>turn.content.includes(audience==='owner'?'as guest':'as host')));
    }
  }),
  scenario('production_invoice_balance_is_local_even_when_models_are_exhausted',async()=>{
    const h=context({fail:true});assert.match(await h.turn('What is my outstanding balance?'),/USD 910.00/);assert.deepEqual(h.requests,[]);
  }),
  scenario('production_customer_and_owner_menus_are_local_during_exhaustion',async()=>{
    const h=context({fail:true});assert.match(await h.turn('menu','customer'),/outstanding balance/);assert.doesNotMatch(await h.turn('menu'),/Chat is temporarily unavailable/);assert.deepEqual(h.requests,[]);
  }),
  scenario('production_customer_receipt_rejection_precedes_all_provider_access',async()=>{
    const h=context();const customer=createWhatsAppBoundMessageHandler({supabase:h.db.supabase,authorizeScope:async()=>true,providerFactory:()=>assert.fail('receipt cannot construct provider')});
    for(const mimeType of ['image/png','application/pdf'])assert.match(await customer({...OWNER_CHAT_SCOPE,message:'Paid 1250',media:{bytes:Buffer.from('local fixture'),mimeType}}),/owner to verify and record/);
  }),
  scenario('production_exhaustion_reply_is_honest_for_both_audiences',async()=>{
    const h=context({fail:true});for(const audience of ['owner','customer'])assert.equal(await h.turn('Help me plan a walk',audience),CHAT_UNAVAILABLE_REPLY);
  }),
  scenario('production_response_screening_keeps_private_output_out_of_memory',async()=>{
    const h=context({response:'The amounts are 1250, 77'});for(const audience of ['owner','customer'])assert.equal(await h.turn('Help me plan a walk',audience),PRIVATE_CHAT_REPLY);
    assert.deepEqual(h.db.tables.whatsapp_provider_memory,[]);
  }),
  scenario('production_cloudflare_exhaustion_cannot_fallback_to_gemini',async()=>{
    const hosts=[],h=context();const owner=createOwnerMessageHandler({supabase:h.db.supabase,env:{},authorize:async()=>true,replyStore:null,clock:()=>DEFAULT_NOW,
      logger:{info(){},warn(){},error(){}},providerFactory:options=>new AIProvider({...options,cfAccountId:'fixture',cfApiToken:'fixture',geminiApiKey:'legacy-disabled',maxAttempts:1,
        fetchImpl:async url=>{hosts.push(new URL(url).hostname);return Response.json({errors:[{code:3036,message:'quota exhausted'}]},{status:429});}})});
    assert.equal((await owner({...OWNER_CHAT_SCOPE,message:'Help me plan a walk',messageId:'outage'})).answer,CHAT_UNAVAILABLE_REPLY);
    assert.ok(hosts.length);assert.ok(hosts.every(host=>host==='api.cloudflare.com'));
  }),
];
export const OWNER_CHAT_SCENARIO_NAMES=Object.freeze(FAST_SCENARIOS.map(item=>item.name));
export async function runBattery({mode='fast',scenarioNames,onScenario,onFailure}={}){
  if(mode==='live')return runLiveBattery({scenarioNames,onScenario,onFailure});
  if(mode!=='fast')throw new TypeError('unknown owner-chat battery mode: '+mode);
  const selected=scenarioNames?FAST_SCENARIOS.filter(item=>scenarioNames.includes(item.name)):FAST_SCENARIOS;
  if(scenarioNames&&selected.length!==scenarioNames.length)throw Error('unknown production scenario');
  const outcomes=[];
  for(const item of selected){const started=Date.now();try{await item.run();}catch(error){error.message=item.name+': '+error.message;throw error;}
    const result={name:item.name,elapsedMs:Date.now()-started};outcomes.push(result);onScenario?.(result);}
  return {mode:'fast',scenarioCount:outcomes.length,scenarios:outcomes};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const mode=process.argv.includes('--live')?'live':'fast';const result=await runBattery({mode,onScenario:item=>process.stdout.write('PASS '+item.name+'\n')});
    process.stdout.write(`${mode} production owner-chat battery passed: ${result.scenarioCount} scenario(s).\n`);
  }catch(error){process.stderr.write('FAIL '+error.message+'\n');process.exitCode=1;}
}
