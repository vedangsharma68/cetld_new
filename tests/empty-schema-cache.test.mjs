import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cachedEmptySchema,emptySchemaKey} from './fixtures/empty-schema-cache.mjs';

const key=emptySchemaKey(['schema','fixture','lock']);
async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'cetld-empty-cache-'));
 let creates=0,restores=0;
 const options={directory,key,create:async()=>{creates++;return {data:[],dumpDataDir:async()=>new Blob(['empty'])};},
  restore:async blob=>{restores++;assert.equal(await blob.text(),'empty');return {data:[]};}};
 try{await run(options,()=>({creates,restores}));}finally{await rm(directory,{recursive:true,force:true});}
}
test('cache keys invalidate schema, fixture, dependency lock, tools and runtime dimensions',()=>{
 for(const inputs of [['changed','fixture','lock'],['schema','changed','lock'],['schema','fixture','changed']])assert.notEqual(emptySchemaKey(inputs),key);
 for(const dimension of ['node','versions','platform','arch'])assert.notEqual(emptySchemaKey(['schema','fixture','lock'],{[dimension]:'different'}),key);
 assert.equal(emptySchemaKey(['schema','fixture','lock']),key);
});
test('cold/warm archives restore independent instances and publish privately',async()=>fixture(async(options,counts)=>{
 const first=await cachedEmptySchema(options);first.data.push('customer data');
 const second=await cachedEmptySchema(options),third=await cachedEmptySchema(options);
 second.data.push('mutation');assert.deepEqual(third.data,[]);
 assert.deepEqual(counts(),{creates:1,restores:2});
 const file=join(options.directory,key+'.tgz');
 assert.equal((await stat(file)).mode&0o777,0o600);
 assert(!String(await readFile(file)).includes('customer data'));
 assert.deepEqual(await readdir(options.directory),[key+'.tgz']);
}));
test('missing, corrupt, mismatched, oversized and unloadable archives fall back cold',async()=>fixture(async(options,counts)=>{
 const file=join(options.directory,key+'.tgz');
 for(const bytes of ['invalid',JSON.stringify({key:'wrong',sha256:'wrong'})+'\nempty',JSON.stringify({key,sha256:'wrong'})+'\nempty',Buffer.alloc(16*1024*1024+257)]){
  await writeFile(file,bytes);await cachedEmptySchema(options);
 }
 assert.deepEqual(counts(),{creates:4,restores:0});
 await cachedEmptySchema({...options,restore:async()=>{throw Error('incompatible archive');}});
 assert.equal(counts().creates,5);
 await rm(file);await cachedEmptySchema(options);assert.equal(counts().creates,6);
}));
test('cache storage failure is optional; authoritative schema failure stops the check',async()=>fixture(async(options)=>{
 await cachedEmptySchema({...options,directory:join(options.directory,'missing')});
 await assert.rejects(cachedEmptySchema({...options,create:async()=>{throw Error('migration failed');}}),/migration failed/);
}));
test('concurrent builders publish whole archives and respect storage bound',async()=>fixture(async(options)=>{
 await Promise.all(Array.from({length:8},()=>cachedEmptySchema(options)));
 await cachedEmptySchema(options);
 assert.deepEqual(await readdir(options.directory),[key+'.tgz']);
 for(let i=0;i<31;i++)await writeFile(join(options.directory,emptySchemaKey([i])+'.tgz'),'old');
 await Promise.all(Array.from({length:8},(_,i)=>cachedEmptySchema({...options,key:emptySchemaKey(['new',i])})));
 assert.equal((await readdir(options.directory)).length,32);
}));
test('all test files remain in the bounded full-suite command and frontend remains a release hook',async()=>{
 const {scripts}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(scripts.test,'node --import tsx --test --test-concurrency=2 tests/*.test.ts tests/*.test.mjs');
 assert.equal(scripts['postcheck:release'],'npm run build:frontend');
});
test('every mandatory release failure prevents all later checks',async()=>{
 const {runReleaseGate}=await import('../scripts/check-owner-chat-gate.mjs');
 const checks=['test:owner-chat','typecheck','test'];
 for(let failure=0;failure<checks.length;failure++){
  const calls=[];
  await assert.rejects(runReleaseGate({run:async name=>{calls.push(name);if(name===checks[failure])throw Error('required check failed');}}),/required check failed/);
  assert.deepEqual(calls,checks.slice(0,failure+1));
 }
});
test('real SQL fixture rebuilds a corrupted archive without retaining test rows',async()=>{
 const {createOfflineSqlNetwork}=await import('./fixtures/offline-sql-network.mjs');
 const directory=await mkdtemp(join(tmpdir(),'cetld-real-cold-')),previous=process.env.CETLD_SQL_FIXTURE_CACHE_DIR;
 process.env.CETLD_SQL_FIXTURE_CACHE_DIR=directory;
 let first,second;
 try{
  first=await createOfflineSqlNetwork();
  await first.db.exec('insert into auth.users(id) values(gen_random_uuid())');
  await first.close();first=null;
  const [file]=await readdir(directory),target=join(directory,file),bytes=await readFile(target);
  bytes[bytes.length-1]^=1;await writeFile(target,bytes);
  second=await createOfflineSqlNetwork();
  assert.equal((await second.db.query('select count(*)::int n from auth.users')).rows[0].n,0);
  assert.notDeepEqual(await readFile(target),bytes,'corrupt entry is replaced with a freshly migrated empty snapshot');
 }finally{
  if(first)await first.close();if(second)await second.close();
  if(previous===undefined)delete process.env.CETLD_SQL_FIXTURE_CACHE_DIR;else process.env.CETLD_SQL_FIXTURE_CACHE_DIR=previous;
  await rm(directory,{recursive:true,force:true});
 }
});
