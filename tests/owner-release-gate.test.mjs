import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runReleaseGate} from '../scripts/check-owner-chat-gate.mjs';

test('failed owner chat battery stops the release gate before any later build check',async()=>{
  const calls=[];
  await assert.rejects(runReleaseGate({live:true,run:async name=>{calls.push(name);throw Error('Broken owner conversation');}}),/Broken owner conversation/);
  assert.deepEqual(calls,['test:owner-chat']);
});
test('production releases never run the live battery, even when requested',async()=>{
  const previous=process.env.VERCEL_ENV;
  process.env.VERCEL_ENV='production';
  try {
    const calls=[];
    await runReleaseGate({live:true,run:async name=>calls.push(name)});
    assert.deepEqual(calls,['test:owner-chat','typecheck','test']);
  } finally {
    if(previous===undefined)delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV=previous;
  }
});
test('preview and local release gates run the fast battery, type check and complete test suite',async()=>{
  const calls=[];await runReleaseGate({run:async name=>calls.push(name)});
  assert.deepEqual(calls,['test:owner-chat','typecheck','test']);
});
test('Vercel and GitHub run the same mandatory release gate',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  const workflow=await readFile(new URL('../.github/workflows/owner-chat.yml',import.meta.url),'utf8');
  assert.equal(config.buildCommand,'npm run check:release');
  assert.equal(config.outputDirectory,'.','the static app lives at the repository root after the verification build');
  assert.equal(config.installCommand,'npm ci --include=dev');
  assert.match(workflow,/push:/);assert.match(workflow,/pull_request:/);assert.match(workflow,/npm run check:release/);
});
