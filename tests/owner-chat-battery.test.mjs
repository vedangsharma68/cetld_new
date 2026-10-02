import test from 'node:test';
import assert from 'node:assert/strict';
import {OWNER_CHAT_LIVE_SCENARIO_NAMES,OWNER_CHAT_SCENARIO_NAMES,runBattery} from '../scripts/owner-chat-battery.mjs';

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
