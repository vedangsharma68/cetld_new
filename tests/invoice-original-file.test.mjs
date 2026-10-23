import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import vm from 'node:vm';
import {downloadOriginalInvoiceFile,saveOriginalInvoiceFile} from '../invoice/original-file-client.mjs';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';

const workspaceId=randomUUID(),invoiceId=randomUUID(),userId=randomUUID(),fileId=randomUUID();
const original=Buffer.from('%PDF-1.4\nSynthetic original\n%%EOF\n');
const file={id:fileId,workspace_id:workspaceId,invoice_id:invoiceId,storage_path:`${workspaceId}/${invoiceId}/original.pdf`,file_name:'Original invoice.pdf',mime_type:'application/pdf',size_bytes:original.length};
function fixture({user={id:userId},invoice={id:invoiceId,workspace_id:workspaceId,deleted_at:null},files=[file],blob=new Blob([original],{type:'application/pdf'}),tableError=null,downloadError=null}={}){
 const reads=[],downloads=[];
 return {reads,downloads,auth:{async getUser(){return {data:{user},error:user?null:{message:'Not signed in'}};}},
  from(table){const filters=[];const q={select(){return q;},eq(column,value){filters.push([column,value]);return q;},is(column,value){filters.push([column,value]);return q;},order(){return q;},limit(){return q;},
   async maybeSingle(){reads.push({table,filters});return {data:invoice,error:tableError};},
   then(resolve,reject){reads.push({table,filters});return Promise.resolve({data:files,error:tableError}).then(resolve,reject);}};return q;},
  storage:{from(bucket){return {async download(path){downloads.push({bucket,path});return {data:blob,error:downloadError};}};}}
 };
}

test('authenticated download scopes active invoice and metadata and returns original bytes through private Storage',async()=>{
 const client=fixture(),result=await downloadOriginalInvoiceFile(client,{workspaceId,invoiceId});
 assert.equal(result.fileId,fileId);assert.equal(result.fileName,'Original invoice.pdf');
 assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),original);
 assert.deepEqual(client.reads[0],{table:'invoices',filters:[['workspace_id',workspaceId],['id',invoiceId],['deleted_at',null]]});
 assert.deepEqual(client.reads[1],{table:'invoice_files',filters:[['workspace_id',workspaceId],['invoice_id',invoiceId]]});
 assert.deepEqual(client.downloads,[{bucket:'invoice-files',path:file.storage_path}]);
});

test('signed-out, invalid scope, inaccessible and deleted invoices never reach Storage',async()=>{
 for(const options of [{user:null},{invoice:null},{invoice:{id:invoiceId,workspace_id:randomUUID()}},{invoice:{id:invoiceId,workspace_id:workspaceId,deleted_at:'2026-10-01'}},{tableError:{message:'denied'}}]){
  const client=fixture(options);await assert.rejects(downloadOriginalInvoiceFile(client,{workspaceId,invoiceId}));assert.deepEqual(client.downloads,[]);
 }
 const client=fixture();await assert.rejects(downloadOriginalInvoiceFile(client,{workspaceId:'../other',invoiceId}));assert.deepEqual(client.reads,[]);
});

for(const patch of [
 {workspace_id:randomUUID()},{invoice_id:randomUUID()},
 {storage_path:`${workspaceId}/${randomUUID()}/original.pdf`},
 ...['..','%2e%2e','%2Fother.pdf','%5Cother.pdf','file?token=x','file#fragment','%00bad.pdf','bad%'].map(name=>({storage_path:`${workspaceId}/${invoiceId}/${name}`})),
 {mime_type:'text/html'},{mime_type:'__proto__'},{size_bytes:null},{size_bytes:0},{size_bytes:10*1024*1024+1},
])test(`untrusted file metadata is refused before Storage: ${JSON.stringify(patch)}`,async()=>{
 const client=fixture({files:[{...file,...patch}]});await assert.rejects(downloadOriginalInvoiceFile(client,{workspaceId,invoiceId}));assert.deepEqual(client.downloads,[]);
});

test('missing originals and failed downloads return useful errors without fabricating a file',async()=>{
 const missing=fixture({files:[]});await assert.rejects(downloadOriginalInvoiceFile(missing,{workspaceId,invoiceId}),/No original attachment was saved/);assert.deepEqual(missing.downloads,[]);
 for(const options of [{downloadError:{message:'storage denied'}},{blob:new Blob(['wrong size'],{type:'application/pdf'})},{blob:new Blob([original],{type:'text/html'})}])
  await assert.rejects(downloadOriginalInvoiceFile(fixture(options),{workspaceId,invoiceId}),/original attachment is unavailable/);
});

