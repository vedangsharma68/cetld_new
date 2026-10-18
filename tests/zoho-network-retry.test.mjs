import test from 'node:test';
import assert from 'node:assert/strict';
import {providerFetch} from '../automation/accounting/http.mjs';

test('Zoho read recovers after transient network failures with exponential backoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const result=providerFetch(async()=>{if(++calls<3)throw Error('offline');return {ok:true};},'zoho_books','https://example.test');
  await Promise.resolve();
  assert.equal(calls,1);
  t.mock.timers.tick(249);await Promise.resolve();assert.equal(calls,1);
  t.mock.timers.tick(1);await Promise.resolve();await Promise.resolve();assert.equal(calls,2);
  t.mock.timers.tick(499);await Promise.resolve();assert.equal(calls,2);
  t.mock.timers.tick(1);await result;assert.equal(calls,3);
});
test('Zoho read retries are bounded and errors do not expose transport details',async()=>{
  let calls=0;
  await assert.rejects(providerFetch(async()=>{calls++;throw Error('private transport detail');},'zoho_books','https://example.test'),error=>error.providerCode==='network_error'&&!error.message.includes('private'));
  assert.equal(calls,3);
});
test('writes, OAuth exchanges, other providers and HTTP errors are not retried',async()=>{
  for(const [provider,options] of [['zoho_books',{method:'POST'}],['zoho_books',{method:'PUT'}],['quickbooks',{}]]){
    let calls=0;
    await assert.rejects(providerFetch(async()=>{calls++;throw Error('offline');},provider,'https://example.test',options));
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(providerFetch(async()=>{calls++;return new Response('{}',{status:401});},'zoho_books','https://example.test'));
  assert.equal(calls,1);
});
