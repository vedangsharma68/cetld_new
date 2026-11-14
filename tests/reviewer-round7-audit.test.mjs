import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
await mkdir('work',{recursive:true});
test('independent reviewer 102-case SQL/JS key audit',async()=>{await import('./reviewer-round7-key-parity.source.mjs');});
test('independent reviewer grammar/name/date positive and negative matrix',async()=>{
 await import('./reviewer-round7-class-probes.source.mjs');
 const evidence=JSON.parse(await readFile('work/r7-class-probes.json','utf8'));
 for(const row of evidence.turns)assert.equal(row.wires.length,row.expectedPrivate?0:1,row.audience+'/'+row.kind+'/'+row.input);
 for(const row of evidence.origins)assert.equal(row.sourceWires.length,0,row.audience+'/'+row.source);
 assert.deepEqual(evidence.parity.filter(row=>!row.equal),[]);
});
