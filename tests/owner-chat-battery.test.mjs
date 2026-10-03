import test from 'node:test';
import assert from 'node:assert/strict';
import {OWNER_CHAT_LIVE_SCENARIO_NAMES,OWNER_CHAT_SCENARIO_NAMES,runBattery,runLiveBattery} from '../scripts/owner-chat-battery.mjs';

for(const name of OWNER_CHAT_SCENARIO_NAMES) {
  test(name,async()=>{
    const result=await runBattery({mode:'fast',scenarioNames:[name]});
    assert.equal(result.mode,'fast');
    assert.equal(result.scenarioCount,1);
    assert.equal(result.scenarios[0].name,name);
  });
}

test('the fast battery remains larger than twenty named owner conversations',()=>{
  assert.ok(OWNER_CHAT_SCENARIO_NAMES.length>=20);
});

test('the real Cloudflare battery covers at least twenty named owner conversations',()=>{
  assert.ok(OWNER_CHAT_LIVE_SCENARIO_NAMES.length>=20);
});

test('a provider HTTP 429 skips the live battery and stops before more provider calls',async()=>{
  let secondScenarioStarted=false;
  const failures=[];
  const result=await runLiveBattery({
    env:{CLOUDFLARE_ACCOUNT_ID:'test-account',CLOUDFLARE_API_TOKEN:'test-token'},
    scenarios:[
      {name:'quota_limited_scenario',async run(ctx){
        ctx.observed.providerIssues.push({model:'test-model',status:429,reason:'quota_exceeded'});
        throw new Error('provider quota exceeded');
      }},
      {name:'must_not_run_after_quota',async run(){secondScenarioStarted=true;}},
    ],
    createConversation(){return {observed:{servedModels:[],providerIssues:[],operations:[],drafts:[],lastReply:null}};},
    onFailure:message=>failures.push(message),
  });
  assert.equal(result.mode,'live');
  assert.equal(result.skipped,true);
  assert.equal(result.skipReason,'provider_429');
  assert.equal(result.skippedScenario,'quota_limited_scenario');
  assert.equal(result.scenarioCount,0);
  assert.equal(secondScenarioStarted,false);
  assert.deepEqual(failures,[]);
});

test('a quota skip does not hide a prior live scenario regression',async()=>{
  const failures=[];
  let index=0;
  await assert.rejects(runLiveBattery({
    env:{CLOUDFLARE_ACCOUNT_ID:'test-account',CLOUDFLARE_API_TOKEN:'test-token'},
    scenarios:[
      {name:'scenario_regression',async run(){throw new Error('assertion failed');}},
      {name:'quota_limited_scenario',async run(ctx){
        ctx.observed.providerIssues.push({model:'test-model',status:429,reason:'quota_exceeded'});
        throw new Error('provider quota exceeded');
      }},
    ],
    createConversation(){
      index++;
      return {observed:{servedModels:[],providerIssues:[],operations:[],drafts:[],lastReply:null}};
    },
    onFailure:message=>failures.push(message),
  }),/1 of 2 live scenarios failed: scenario_regression: assertion failed/);
  assert.equal(index,2);
  assert.equal(failures.length,1);
  assert.match(failures[0],/scenario_regression: assertion failed/);
});

test('live battery still fails on a non-quota provider outage',async()=>{
  await assert.rejects(runLiveBattery({
    env:{CLOUDFLARE_ACCOUNT_ID:'test-account',CLOUDFLARE_API_TOKEN:'test-token'},
    scenarios:[{name:'provider_unavailable',async run(ctx){
      ctx.observed.providerIssues.push({model:'test-model',status:503,reason:'upstream_unavailable'});
      throw new Error('provider unavailable');
    }}],
    createConversation(){return {observed:{servedModels:[],providerIssues:[],operations:[],drafts:[],lastReply:null}};},
  }),/provider unavailable/);
});
