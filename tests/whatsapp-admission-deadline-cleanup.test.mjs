import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';
const phone='+12025550991',valid={data:{terms:[],identifiers:[],values:[],files:[]}};
async function trackTimers(run){
 const set=globalThis.setTimeout,clear=globalThis.clearTimeout,active=new Set();
 globalThis.setTimeout=(fn,ms,...args)=>{const id=set(()=>{active.delete(id);fn(...args)},ms);active.add(id);return id;};
 globalThis.clearTimeout=id=>{active.delete(id);return clear(id);};
 try{await run(active);}finally{globalThis.setTimeout=set;globalThis.clearTimeout=clear;for(const id of active)clear(id);}
}
const prepare=rpc=>prepareWhatsAppDispatch({supabase:{rpc},phone,snapshotDeadlineMs:20});
const unavailable=error=>error.code==='PRIVATE_PAYLOAD_BLOCKED'&&error.privacyCategory==='snapshot_unavailable'&&error.retryable===true&&!error.message.includes('SECRET');
test('settled snapshot success clears its losing deadline timer',()=>trackTimers(async active=>{assert.equal(typeof await prepare(async()=>valid),'function');assert.equal(active.size,0);}));
test('settled snapshot RPC rejection clears its deadline and remains fail closed',()=>trackTimers(async active=>{await assert.rejects(prepare(async()=>{throw Error('SECRET RPC failure')}),unavailable);assert.equal(active.size,0);}));
test('synchronous RPC failure has no timer and remains retryable unavailable',()=>trackTimers(async active=>{await assert.rejects(prepare(()=>{throw Error('SECRET sync failure')}),unavailable);assert.equal(active.size,0);}));
for(const settlement of ['resolve','reject'])test('expiry stays terminal for that admission despite late snapshot '+settlement,()=>trackTimers(async active=>{
 let resolve,reject,admission,sends=0;
 const snapshot=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const unhandled=[],onUnhandled=e=>unhandled.push(e);process.on('unhandledRejection',onUnhandled);
 try{
  await assert.rejects(async()=>{admission=await prepare(()=>snapshot);sends++;},unavailable);
  assert.equal(admission,undefined);assert.equal(sends,0);assert.equal(active.size,0);
  if(settlement==='resolve')resolve(valid);else reject(Error('SECRET late failure'));
  await new Promise(done=>setImmediate(done));await new Promise(done=>setImmediate(done));
  assert.equal(admission,undefined);assert.equal(sends,0);assert.equal(active.size,0);assert.deepEqual(unhandled,[]);
 }finally{process.removeListener('unhandledRejection',onUnhandled);}
}));
