import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Pins the unchanged independent test bodies, from setup() through the final
// assertion. Only imports and the filesystem evidence hook were adapted.
const pins=[
  [
    "adversarial-production",
    "695b86ac1516abac5b6719693373083a88e12a3c68ec64c8ed9b661ae8686b00"
  ],
  [
    "origin-boundaries",
    "1b77a144a31b2eebe89a5cf40270124bae6ad7de2e7e36469115c82cfbf6504b"
  ],
  [
    "party-and-magnitude",
    "698795361c9da0545b02bc6b38e602ad525fea3ebe8f157673f5e7c9a3f0fced"
  ]
];
for(const [name,sha256]of pins)test('independent reviewer test bodies remain byte-identical: '+name,async()=>{
 const source=await readFile(new URL('./reviewer-round5-'+name+'.test.mjs',import.meta.url),'utf8');
 assert.equal(createHash('sha256').update(source.slice(source.indexOf('async function setup'))).digest('hex'),sha256);
});
