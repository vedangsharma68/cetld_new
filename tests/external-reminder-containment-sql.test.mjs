import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

const file='20261026090000_contain_unproven_external_reminders.sql';
const migration=()=>readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const state=db=>db.query(`select n.nspname,p.proname,p.oid,pg_get_functiondef(p.oid) definition,p.proacl::text acl,
 p.proowner,p.prosecdef,p.proconfig,p.provolatile,p.prolang,p.proleakproof
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app') order by p.oid`);

async function seedBusiness(db){
  const owner='10000000-0000-0000-0000-000000000003';
  await db.query('insert into auth.users(id) values($1)',[owner]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}'`);
  const ws=(await db.query("select (create_workspace('Containment fixture','10000000-0000-0000-0000-000000000004')).id")).rows[0].id;
  await db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Untouched fixture') returning id",[ws])).rows[0].id;
  const saved=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,external_provider,external_invoice_id,metadata)
   values($1,$2,'CONTAIN',current_date,current_date,'USD',125,'sent','zoho_books','same-id','{"invoice_direction":"receivable","provider_account_binding":{"verified":true}}') returning *`,[ws,customer])).rows[0];
  const settings=(await db.query('select updated_at from workspace_settings where workspace_id=$1',[ws])).rows[0];
  await db.query(`insert into cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until)
    values($1,$2,now(),$3,$4,'claimed',now()+interval '2 minutes')`,[ws,saved.id,saved.automation_version,settings.updated_at]);
  const business=async()=>Promise.all(['invoices','customers','payments','cetld_accounting_sync_records','cetld_core_automation_delivery_claims','whatsapp_pending_actions','owner_assistant_proposals','whatsapp_messages']
    .map(async table=>(await db.query(`select to_jsonb(t) value from public.${table} t order by id`)).rows));
  return business;
}

test('containment replaces only four existing bodies, preserving security, ACLs and every other installed function',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[file]});
 try{
  const before=(await state(f.db)).rows;
  const business=await seedBusiness(f.db);
  const businessBefore=await business();
  // Counterfactual source gap, not evidence of a real collision/send: the old
  // predicate accepts exact matching facts without any original account proof.
  const linked={id:'10000000-0000-0000-0000-000000000001',workspace_id:'10000000-0000-0000-0000-000000000002',
   external_provider:'zoho_books',external_invoice_id:'same-id',metadata:{},automation_version:1,updated_at:new Date().toISOString(),
   status:'sent',currency:'USD',total_amount:125,amount_paid:0};
  const proof={ownerId:'10000000-0000-0000-0000-000000000003',workspaceId:linked.workspace_id,invoiceId:linked.id,
   provider:'zoho_books',externalId:'same-id',startedAt:new Date().toISOString(),invoiceVersion:'1',invoiceUpdatedAt:linked.updated_at,
   status:'sent',currency:'USD',total:'125',paid:'0',linkage:['zoho_books','same-id',null,null],currentAccountId:'switched-org'};
  await f.db.exec("set request.jwt.claim.role='service_role'");
  await f.db.query("select set_config('app.reminder_external_read',$1,false)",[JSON.stringify(proof)]);
  const matches=async()=>(await f.db.query('select app.reminder_external_read_matches(jsonb_populate_record(null::invoices,$1::jsonb),$2) ok',
   [JSON.stringify(linked),proof.ownerId])).rows[0].ok;
  assert.equal(await matches(),true,'old evidence lacks original-account authority');
  await f.db.exec(await migration());
  assert.deepEqual(await business(),businessBefore,'existing linked invoice, customer, payment, snapshot, queue and conversation rows are untouched');
  assert.equal(await matches(),false,'the same privileged crafted evidence is intentionally unavailable');
  const after=(await state(f.db)).rows;
  assert.equal(after.length,before.length,'no new functions');
  const changed=[];
  for(let n=0;n<after.length;n++){
   const {definition:a,...securityA}=after[n],{definition:b,...securityB}=before[n];
   assert.deepEqual(securityA,securityB,'owner, OID, ACL, invoker/definer, search_path and other attributes unchanged');
   if(a!==b)changed.push(after[n].proname);
  }
  assert.deepEqual(changed.sort(),['cetld_core_authorize_delivery','cetld_core_claim_due_followups','reminder_external_read_matches','reminder_local_status_payable']);
  const local={id:'10000000-0000-0000-0000-000000000001',status:'sent',currency:'USD',total_amount:125,amount_paid:0,metadata:{}};
  await f.db.exec("set request.jwt.claim.role='service_role'");
  for(const marker of [{external_provider:'zoho_books'},{external_invoice_id:'same-id'},
   ...['accounting_provider','bookkeeping_record_id'].flatMap(key=>['value',[],{},false,0,'\t'].map(value=>({metadata:{[key]:value,provider_account_binding:{immutable:true,verified:true}}})))]){
   const i={...local,...marker};
   assert.equal((await f.db.query('select app.reminder_local_status_payable(jsonb_populate_record(null::invoices,$1::jsonb)) ok',[JSON.stringify(i)])).rows[0].ok,false);
   await f.db.query("select set_config('app.reminder_external_read',$1,false)",[JSON.stringify({ownerId:'10000000-0000-0000-0000-000000000002',workspaceId:'current',invoiceId:i.id,verified:true,startedAt:new Date().toISOString(),provenance:'verified'})]);
   assert.equal((await f.db.query("select app.reminder_external_read_matches(jsonb_populate_record(null::invoices,$1::jsonb),'10000000-0000-0000-0000-000000000002') ok",[JSON.stringify(i)])).rows[0].ok,false);
  }
  for(const status of ['sent','overdue','draft','paid','void','cancelled'])assert.equal((await f.db.query('select app.reminder_local_status_payable(jsonb_populate_record(null::invoices,$1::jsonb)) ok',[JSON.stringify({...local,status})])).rows[0].ok,['sent','overdue'].includes(status));
 }finally{await f.close()}
});

test('migration rejects source/security/ACL drift atomically instead of guessing an installed predecessor',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[file]});
 try{
  const original=(await f.db.query("select pg_get_functiondef('app.reminder_external_read_matches(invoices,uuid)'::regprocedure) d")).rows[0].d;
  for(const drift of ['source','security','acl','missing']){
   if(drift==='source')await f.db.exec(original.replace('declare e jsonb;','declare e jsonb; -- drift'));
   if(drift==='security')await f.db.exec('alter function app.reminder_external_read_matches(invoices,uuid) security definer');
   if(drift==='acl')await f.db.exec('grant execute on function app.reminder_external_read_matches(invoices,uuid) to authenticated');
   if(drift==='missing')await f.db.exec('alter function app.reminder_external_read_matches(invoices,uuid) rename to reminder_external_read_matches_missing');
   const before=(await state(f.db)).rows;
   await assert.rejects(f.db.exec(await migration()),/predecessor (?:(?:source|ACL) drift|missing)/);
   await f.db.exec('rollback');
   assert.deepEqual((await state(f.db)).rows,before,'no partial function replacement on rejected migration');
   if(drift==='missing')await f.db.exec('alter function app.reminder_external_read_matches_missing(invoices,uuid) rename to reminder_external_read_matches');
   await f.db.exec(original);
   await f.db.exec('revoke all on function app.reminder_external_read_matches(invoices,uuid) from public,anon,authenticated,service_role');
  }
  await f.db.exec(await migration());
 }finally{await f.close()}
});

test('only the two audited approved CRLF predecessors are accepted without normalizing their bodies',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[file]});
 const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
 const signatures=[
  {sig:'public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)',lf:'ed0ea611b1367778031fe4c6d4e9b8e086e7eb3659a0764a1afaffa9a880ee23',crlf:'1f8e4b305c3442b429f273f165ee15abf4286e6c3cf10e39f616b466621dfd88'},
  {sig:'public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)',lf:'c579a14174d421dc6ac71452ef0ac7502ffebed1e5a2f18b6b1e08812849e1a1',crlf:'dc81b47567de1b6ed3a437c48317eee93f61aa31162b23e199fd17db8494d889'}];
 const definition=async sig=>(await f.db.query('select pg_get_functiondef(oid) d,prosrc from pg_proc where oid=$1::regprocedure',[sig])).rows[0];
 try{
  const base=await definition(signatures[0].sig);
  // Reconstruct from the approved main migration, not supplied production text.
  for(const name of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql'])
   await f.db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  for(const entry of signatures){
   const lf=await definition(entry.sig);assert.equal(digest(lf.d),entry.lf);
   assert.equal(lf.prosrc.includes('\r'),false);
   await f.db.exec(lf.d.replace(lf.prosrc,()=>lf.prosrc.replaceAll('\n','\r\n')));
   const crlf=await definition(entry.sig);
   assert.equal(digest(crlf.d),entry.crlf,'independently reproduce the exact reviewed raw hash');
   assert.equal(digest(crlf.d.replaceAll('\r\n','\n')),entry.lf);
   assert.equal(crlf.d.replaceAll('\r\n','\n'),lf.d,'CRLF is the sole source difference');
   assert.equal((crlf.prosrc.match(/\r\n/g)||[]).length,31);
   assert.equal(/[\r\n]/.test(crlf.prosrc.replaceAll('\r\n','')),false);
   entry.definition=crlf;
  }
  const business=await seedBusiness(f.db),businessBefore=await business();
  const before=(await state(f.db)).rows;
  const old=await readFile(new URL('./fixtures/external-reminder-containment-lf-only-predecessor.sql',import.meta.url),'utf8');
  assert.equal(Buffer.byteLength(old,'utf8'),6228);
  assert.equal(digest(old),'1beb8ed28d0e6f255dc210dc1f3d515f72ccb3da16ec8e5879228ede55eba6ee');
  await assert.rejects(f.db.exec(old),/predecessor source drift/);
  await f.db.exec('rollback');assert.deepEqual((await state(f.db)).rows,before,'published LF-only migration correctly refuses production-shaped CRLF');
  assert.deepEqual(await business(),businessBefore);
  const target=signatures[0],known=target.definition;
  const unknown=[
   known.d.replace(known.prosrc,()=>known.prosrc.replace('begin','begin -- content drift')),
   known.d.replace(known.prosrc,()=>known.prosrc.replace('\r\n','\n')),
   known.d.replace(known.prosrc,()=>known.prosrc+'\r\n'),
   base.d.replace(base.prosrc,()=>base.prosrc.replaceAll('\n','\r\n')),
  ];
  for(const drift of unknown){
   await f.db.exec(drift);
   const drifted=(await state(f.db)).rows;
   await assert.rejects(f.db.exec(await migration()),/predecessor source drift/);
   await f.db.exec('rollback');assert.deepEqual((await state(f.db)).rows,drifted);
   assert.deepEqual(await business(),businessBefore);
   await f.db.exec(known.d);
  }
  await f.db.exec(await migration());
  assert.deepEqual(await business(),businessBefore);
  const after=(await state(f.db)).rows,changed=[];
  assert.equal(after.length,before.length);
  for(let n=0;n<after.length;n++){
   const {definition:a,...securityA}=after[n],{definition:b,...securityB}=before[n];
   assert.deepEqual(securityA,securityB,'OID, owner, definer/invoker, search_path, ACL and other attributes preserved');
   if(a!==b)changed.push(after[n].proname);
  }
  assert.deepEqual(changed.sort(),['cetld_core_authorize_delivery','cetld_core_claim_due_followups','reminder_external_read_matches','reminder_local_status_payable']);
  for(const entry of signatures){
   const after=await definition(entry.sig);
   assert.equal((after.prosrc.match(/\r\n/g)||[]).length,31);
   assert.equal(/[\r\n]/.test(after.prosrc.replaceAll('\r\n','')),false);
   assert.notEqual(digest(after.d),entry.crlf,'only guarded containment edits change the body');
  }
 }finally{await f.close()}
});
