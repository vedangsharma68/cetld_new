import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const records=JSON.parse(await readFile(new URL('./fixtures/reviewer-round8-pins.json',import.meta.url),'utf8'));
for(const entry of records)test('round9 preserves supplied round8 evidence: '+entry.source,async()=>{
 const bytes=await readFile(new URL('../'+entry.source,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
 const source=bytes.toString();
 if(entry.executable){const executable=await readFile(new URL('../'+entry.executable,import.meta.url),'utf8');assert.equal(executable,source.replace("'./r8-review-harness.mjs'","'./fixtures/reviewer-round8-harness.mjs'"));}
 else{const executable=await readFile(new URL('./fixtures/reviewer-round8-harness.mjs',import.meta.url),'utf8');assert.equal(executable,"import {mkdir} from 'node:fs/promises';\nawait mkdir('work',{recursive:true});\n"+source.replace("'../tests/fixtures/private-invoice.mjs'","'./private-invoice.mjs'").replace("'../ai/provider.mjs'","'../../ai/provider.mjs'").replace("'../automation/whatsapp/assistant-handler.mjs'","'../../automation/whatsapp/assistant-handler.mjs'"));}
});
