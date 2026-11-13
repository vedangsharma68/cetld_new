import test from 'node:test';import assert from 'node:assert/strict';import {createCanonicalPrivateValueIndex} from '../ai/private-payload-boundary.mjs';import {privatePartyKeys,privateFieldKeys} from '../ai/private-value-matcher.mjs';
test('R15 canonical final-payload admission does not require a recognized composition frame',()=>{
 const index=createCanonicalPrivateValueIndex(['number:1250','date:2026-10-31',...privatePartyKeys('Mark Harper')]);
 for(const prefix of ['','Opaque rendering: ','A future compositor emits ','Unfamiliar output follows; '])for(const suffix of ['',' in the supplied ordering',' with no recognized predicate'])for(const value of ['1250,77','old mark','30, 31 Oct 2026','Oct 30 - Nov 1, 2026','１２５０,７７'])for(const wrap of [v=>v,v=>JSON.stringify({detail:v}),v=>JSON.stringify({detail:JSON.stringify({value:v})})]){
  const content=wrap(prefix+value+suffix);assert.throws(()=>index.assertPayload({messages:[{role:'user',content}]}),{code:'PRIVATE_PAYLOAD_BLOCKED'},content);
 }
 assert.throws(()=>index.assertPayload({messages:[{role:'user',content:'October 30'},{role:'user',content:'31, 2026'}]}),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 assert.throws(()=>index.assertPayload({messages:[{role:'tool',content:JSON.stringify({date:{year:2026,month:'October',days:[30,31]}})}]}),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 assert.throws(()=>index.assertPayload({messages:[{role:'user',content:'gardening'}],extraContext:{detail:'1250,77'}}),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 assert.doesNotThrow(()=>index.assertPayload({messages:[{role:'user',content:'gardening'}],max_tokens:1250,stream:false}));
 assert.doesNotThrow(()=>index.assertPayload({messages:[{role:'tool',content:JSON.stringify({day:4,month:7,year:1250})}]}));
 for(const value of ['Opaque 2500,77','A red rose bloomed','October 30-31, 2027','The options cost 1250,77'])assert.doesNotThrow(()=>index.assertPayload({messages:[{role:'user',content:value}]}),value);
});

test('R15 decoded/reordered composite fields retain the canonical private-value identity',()=>{
 const value={beta:42,alpha:'confidential literal'},index=createCanonicalPrivateValueIndex(privateFieldKeys(JSON.stringify(value)));
 for(const content of [JSON.stringify(value),JSON.stringify({alpha:'confidential literal',beta:42}),JSON.stringify(JSON.stringify(value))])assert.throws(()=>index.assertPayload({messages:[{role:'user',content}]}),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 assert.doesNotThrow(()=>index.assertPayload({messages:[{role:'user',content:JSON.stringify({alpha:'different literal',beta:43})}]}));
});