test('download filename uses the verified MIME extension and browser URL is cleaned up even if click fails',async()=>{
 const client=fixture({files:[{...file,file_name:'../unsafe\u202e.exe'}]});
 const saved=await downloadOriginalInvoiceFile(client,{workspaceId,invoiceId});assert.match(saved.fileName,/\.pdf$/);assert.doesNotMatch(saved.fileName,/[\\/\u202e]/);
 for(const fail of [false,true]){
  const events=[],anchor={remove(){events.push('remove');},click(){events.push('click');if(fail)throw Error('blocked download');}};
  const options={documentImpl:{body:{append(value){assert.equal(value,anchor);events.push('append');}},createElement:()=>anchor},urlImpl:{createObjectURL(value){assert.equal(value,saved.blob);return 'blob:original';},revokeObjectURL(value){assert.equal(value,'blob:original');events.push('revoke');}},schedule:fn=>fn()};
  if(fail)assert.throws(()=>saveOriginalInvoiceFile(saved,options),/blocked download/);else saveOriginalInvoiceFile(saved,options);
  assert.equal(anchor.download,saved.fileName);assert.equal(anchor.href,'blob:original');assert.deepEqual(events,['append','click','remove','revoke']);
 }
});

test('invoice details expose the action outside financial controls and switching account during download discards the result',async()=>{
 const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
 assert.match(source,/!state\.demo\?button\('download-invoice-original',icon\('download'\)\+' Download original','',id\)/);
 assert.match(source,/if\(action==='download-invoice-original'\)return await downloadInvoiceOriginal\(id,b\)/);
 const action=source.slice(source.indexOf('async function downloadInvoiceOriginal('),source.indexOf('\nfunction invoiceDeleteStatus('));
 let release;const pending=new Promise(resolve=>{release=resolve;});let saves=0;
 const state={demo:false,user:{id:userId},workspace:{id:workspaceId},invoices:[{id:invoiceId,amount_minor:14000,paid_minor:4000,followup_state:'paused'}]},before=structuredClone(state.invoices);
 const context={state,db:{},downloadOriginalInvoiceFile:async()=>pending,saveOriginalInvoiceFile:()=>saves++,toast(){}};
 vm.runInNewContext(action+';globalThis.run=downloadInvoiceOriginal',context);
 const trigger={disabled:false,setAttribute(){},removeAttribute(){}};
 const result=context.run(invoiceId,trigger);assert.equal(trigger.disabled,true);state.user={id:randomUUID()};release({blob:new Blob([original]),fileName:'original.pdf'});
 await assert.rejects(result,/business changed/);assert.equal(saves,0);assert.equal(trigger.disabled,false);assert.deepEqual(state.invoices,before);
});

test('actual SQL RLS permits own original, denies foreign workspace and anonymous download before Storage',async()=>{
 const f=await createOfflineSqlNetwork(),owner=randomUUID(),foreign=randomUUID();
 try{
  // Match Supabase Storage's table privilege; unchanged invoice-file RLS still decides visibility.
  await f.db.exec('grant select on storage.objects to authenticated,anon');
  await f.db.query('insert into auth.users(id) values($1),($2)',[owner,foreign]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const own=(await f.db.query("select (create_workspace('Synthetic file owner',$1)).id",[randomUUID()])).rows[0].id;
  await f.db.exec(`reset role;set request.jwt.claim.sub='${foreign}';set role authenticated`);
  const other=(await f.db.query("select (create_workspace('Synthetic foreign file owner',$1)).id",[randomUUID()])).rows[0].id;
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Synthetic file customer') returning id",[own])).rows[0].id;
  const invoice=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,currency,total_amount,status,metadata) values($1,$2,'FILE-QA',current_date,'USD',140,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[own,customer])).rows[0].id;
  const source=Buffer.from(original),expected=createHash('sha256').update(source).digest('hex');
  await createWhatsAppInvoiceStore({supabase:f.supabase,workspaceId:own,customerId:customer}).keepInvoiceFile({invoiceId:invoice,bytes:source,fileName:'Synthetic original.pdf',mimeType:'application/pdf',idempotencyKey:'original.pdf'});
  source.fill(0);
  const scopedClient=actor=>({auth:{async getUser(){return {data:{user:actor?{id:actor}:null},error:null};}},from:f.supabase.from.bind(f.supabase),storage:f.supabase.storage});
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
  const downloaded=await downloadOriginalInvoiceFile(scopedClient(owner),{workspaceId:own,invoiceId:invoice});
  assert.equal(createHash('sha256').update(Buffer.from(await downloaded.blob.arrayBuffer())).digest('hex'),expected);
  assert.equal((await f.db.query("select count(*)::int n from storage.objects where bucket_id='invoice-files'")).rows[0].n,1);
  const storageReads=f.requests.filter(r=>r.url.includes('/storage/')&&r.method==='GET').length;
  await f.db.exec(`reset role;set request.jwt.claim.sub='${foreign}';set role authenticated`);
  await assert.rejects(downloadOriginalInvoiceFile(scopedClient(foreign),{workspaceId:own,invoiceId:invoice}),/unavailable/);
  await assert.rejects(downloadOriginalInvoiceFile(scopedClient(foreign),{workspaceId:other,invoiceId:invoice}),/unavailable/);
  assert.equal((await f.db.query("select count(*)::int n from storage.objects where bucket_id='invoice-files'")).rows[0].n,0);
  await assert.rejects(downloadOriginalInvoiceFile(scopedClient(null),{workspaceId:own,invoiceId:invoice}),/Sign in/);
  assert.equal(f.requests.filter(r=>r.url.includes('/storage/')&&r.method==='GET').length,storageReads);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
