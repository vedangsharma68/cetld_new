import test from 'node:test';
import assert from 'node:assert/strict';
import {runBattery,OWNER_CHAT_SCENARIO_NAMES} from '../scripts/owner-engine-unit-battery.mjs';
// Preserve every legacy planner/tool-state scenario as an explicit subsystem
// unit check. These do not count as production routing/privacy coverage.
for(const name of OWNER_CHAT_SCENARIO_NAMES)test('engine subsystem: '+name,async()=>{
  const result=await runBattery({scenarioNames:[name]});assert.equal(result.scenarioCount,1);
});
