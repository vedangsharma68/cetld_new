import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const pins=JSON.parse(await readFile(new URL('./fixtures/reviewer-round6-pins.json',import.meta.url),'utf8'));
for(const {file,anchor,sha256} of pins)test('round7 reviewer specification remains byte-identical: '+file,async()=>{
 const source=await readFile(new URL('../'+file,import.meta.url),'utf8');
 const offset=anchor?source.indexOf(anchor):0;assert.ok(offset>=0);
 assert.equal(createHash('sha256').update(source.slice(offset)).digest('hex'),sha256);
});
