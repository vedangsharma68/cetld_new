import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runReleaseGate} from '../scripts/check-owner-chat-gate.mjs';

test('failed owner chat battery stops the release gate before any later build check',async()=>{
  const calls=[];
  await assert.rejects(runReleaseGate({live:true,run:async name=>{calls.push(name);throw Error('Broken owner conversation');}}),/Broken owner conversation/);
  assert.deepEqual(calls,['test:owner-chat']);
});
test('production releases require the live battery and fail closed if it fails',async()=>{
  const calls=[];
  await assert.rejects(runReleaseGate({live:true,run:async name=>{calls.push(name);if(name==='test:owner-chat:live')throw Error('Live model failed');}}),/Live model failed/);
  assert.deepEqual(calls,['test:owner-chat','typecheck','test','test:owner-chat:live']);
});
test('preview and local release gates run the cheap battery, type check and complete test suite',async()=>{
  const calls=[];await runReleaseGate({live:false,run:async name=>calls.push(name)});
  assert.deepEqual(calls,['test:owner-chat','typecheck','test']);
});
test('Vercel and GitHub run the same mandatory release gate',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  const workflow=await readFile(new URL('../.github/workflows/owner-chat.yml',import.meta.url),'utf8');
  assert.equal(config.buildCommand,'npm run check:release');
  assert.equal(config.installCommand,'npm ci --include=dev');
  assert.match(workflow,/push:/);assert.match(workflow,/pull_request:/);assert.match(workflow,/npm run check:release/);
});
