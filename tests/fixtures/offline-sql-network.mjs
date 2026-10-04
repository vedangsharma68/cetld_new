import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createClient} from '@supabase/supabase-js';

// An isolated PostgreSQL database behind a small PostgREST-shaped HTTP fixture.
// Real stores, SDK, RPC implementations and handlers run unchanged. This fixture
// never forwards a request to a network, and rejects unsupported query shapes.
const name=value=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error('unsupported fixture identifier');return `"${value}"`;};
const parameter=value=>value&&typeof value==='object'?JSON.stringify(value):value;
export async function createOfflineSqlNetwork({externalFetch}={}){
  const db=new PGlite(),requests=[],errors=[];let interceptor=null;
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    grant usage on schema auth,storage to authenticated,anon,service_role;
    grant execute on function auth.uid(),auth.role() to authenticated,anon,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;`);
  for(const file of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())
    await db.exec((await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await db.exec('grant all on all tables in schema public to service_role;grant all on all sequences in schema public to service_role');

  async function fetchImpl(input,options={}){
    const request=input instanceof Request?input:null,url=new URL(request?.url||String(input));
    const method=options.method||request?.method||'GET',headers=new Headers(options.headers||request?.headers);
    const body=options.body??(request&&method!=='GET'?await request.text():null);
    requests.push({url:String(url),method,body:body?JSON.parse(body):null});
    if(interceptor)await interceptor(url,{method,headers,body},db);
    if(url.origin!=='https://fixture.supabase.test'){
      if(!externalFetch)throw Error(`Offline fixture refused network ${url.origin}`);
      return externalFetch(url,{...options,method,headers,body});
    }
    try{
      const path=url.pathname.replace(/^\/rest\/v1\//,''),params=url.searchParams;
      if(path.startsWith('rpc/')){
        const fn=path.slice(4),args=JSON.parse(body||'{}'),keys=Object.keys(args);
        const metadata=(await db.query('select proretset from pg_proc where proname=$1 and proargnames @> $2::text[] limit 1',[fn,keys])).rows[0];
        if(!metadata)throw Error(`unknown fixture RPC ${fn}`);
        const invocation=`public.${name(fn)}(${keys.map((key,index)=>`${name(key)}=>$${index+1}`).join(',')})`;
        const result=await db.query(metadata.proretset?`select * from ${invocation}`:`select ${invocation} as value`,keys.map(key=>parameter(args[key])));
        return Response.json(metadata.proretset?result.rows:result.rows[0].value);
      }
      const table=name(path),args=[],conditions=[];
      const expr=column=>{
        const parts=column.split('->>');if(parts.length===1)return name(column);
        if(parts.length!==2||!/^\w+$/.test(parts[1]))throw Error('unsupported fixture json selector');
        return `${name(parts[0])}->>'${parts[1]}'`;
      };
      const bind=value=>{args.push(parameter(value));return `$${args.length}`;};
      for(const [column,value] of params){
        if(['select','order','limit','offset','on_conflict','columns'].includes(column))continue;
        if(column==='or')throw Error('unsupported fixture OR filter');
        const field=expr(column);
        if(value==='is.null')conditions.push(`${field} is null`);
        else if(value==='not.is.null')conditions.push(`${field} is not null`);
        else if(value.startsWith('in.(')&&value.endsWith(')'))conditions.push(`${field} in (${value.slice(4,-1).split(',').map(bind).join(',')})`);
        else{
          const dot=value.indexOf('.'),op=value.slice(0,dot),expected=value.slice(dot+1);
          const operator={eq:'=',neq:'<>',lt:'<',lte:'<=',gt:'>',gte:'>=',ilike:'ilike'}[op];
          if(!operator)throw Error('unsupported fixture filter');
          conditions.push(`${field} ${operator} ${bind(expected)}`);
        }
      }
      const where=conditions.length?` where ${conditions.join(' and ')}`:'';
      let result;
      if(method==='GET'){
        const select=params.get('select')||'*';
        const columns=select==='*'?'*':select.split(',').map(expr).join(',');
        const order=params.get('order')?` order by ${params.get('order').split(',').map(item=>{
          const [column,direction='asc']=item.split('.');if(!['asc','desc'].includes(direction))throw Error('unsupported fixture order');return `${expr(column)} ${direction}`;
        }).join(',')}`:'';
        const limit=params.has('limit')?` limit ${bind(Number(params.get('limit')))}`:'';
        const offset=params.has('offset')?` offset ${bind(Number(params.get('offset')))}`:'';
        // Match PostgREST's PostgreSQL JSON representation, including timestamptz
        // strings. PGlite's JS Date decoding would rewrite +00:00 to Z and make
        // persisted version verification differ from the actual JSONB RPC wire.
        const selected=await db.query(`select to_jsonb(fixture_row) as fixture_row from (select ${columns} from public.${table}${where}${order}${limit}${offset}) fixture_row`,args);
        result={rows:selected.rows.map(row=>row.fixture_row)};
      }else if(method==='PATCH'){
        const patch=JSON.parse(body),set=Object.entries(patch).map(([column,value])=>`${name(column)}=${bind(value)}`).join(',');
        result=await db.query(`update public.${table} set ${set}${where} returning *`,args);
      }else if(method==='DELETE')result=await db.query(`delete from public.${table}${where} returning *`,args);
      else if(method==='POST'){
        const rows=Array.isArray(JSON.parse(body))?JSON.parse(body):[JSON.parse(body)],saved=[];
        for(const row of rows){
          const keys=Object.keys(row),values=keys.map(key=>bind(row[key]));
          const conflict=params.get('on_conflict');
          const upsert=conflict?` on conflict (${conflict.split(',').map(name).join(',')}) ${headers.get('prefer')?.includes('ignore-duplicates')?'do nothing':`do update set ${keys.map(key=>`${name(key)}=excluded.${name(key)}`).join(',')}`}`:'';
          saved.push(...(await db.query(`insert into public.${table} (${keys.map(name).join(',')}) values (${values.join(',')})${upsert} returning *`,args)).rows);
          args.length=0;
        }
        result={rows:saved};
      }else throw Error('unsupported fixture HTTP method');
      if(headers.get('accept')?.includes('vnd.pgrst.object')){
        if(result.rows.length!==1)return Response.json({code:'PGRST116',message:'JSON object requested, multiple (or no) rows returned',details:`The result contains ${result.rows.length} rows`},{status:406});
        return Response.json(result.rows[0]);
      }
      return Response.json(result.rows);
    }catch(error){errors.push({path:url.pathname,message:error.message});return Response.json({message:error.message,code:error.code||'FIXTURE_SQL_ERROR',details:error.detail||null},{status:400});}
  }
  const supabase=createClient('https://fixture.supabase.test','isolated-fixture-service-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:fetchImpl}});
  return {db,supabase,fetchImpl,requests,errors,intercept:callback=>{interceptor=callback},close:()=>db.close()};
}
