import test from 'node:test';
import assert from 'node:assert/strict';
import {PRIVATE_UNICODE_FOLD} from '../ai/private-value-unicode.mjs';
import {normalizePrivateValue} from '../ai/private-value-matcher.mjs';
import {fixture} from './fixtures/private-invoice.mjs';

const terms=async(f,workspace=f.scope.workspaceId)=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[workspace])).rows.map(r=>r.term);
const count=async f=>(await f.db.query('select count(*)::int n from app.private_invoice_canonical_inputs')).rows[0].n;

test('optimized SQL fold equals JS for every generated mapping, ASCII control and unmapped Unicode sample',async()=>{
 const f=await fixture();try{
  const unmapped=[];for(let cp=1;cp<=0x10ffff;cp+=991)if(cp<0xd800||cp>0xdfff)unmapped.push(String.fromCodePoint(cp));
  for(const value of [null,Array.from({length:127},(_,i)=>String.fromCodePoint(i+1)).join(''),Object.keys(PRIVATE_UNICODE_FOLD).join(''),unmapped.join(''), 'İlker\u0085The\u00a0किरण\u200bStudio']){
   assert.equal((await f.db.query('select app.private_invoice_normalize($1) value',[value])).rows[0].value,normalizePrivateValue(value));
  }
 }finally{await f.close();}
});

test('completed canonical inputs preserve field roles, aliases and workspace isolation without caching ordinary audit turns',async()=>{
 const f=await fixture();try{
  const before=await count(f);
  await f.db.query("insert into owner_assistant_turns(workspace_id,owner_id,event_key,channel,role,content) values($1,$2,'ordinary-cache-probe','whatsapp','user','Good morning, how are you?')",[f.scope.workspaceId,f.scope.ownerId]);
  assert.equal(await count(f),before,'Ordinary audit content does not grow the private completion cache');
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{total:'31.10',notes:'Anurag Sharma'}]);
  let values=await terms(f);assert.ok(values.includes('number:31.1'));assert.ok(!values.includes('date:*-10-31'));assert.ok(!values.includes('party:anurag'));
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:'31.10',customerName:'Anurag Sharma'}]);
  values=await terms(f);assert.ok(values.includes('date:*-10-31'));assert.ok(values.includes('party:anurag'));
  const rows=await count(f);await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{notes:'31.10',customerName:'Anurag Sharma'}]);
  assert.equal(await count(f),rows);assert.deepEqual(await terms(f),values);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.scope.ownerId}'`);
  const other=(await f.db.query('select (public.create_workspace($1,gen_random_uuid()::text)).id',['Other synthetic cache scope'])).rows[0].id;
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[other,{customerName:'Anurag Sharma'}]);
  assert.ok((await terms(f,other)).includes('party:anurag'),'One workspace cannot claim another workspace has completed capture');
  const shape=(await f.db.query("select column_name,data_type from information_schema.columns where table_schema='app' and table_name='private_invoice_canonical_inputs' order by ordinal_position")).rows;
  assert.deepEqual(shape,[{column_name:'workspace_id',data_type:'uuid'},{column_name:'canonicalizer_revision',data_type:'bytea'},{column_name:'input_kind',data_type:'text'},{column_name:'input_hash',data_type:'bytea'}]);
  assert.ok((await f.db.query('select bool_and(octet_length(input_hash)=32 and octet_length(canonicalizer_revision)=32) ok from app.private_invoice_canonical_inputs')).rows[0].ok);
 }finally{await f.close();}
});

