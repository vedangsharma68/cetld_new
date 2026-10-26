import {readFile,readdir} from 'node:fs/promises';
import {cachedEmptySchema,emptySchemaKey} from './empty-schema-cache.mjs';
import {PGlite} from '@electric-sql/pglite';
import {createClient} from '@supabase/supabase-js';

// An isolated PostgreSQL database behind a small PostgREST-shaped HTTP fixture.
// Real stores, SDK, RPC implementations and handlers run unchanged. This fixture
// never forwards a request to a network, and rejects unsupported query shapes.
const name=value=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error('unsupported fixture identifier');return `"${value}"`;};
const parameter=value=>value&&typeof value==='object'?JSON.stringify(value):value;
async function createFixtureDatabase(excludeMigrations){
  const files=(await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql') && !['20261023164251_exact_reminder_approval_artifact.sql','20261023083356_per_message_reminder_review.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060000_customer_reminder_tone.sql','20261018060100_invoice_details_templates.sql','20261018090021_remove_stop_footer.sql','20261020105604_invoice_reminder_full_customer_name.sql','20261022221930_default_payment_reminder_draft.sql'].includes(file) && !excludeMigrations.includes(file)).sort();
  const migrations=await Promise.all(files.map(async file=>[file,await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8')]));
  // Include schema/bootstrap code, helper, lockfile and runtime/tool dimensions.
  const directory=process.env.CETLD_SQL_FIXTURE_CACHE_DIR;
  const key=directory?emptySchemaKey([await readFile(new URL(import.meta.url),'utf8'),
    await readFile(new URL('./empty-schema-cache.mjs',import.meta.url),'utf8'),
    await readFile(new URL('../../package-lock.json',import.meta.url),'utf8'),migrations]):null;
  return cachedEmptySchema({directory,key,
    restore:async archive=>{
      const db=new PGlite({loadDataDir:archive});
      try{await db.waitReady;return db;}catch(error){await db.close().catch(()=>{});throw error;}
    },create:async()=>{
  const db=new PGlite();
  try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    grant usage on schema auth,storage to authenticated,anon,service_role;
    grant select on auth.users to service_role;
    grant execute on function auth.uid(),auth.role() to authenticated,anon,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;`);
  for(const [,sql] of migrations)await db.exec(sql.replace('create extension if not exists pgcrypto;',''));
  await db.exec('grant all on all tables in schema public to service_role;grant all on all sequences in schema public to service_role');
  return db;
  }catch(error){await db.close();throw error;}
  }});
}

export async function createOfflineSqlNetwork({externalFetch,excludeMigrations=[]}={}){
  if(excludeMigrations.some(file=>['20261026090000_contain_unproven_external_reminders.sql','20261026110000_zoho_prospective_operation_foundation.sql'].includes(file)))
    excludeMigrations=[...excludeMigrations,'20261026141000_zoho_capture_completion_protocol.sql'];
  // Historical containment fixtures install that predecessor themselves. The
  // prospective journal must follow the installed containment, never precede it.
  if(excludeMigrations.includes('20261026090000_contain_unproven_external_reminders.sql'))
    excludeMigrations=[...excludeMigrations,'20261026110000_zoho_prospective_operation_foundation.sql'];
  // The source-binding migration extends these exact installed entrypoints.
  // Historical fixtures that deliberately omit them must also omit the patch.
  if(excludeMigrations.some(file=>['20261022100000_owner_phone_contact_recovery.sql','20261022180000_owner_chat_record_consent.sql'].includes(file)))
    excludeMigrations=[...excludeMigrations,'20261026045045_quoted_owner_consent_source.sql'];
  // The bookkeeping forward migration requires the installed factual parser.
  // Historical migration fixtures intentionally omit that predecessor.
  if(excludeMigrations.includes('20261009015001_owner_payment_factual_instruction.sql'))
    excludeMigrations=[...excludeMigrations,'20261009202000_owner_payment_bookkeeping_instruction.sql'];
  // A historical review body must not receive patches for its later replacement.
  if(excludeMigrations.includes('20261009040005_invoice_review_general_inferred_currency_correction.sql'))
    excludeMigrations=[...excludeMigrations,'20261025170000_invoice_review_unknown_due_date.sql'];
  const db=await createFixtureDatabase(excludeMigrations),requests=[],errors=[],objects=new Map();let interceptor=null;

  async function fetchImpl(input,options={}){
    const request=input instanceof Request?input:null,url=new URL(request?.url||String(input));
    const method=options.method||request?.method||'GET',headers=new Headers(options.headers||request?.headers);
    const body=options.body??(request&&method!=='GET'?await request.text():null);
    const storage=url.pathname.startsWith('/storage/v1/object/');
    requests.push({url:String(url),method,body:storage?null:body?JSON.parse(body):null});
    if(interceptor)await interceptor(url,{method,headers,body},db);
    if(url.origin!=='https://fixture.supabase.test'){
      if(!externalFetch)throw Error(`Offline fixture refused network ${url.origin}`);
      return externalFetch(url,{...options,method,headers,body});
    }
    try{
      const authUser=url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/i);
      if(method==='GET'&&authUser){
        const user=(await db.query('select id,email,raw_user_meta_data from auth.users where id=$1',[authUser[1]])).rows[0];
        return user?Response.json({id:user.id,email:user.email||null,user_metadata:user.raw_user_meta_data||{}}):Response.json({message:'User not found'},{status:404});
      }
      if(storage){
        const key=decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
        if(method==='POST'){
          if(objects.has(key))return Response.json({message:'Duplicate',statusCode:'409',error:'Duplicate'},{status:409});
          const bytes=body instanceof Blob?Buffer.from(await body.arrayBuffer()):Buffer.from(body);
          objects.set(key,{bytes,type:headers.get('content-type')});
          await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',[key.split('/')[0],key.split('/').slice(1).join('/')]);
          return Response.json({Key:key});
        }
        if(method==='GET'&&objects.has(key)){
          const object=objects.get(key);return new Response(object.bytes,{headers:{'content-type':object.type}});
        }
        return Response.json({message:'Not found'},{status:404});
      }
      const path=url.pathname.replace(/^\/rest\/v1\//,''),params=url.searchParams;
      if(path.startsWith('rpc/')){
        const fn=path.slice(4),args=JSON.parse(body||'{}'),keys=Object.keys(args);
        const metadata=(await db.query('select proretset from pg_proc where proname=$1 and coalesce(proargnames,ARRAY[]::text[]) @> $2::text[] limit 1',[fn,keys])).rows[0];
        if(!metadata)throw Error(`unknown fixture RPC ${fn}`);
        const invocation=`public.${name(fn)}(${keys.map((key,index)=>`${name(key)}=>$${index+1}`).join(',')})`;
        const result=await db.query(metadata.proretset?`select * from ${invocation}`:`select ${invocation} as value`,keys.map(key=>parameter(args[key])));
        return Response.json(metadata.proretset?result.rows:result.rows[0].value);
      }
      const table=name(path),args=[],conditions=[];
      const expr=column=>{
        const nested=/^([a-z_]\w*)->([a-z_]\w*)->>([a-z_]\w*)$/i.exec(column);
        if(nested)return `${name(nested[1])}->'${nested[2]}'->>'${nested[3]}'`;
        if(path==='invoices'&&column==='customer.name')return '(select fixture_customer.name from public.customers fixture_customer where fixture_customer.workspace_id=invoices.workspace_id and fixture_customer.id=invoices.customer_id)';
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
        const columns=select==='*'?'*':select.split(',').map(column=>{
          if(path==='invoices'&&['customer:customers!invoices_workspace_id_customer_id_fkey(name)','customer:customers!invoices_workspace_id_customer_id_fkey!inner(name)'].includes(column))
            return '(select jsonb_build_object(\'name\',fixture_customer.name) from public.customers fixture_customer where fixture_customer.workspace_id=invoices.workspace_id and fixture_customer.id=invoices.customer_id) as customer';
          return expr(column);
        }).join(',');
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
        const updated=await db.query(`update public.${table} set ${set}${where} returning to_jsonb(${table}) as fixture_row`,args);
        result={rows:updated.rows.map(row=>row.fixture_row)};
      }else if(method==='DELETE')result=await db.query(`delete from public.${table}${where} returning *`,args);
      else if(method==='POST'){
        const rows=Array.isArray(JSON.parse(body))?JSON.parse(body):[JSON.parse(body)],saved=[];
        for(const row of rows){
          // PostgREST accepts hex bytea on the wire; PGlite's JS parameter
          // decoder needs an explicit SQL decode for the media inbox fixture.
          const keys=Object.keys(row),values=keys.map(key=>path==='whatsapp_inbound_media'&&key==='bytes'
            &&typeof row[key]==='string'&&/^\\x[\da-f]+$/i.test(row[key])
            ?`decode(${bind(row[key].slice(2))},'hex')`:bind(row[key]));
          const conflict=params.get('on_conflict');
          const upsert=conflict?` on conflict (${conflict.split(',').map(name).join(',')}) ${headers.get('prefer')?.includes('ignore-duplicates')?'do nothing':`do update set ${keys.map(key=>`${name(key)}=excluded.${name(key)}`).join(',')}`}`:'';
          saved.push(...(await db.query(`insert into public.${table} (${keys.map(name).join(',')}) values (${values.join(',')})${upsert} returning to_jsonb(${table}) as fixture_row`,args)).rows.map(row=>row.fixture_row));
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
