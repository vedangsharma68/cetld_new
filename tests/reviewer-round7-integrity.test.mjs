import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const pins=JSON.parse(await readFile(new URL('./fixtures/reviewer-round7-pins.json',import.meta.url),'utf8'));
for(const {file,sha256} of pins)test('round8 independent reviewer source remains byte-identical: '+file,async()=>{
 const bytes=await readFile(new URL('../'+file,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256);
});

// The two fixture corrections are deliberately visible in the executable files.
// Compare the whole file to the raw source plus only these bounded changes.
const {correctReviewerFixture}=await import('./fixtures/reviewer-round7-fixture-corrections.mjs');
for(const name of ['independent-regressions','native-concurrency'])test('reviewer assertions preserved through fixture-only correction: '+name,async()=>{
 const original=await readFile(new URL('./reviewer-round7-'+name+'.source.mjs',import.meta.url),'utf8');
 const executable=await readFile(new URL('./reviewer-round7-'+name+'.test.mjs',import.meta.url),'utf8');
 assert.equal(executable,correctReviewerFixture(name,original));
});