test('cache completion rolls back with failed alias capture and revisions revisit existing raw terms',async()=>{
 const f=await fixture();try{
  const value='cache failure canary',args=[f.scope.workspaceId,{notes:value}];
  await f.db.exec("create function app.fail_cache_canary() returns trigger language plpgsql as $$begin if new.term='cache failure canary' then raise exception 'PRIVATE_CACHE_CANARY';end if;return new;end $$;create trigger fail_cache_canary before insert on whatsapp_private_invoice_terms for each row execute function app.fail_cache_canary()");
  await assert.rejects(f.db.query('select app.retain_private_invoice_terms($1,$2)',args),/PRIVATE_CACHE_CANARY/);
  assert.equal((await f.db.query("select count(*)::int n from app.private_invoice_canonical_inputs where workspace_id=$1 and input_hash=sha256(convert_to($2,'UTF8'))",[f.scope.workspaceId,value])).rows[0].n,0);
  assert.ok(!(await terms(f)).includes(value));
  await f.db.exec('drop trigger fail_cache_canary on whatsapp_private_invoice_terms');await f.db.query('select app.retain_private_invoice_terms($1,$2)',args);assert.ok((await terms(f)).includes(value));
  const first=(await f.db.query('select app.private_invoice_canonical_revision() revision')).rows[0].revision;
  const next=first==='f'.repeat(64)?'e'.repeat(64):'f'.repeat(64);
  await f.db.exec(`create or replace function app.private_invoice_canonical_revision() returns text language sql immutable set search_path='' as $$select '${next}'::text$$`);
  await f.db.exec('create trigger fail_cache_canary before insert on whatsapp_private_invoice_terms for each row execute function app.fail_cache_canary()');
  await assert.rejects(f.db.query('select app.retain_private_invoice_terms($1,$2)',args),/PRIVATE_CACHE_CANARY/,'A new revision must revisit the aliases even when an older completion marker exists');
  await f.db.exec('drop trigger fail_cache_canary on whatsapp_private_invoice_terms');
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',args);
  assert.ok((await terms(f)).includes('identifier:cachefailurecanary'),'A new revision does not trust an older completion marker');
  assert.equal((await f.db.query("select count(distinct canonicalizer_revision)::int n from app.private_invoice_canonical_inputs where workspace_id=$1 and input_kind='generic' and input_hash=sha256(convert_to($2,'UTF8'))",[f.scope.workspaceId,value])).rows[0].n,2);
 }finally{await f.close();}
});

test('privileged alias removal invalidates only its workspace completions before a rebuild',async()=>{
 const f=await fixture();try{
  const input={customerName:'Local Cache Studio',total:51927};await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,input]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.scope.ownerId}'`);
  const other=(await f.db.query('select (public.create_workspace($1,gen_random_uuid()::text)).id',['Unrelated cache invalidation scope'])).rows[0].id;
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[other,input]);
  const completions=async workspace=>(await f.db.query('select count(*)::int n from app.private_invoice_canonical_inputs where workspace_id=$1',[workspace])).rows[0].n;
  const otherCompletions=await completions(other);assert.ok(otherCompletions>0);
  const before=await terms(f);assert.ok(before.includes('party:local'));assert.ok(before.includes('number:51927'));assert.ok(await count(f)>0);
  await f.db.query("delete from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:51927'",[f.scope.workspaceId]);
  assert.equal(await completions(f.scope.workspaceId),0);assert.equal(await completions(other),otherCompletions);assert.ok(!(await terms(f)).includes('number:51927'));
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,input]);assert.deepEqual(await terms(f),before);assert.ok(await count(f)>0);
  await f.db.query('delete from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId]);assert.equal(await completions(f.scope.workspaceId),0);assert.equal(await completions(other),otherCompletions);
  await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,input]);assert.deepEqual(await terms(f),before);
 }finally{await f.close();}
});

test('completion cache and mutable capture helpers have no API privileges under production defaults',async()=>{
 const f=await fixture();try{
  assert.equal((await f.db.query("select relrowsecurity from pg_class where oid='app.private_invoice_canonical_inputs'::regclass")).rows[0].relrowsecurity,true);
  for(const role of ['anon','authenticated','service_role']){
   for(const permission of ['select','insert','update','delete'])assert.equal((await f.db.query("select has_table_privilege($1,'app.private_invoice_canonical_inputs',$2) ok",[role,permission])).rows[0].ok,false);
   for(const name of ['app.retain_private_invoice_field(uuid,text,text)','app.private_invoice_canonical_revision()','app.invalidate_private_canonical_inputs()'])assert.equal((await f.db.query('select has_function_privilege($1,$2,\'execute\') ok',[role,name])).rows[0].ok,false);
  }
 }finally{await f.close();}
});
