import {spawn} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Explicit offline verification only. A private ephemeral PostgreSQL container
// has no network or host ports; no production credentials or records are used.
const image='postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94';
const container=`cetld-source-test-${randomUUID()}`;
const owner=randomUUID(),customer=randomUUID();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function command(args,input='',hold=false){
  const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const result=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
  if(hold)child.stdin.write(input);else child.stdin.end(input);
  return {child,result,get stdout(){return stdout;}};
}
const sql=(input,hold=false)=>command(['exec','-i',container,'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-U','postgres'],input,hold);
async function query(input){const result=await sql(input).result;assert.equal(result.code,0,result.stderr);return result.stdout.trim();}
async function until(check,label){
  for(let attempt=0;attempt<100;attempt++){if(await check())return;await pause(50);}
  throw Error(`Timed out waiting for ${label}`);
}
let first,second;
try{
  const started=await command(['run','--detach','--rm','--pull=never','--network','none','--name',container,'-e','POSTGRES_PASSWORD=isolated-fixture-only',image]).result;
  assert.equal(started.code,0,started.stderr);
  // The entrypoint's temporary bootstrap server has only a Unix socket.
  // Wait for the final TCP listener before opening migration sessions.
  await until(async()=> (await command(['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres']).result).code===0,'private PostgreSQL startup');
  await query(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    grant usage on schema auth,storage to authenticated,anon,service_role;
    grant execute on function auth.uid(),auth.role() to authenticated,anon,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;`);
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())
    await query(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  await query('grant all on all tables in schema public to service_role;grant all on all sequences in schema public to service_role');
  const workspace=(await query(`insert into auth.users(id) values('${owner}');set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated;
    select (public.create_workspace('Isolated concurrency fixture','${randomUUID()}')).id;`)).split('\n').at(-1);
  assert.match(workspace,/^[0-9a-f-]{36}$/);
  await query(`insert into customers(id,workspace_id,name) values('${customer}','${workspace}','Fixture customer')`);
  const insert=key=>`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,currency,total_amount,metadata)
    values('${workspace}','${customer}','AUTO','2026-10-01','USD',100,'{"printed_invoice_number":"CONCURRENT-SOURCE-17","assistant_idempotency_key":"${key}","invoice_direction":"receivable"}');`;
  first=sql(`begin;set application_name='cetld_source_first';set role service_role;${insert('wa_concurrent_first')}select 'FIRST_INSERTED';\n`,true);
  await until(()=>first.stdout.includes('FIRST_INSERTED'),'first uncommitted insert');
  second=sql(`begin;set application_name='cetld_source_second';set role service_role;${insert('wa_concurrent_second')}commit;`);
  await until(async()=>await query("select count(*) from pg_stat_activity where application_name='cetld_source_second' and wait_event='advisory'")==='1','second transaction advisory lock');
  first.child.stdin.end('commit;\n');
  const [saved,refused]=await Promise.all([first.result,second.result]);
  assert.equal(saved.code,0,saved.stderr);assert.notEqual(refused.code,0);
  assert.match(refused.stderr,/23505: source invoice already exists for customer/);
  assert.equal(await query('select count(*) from invoices'),'1');
  assert.equal(await query('select count(*) from payments'),'0');
  console.log('PASS: complete migration chain on PostgreSQL 17.6; two independent SQL sessions; second source insert waits on advisory lock, then refuses duplicate after first commit; one invoice, zero payments.');
}finally{
  first?.child.kill();second?.child.kill();
  const removed=await command(['rm','--force',container]).result;
  if(removed.code!==0&&!removed.stderr.includes('No such container'))throw Error(removed.stderr);
}
