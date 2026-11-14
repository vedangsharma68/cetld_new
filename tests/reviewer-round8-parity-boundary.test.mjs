import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {setup} from './fixtures/reviewer-round8-harness.mjs';import {privateOriginKeys} from '../ai/private-value-matcher.mjs';
const evidence=[];test.after(()=>writeFile('work/r8-parity-boundary.json',JSON.stringify(evidence,null,2)));
test('SQL number decomposition cannot depend on keeping the complete origin watermark',async t=>{
 const f=await setup();try{const stem='I billed Alder Finch 6847, and Brook Rowan 2749. Notes: ',source=(stem+'design work '.repeat(400)).slice(0,3996)+'x';assert.equal(source.length,3997);
for(const audience of ['owner','customer'])await t.test(audience,async()=>{await f.reset();const first=await f.turn(audience,source);await f.clear();const terms=await f.terms(),sql=(await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(r=>r.k),js=[...new Set(privateOriginKeys(source))].sort(),row={source,sourceLength:source.length,first,terms,sql,js,...await f.turn(audience,'send 6847 today')};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));});
 }finally{await f.close();}
});
