import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
test('native independent maintenance interleaving rebuilds the alias after racing completion',async()=>{
 await mkdir('work',{recursive:true});
 const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./reviewer-round6-native-cache-audit.mjs',import.meta.url))]);
 const evidence=JSON.parse(stdout.trim().split('\n').at(-1));
 assert.deepEqual(evidence.unicode.mismatches,[]);
 assert.ok(evidence.unicode.individualContextualCases>=19479);
 assert.equal(evidence.sequentialDeleteRebuild,'PASS');
 assert.equal(evidence.rollbackRetry,'PASS');
 assert.deepEqual(evidence.privilegedDeleteRace,{aliasExists:true,completionExists:true});
});
