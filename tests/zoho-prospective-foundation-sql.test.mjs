import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

const file='20261026110000_zoho_prospective_operation_foundation.sql';
const sql=()=>readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const digest="encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')";
const catalog=db=>db.query(`select p.oid,n.nspname,p.proname,pg_get_functiondef(p.oid) d,to_jsonb(p)-'prosrc' security
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app') order by p.oid`);

async function fixture(){
 const f=await createOfflineSqlNetwork({excludeMigrations:[file]});
 const owner=randomUUID(),member=randomUUID(),foreign=randomUUID();
 await f.db.query('insert into auth.users(id) values($1),($2),($3)',[owner,member,foreign]);
 const role=async(name='service_role',user='')=>{await f.db.exec('reset role');await f.db.query("select set_config('request.jwt.claim.role',$1,false),set_config('request.jwt.claim.sub',$2,false)",[name,user]);};
 await role('authenticated',owner);
 const ws=(await f.db.query('select (create_workspace($1,$2)).id',['Foundation',randomUUID()])).rows[0].id;
 const ws2=(await f.db.query('select (create_workspace($1,$2)).id',['Other workspace',randomUUID()])).rows[0].id;
 await f.db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'member')",[ws,member]);
 await role();
 const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Offline fixture') returning id",[ws])).rows[0].id;
 const invoice=async(extra={})=>(await f.db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount${extra.raw?'':',status'},metadata${extra.provider?',external_provider,external_invoice_id':''})
  values($1,$2,$3,current_date,current_date,'USD',5${extra.raw?'':",'sent'"},$4${extra.provider?',$5,$6':''}) returning *`,[ws,customer,'FIXTURE-'+randomUUID(),{invoice_direction:'receivable',...extra.metadata},...(extra.provider?[extra.provider,extra.externalId]:[])])).rows[0];
 const connection=async(account='fixture-A')=>f.db.query(`insert into cetld_accounting_connections(owner_id,workspace_id,provider,provider_account_id,region,api_domain,accounts_domain,token_ciphertext,token_iv,token_tag,token_expires_at)
 values($1,$2,'zoho_books',$3,'in','https://www.zohoapis.in','https://accounts.zoho.in','fixture-cipher','fixture-iv','fixture-tag',now()+interval '1 hour')`,[owner,ws,account]);
 const context=async()=>(await f.db.query('select cetld_zoho_operation_context($1,$2) value',[owner,ws])).rows[0].value;
 const reserve=async(row,epoch=null,scope={})=>(await f.db.query('select cetld_reserve_zoho_export_operation($1,$2,$3,$4,$5,$6) value',
  [scope.owner||owner,scope.ws||ws,row.id,row.updated_at,row.automation_version,epoch||((await context())?.epochId)||randomUUID()])).rows[0].value;
 const transition=async(row,op,action,outcome=null,scope={})=>(await f.db.query('select cetld_transition_zoho_export_operation($1,$2,$3,$4,$5,$6) value',
  [scope.owner||owner,scope.ws||ws,row.id,op.operationId,action,outcome])).rows[0].value;
 const business=async()=>Promise.all(['invoices','customers','payments','cetld_accounting_connections','cetld_accounting_sync_records','cetld_core_automation_delivery_claims','owner_assistant_proposals','whatsapp_pending_actions','whatsapp_messages']
  .map(async table=>(await f.db.query(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows));
 const legacy=await invoice();await connection();
 const lifecycle=async(action,row,proposal=null)=>{
  await role('authenticated',owner);
  const result=(await f.db.query("select invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",
   [action,ws,proposal?null:row.id,proposal,`dashboard_foundation_${randomUUID()}`,`foundation-${randomUUID()}`])).rows[0].value;
  await role();return result;
 };
 const remove=async row=>{const prepared=await lifecycle('prepare',row);assert.equal(prepared.ok,true);const deleted=await lifecycle('confirm',row,prepared.proposalId);assert.equal(deleted.action,'deleted');};
 return {...f,owner,member,foreign,ws,ws2,customer,role,invoice,connection,context,reserve,transition,business,legacy,lifecycle,remove};
}

test('prospective install has no backfill/business DML; only refresh implementation changes, PR200 gates/security stay exact',async()=>{
 const f=await fixture();
 try{
  const before=(await catalog(f.db)).rows,business=await f.business();
  await f.db.exec(await sql());
  assert.deepEqual(await f.business(),business);
  assert.equal((await f.db.query('select count(*) n from app.accounting_invoice_admissions')).rows[0].n,0);
  assert.equal((await f.db.query('select count(*) n from app.accounting_connection_epochs')).rows[0].n,0);
  const after=(await catalog(f.db)).rows,changed=[];
  for(const old of before){const now=after.find(r=>r.oid===old.oid);assert.deepEqual(now.security,old.security);if(now.d!==old.d)changed.push(old.proname);}
  assert.deepEqual(changed,['cetld_update_accounting_connection_tokens']);
  await f.db.query("update invoices set created_at=now()+interval '1 day',metadata=metadata||'{\"bookkeeping_sync_attempts\":0,\"verified\":true}' where id=$1",[f.legacy.id]);
  assert.equal((await f.reserve((await f.db.query('select * from invoices where id=$1',[f.legacy.id])).rows[0])).state,'not_admitted');
  assert.equal(await f.context(),null,'read/refresh does not initialize old connections');
  await f.role('authenticated',f.owner);await f.db.exec('set role authenticated');
  const newRow=await f.invoice({raw:true,metadata:{verified:true,provider_account_binding:{account:'fixture-A',immutable:true}}});
  await f.role();
  await f.db.query("update invoices set status='sent' where id=$1",[newRow.id]);
  const admission=(await f.db.query('select * from app.accounting_invoice_admissions where invoice_id=$1',[newRow.id])).rows[0];
  assert.equal(admission.local_export_candidate,true);assert.equal(admission.owner_id,f.owner);
  await f.role('authenticated',f.member);await f.db.exec('set role authenticated');
  const memberRow=await f.invoice({raw:true});await f.role();
  assert.equal((await f.db.query('select owner_id from app.accounting_invoice_admissions where invoice_id=$1',[memberRow.id])).rows[0].owner_id,f.owner,'workspace owner comes from DB, not the inserting member');
  const imported=await f.invoice({provider:'zoho_books',externalId:'fixture-same-id'});
  assert.equal((await f.reserve(imported)).state,'not_admitted');
  // No JSON, journal or diagnostic output can change the contained authority.
  await f.db.query("select set_config('app.reminder_external_read',$1,false)",[JSON.stringify({verified:true,provenance:'verified',currentAccountId:'fixture-A',externalId:'fixture-same-id'})]);
  assert.equal((await f.db.query('select app.reminder_external_read_matches(i,$2) ok from invoices i where id=$1',[imported.id,f.owner])).rows[0].ok,false);
  assert.equal((await f.db.query('select app.reminder_local_status_payable(i) ok from invoices i where id=$1',[newRow.id])).rows[0].ok,true);
  for(const name of ['anon','authenticated','service_role']){
   await f.role(name,name==='authenticated'?f.owner:'');await f.db.exec(`set role ${name}`);
   for(const table of ['accounting_invoice_admissions','accounting_connection_epochs','accounting_refresh_permits','zoho_export_operations']){
    await assert.rejects(f.db.exec(`select * from app.${table}`),/permission denied/);
    await assert.rejects(f.db.exec(`delete from app.${table}`),/permission denied/);
    await assert.rejects(f.db.exec(`insert into app.${table} default values`),/permission denied/);
    await assert.rejects(f.db.exec(`update app.${table} set ${table==='zoho_export_operations'?"state='finished'":table==='accounting_invoice_admissions'?'local_export_candidate=true':table==='accounting_connection_epochs'?'epoch_id=gen_random_uuid()':'revision=1'}`),/permission denied/);
   }
   if(name!=='service_role'){
    await assert.rejects(f.context(),/permission denied/);
    await assert.rejects(f.reserve(newRow),/permission denied/);
    await assert.rejects(f.transition(newRow,{operationId:randomUUID()},'start'),/permission denied/);
   }
  }
  await f.role();
  const security=await f.db.query("select relname,relrowsecurity,relacl from pg_class where relnamespace='app'::regnamespace and relname in ('accounting_invoice_admissions','accounting_connection_epochs','accounting_refresh_permits','zoho_export_operations')");
  assert.equal(security.rows.length,4);assert.ok(security.rows.every(r=>r.relrowsecurity));
 }finally{await f.close();}
});

test('server epoch survives real refresh RPC, rotates on selection/away-back/credential replacement/delete/reconnect; caller cannot choose it',async()=>{
 const f=await fixture();
 try{
  await f.db.exec(await sql());
  const refresh=async()=>{
   const lease=randomUUID(),revision=(await f.db.query('select revision from cetld_accounting_connections where workspace_id=$1',[f.ws])).rows[0].revision;
   await f.db.query("select * from cetld_claim_accounting_connection_refresh($1,$2,'zoho_books',$3,30000)",[f.owner,f.ws,lease]);
   return f.db.query("select * from cetld_update_accounting_connection_tokens($1,$2,'zoho_books',$3,$4,'rotated-cipher','rotated-iv','rotated-tag',now()+interval '1 hour',null,null,null)",[f.owner,f.ws,revision,lease]);
  };
  await refresh();assert.equal(await f.context(),null,'ordinary refresh cannot enroll a historical connection');
  const legacyLease=randomUUID(),legacyRevision=(await f.db.query('select revision from cetld_accounting_connections')).rows[0].revision;
  await f.db.query("select * from cetld_claim_accounting_connection_refresh($1,$2,'zoho_books',$3,30000)",[f.owner,f.ws,legacyLease]);
  await f.db.query("select * from cetld_update_accounting_connection_tokens($1,$2,'zoho_books',$3,$4,'legacy-rotated','legacy-iv','legacy-tag',now()+interval '1 hour',null,null,'com')",[f.owner,f.ws,legacyRevision,legacyLease]);
  assert.equal(await f.context(),null,'refresh cannot initialize an epoch by filling/changing regional metadata');
  await f.db.query('update cetld_accounting_connections set revision=revision+1 where workspace_id=$1',[f.ws]);
  const first=await f.context();assert.ok(first.epochId);await refresh();assert.deepEqual(await f.context(),first);
  assert.equal((await f.db.query('select count(*) n from app.accounting_refresh_permits')).rows[0].n,0);
  for(const patch of ["provider_account_id='fixture-B',revision=revision+1","provider_account_id='fixture-A',revision=revision+1",
   "provider_account_id=provider_account_id,revision=revision+1","token_ciphertext='reconsent-cipher'","region='com',api_domain='https://www.zohoapis.com'"]){
   const before=await f.context();await f.db.query(`update cetld_accounting_connections set ${patch} where workspace_id=$1`,[f.ws]);
   assert.notEqual((await f.context()).epochId,before.epochId);
  }
  const old=await f.context();const generation=(await f.db.query('select generation from app.accounting_connection_epochs')).rows[0].generation;
  await f.db.query('delete from cetld_accounting_connections where workspace_id=$1',[f.ws]);assert.equal(await f.context(),null);
  await f.connection();assert.notEqual((await f.context()).epochId,old.epochId);
  assert.equal(Number((await f.db.query('select generation from app.accounting_connection_epochs')).rows[0].generation),Number(generation)+2);
  assert.equal(Number((await f.db.query('select revision from cetld_accounting_connections')).rows[0].revision),1);
 }finally{await f.close();}
});

test('operation reserve/start/finish is scoped, single-use, fingerprint/epoch checked; every result remains unverified',async()=>{
 const f=await fixture();
 try{
  await f.db.exec(await sql());await f.db.query('update cetld_accounting_connections set revision=revision+1 where workspace_id=$1',[f.ws]);
  const row=await f.invoice();
  for(const scope of [{owner:f.foreign},{owner:f.member},{ws:f.ws2}])await assert.rejects(f.reserve(row,null,scope),/ZOHO_OPERATION_SCOPE/);
  await assert.rejects(f.reserve(row,randomUUID()),/ZOHO_OPERATION_CONNECTION_CHANGED/);
  await assert.rejects(f.reserve({...row,automation_version:Number(row.automation_version)+1}),/ZOHO_OPERATION_INVOICE_CHANGED/);
  const op=await f.reserve(row);assert.equal(op.state,'reserved');assert.equal(op.provenance,'unverified');
  assert.equal((await f.reserve(row)).state,'retry_unverified');
  await assert.rejects(f.transition(row,{operationId:randomUUID()},'start'),/ZOHO_OPERATION_UNKNOWN/);
  await assert.rejects(f.transition(row,op,'finish','created_unverified'),/ZOHO_OPERATION_NOT_DISPATCHED/);
  for(const scope of [{owner:f.foreign},{owner:f.member},{ws:f.ws2}])await assert.rejects(f.transition(row,op,'start',null,scope),/ZOHO_OPERATION_SCOPE/);
  await assert.rejects(f.transition(row,op,'finish','verified'),/ZOHO_OPERATION_INPUT/);
  // A real ordinary credential refresh between reservation and start must not
  // erase the intended operation epoch or manufacture a second operation.
  const oldEpoch=(await f.context()).epochId,lease=randomUUID();
  const revision=(await f.db.query('select revision from cetld_accounting_connections where workspace_id=$1',[f.ws])).rows[0].revision;
  await f.db.query("select * from cetld_claim_accounting_connection_refresh($1,$2,'zoho_books',$3,30000)",[f.owner,f.ws,lease]);
  await f.db.query("select * from cetld_update_accounting_connection_tokens($1,$2,'zoho_books',$3,$4,'fresh','fresh-iv','fresh-tag',now()+interval '1 hour',null,null,null)",[f.owner,f.ws,revision,lease]);
  assert.equal((await f.context()).epochId,oldEpoch);
  await f.db.exec("set timezone='Pacific/Auckland'");
  assert.equal((await f.transition(row,op,'start')).state,'dispatched');
  await f.db.exec("set timezone='UTC'");
  await assert.rejects(f.transition(row,op,'start'),/ZOHO_OPERATION_NOT_RESERVED/);
  const before=await f.business();
  assert.equal((await f.transition(row,op,'finish','created_unverified')).provenance,'unverified');
  assert.equal((await f.transition(row,op,'finish','created_unverified')).state,'replay_unverified');
  await assert.rejects(f.transition(row,op,'finish','duplicate_unverified'),/ZOHO_OPERATION_NOT_DISPATCHED/);
  assert.deepEqual(await f.business(),before,'journal transitions never link/edit/import/queue/send');
  for(const change of ['lease','account','away_back','reconnect','linked','deleted','timeout']){
   const i=await f.invoice(),o=await f.reserve(i);await f.transition(i,o,'start');
   if(change==='lease')await f.db.query("update invoices set metadata=metadata||'{\"bookkeeping_sync_attempted_at\":\"changed\"}' where id=$1",[i.id]);
   if(change==='account'||change==='away_back'){
    await f.db.query("update cetld_accounting_connections set provider_account_id='fixture-B',revision=revision+1 where workspace_id=$1",[f.ws]);
    if(change==='away_back')await f.db.query("update cetld_accounting_connections set provider_account_id='fixture-A',revision=revision+1 where workspace_id=$1",[f.ws]);
   }
   if(change==='reconnect'){await f.db.query('delete from cetld_accounting_connections where workspace_id=$1',[f.ws]);await f.connection();}
   if(change==='linked')await f.db.query("update invoices set external_provider='zoho_books',external_invoice_id='same-id' where id=$1",[i.id]);
   if(change==='deleted')await f.remove(i);
   if(change==='timeout')await f.db.query("update app.zoho_export_operations set reserved_at=now()-interval '3 minutes' where operation_id=$1",[o.operationId]);
   assert.equal((await f.transition(i,o,'finish','created_unverified')).state,'invalidated',change);
  }
  const retired=await f.invoice();await f.remove(retired);
  assert.equal((await f.lifecycle('undo',retired)).action,'restored');
  assert.equal((await f.reserve((await f.db.query('select * from invoices where id=$1',[retired.id])).rows[0])).state,'not_admitted');
  const oldWorker=await f.invoice();
  await f.db.query("update invoices set external_provider='zoho_books',external_invoice_id='old-worker-link' where id=$1",[oldWorker.id]);
  await assert.rejects(f.reserve((await f.db.query('select * from invoices where id=$1',[oldWorker.id])).rows[0]),/ZOHO_OPERATION_INVOICE_CHANGED/);
  assert.equal((await f.db.query('select count(*) n from app.zoho_export_operations where invoice_id=$1',[oldWorker.id])).rows[0].n,0);
  assert.equal((await f.db.query('select app.reminder_external_read_matches(i,$2) ok from invoices i where id=$1',[oldWorker.id,f.owner])).rows[0].ok,false);
 }finally{await f.close();}
});

test('exact contained approved CRLF predecessors are preserved; unknown source/ACL drift aborts before objects',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[file,'20261026090000_contain_unproven_external_reminders.sql']});
 try{
  for(const name of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql'])await f.db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  for(const sig of ['cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)','cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)']){
   const p=(await f.db.query('select pg_get_functiondef(oid) d,prosrc from pg_proc where oid=$1::regprocedure',[sig])).rows[0];await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc.replaceAll('\n','\r\n')));
  }
  await f.db.exec(await readFile(new URL('../supabase/migrations/20261026090000_contain_unproven_external_reminders.sql',import.meta.url),'utf8'));
  await f.db.exec('set search_path=pg_catalog,public');
  const before=(await catalog(f.db)).rows;
  const gate=before.find(r=>r.proname==='cetld_core_authorize_delivery');
  const hashes=(await f.db.query(`select ${digest} hash from pg_proc p where proname in ('cetld_core_claim_due_followups','cetld_core_authorize_delivery') order by proname`)).rows.map(r=>r.hash);
  assert.deepEqual(hashes,['a642cdbd4d09e1aab02e2f02f21e3faf9948e40415520f187a87fb8bb121a8df','7682bf8e74ce798442b3054f4672e888c952dce4fce70c31a80554606e1ab6ef']);
  for(const drift of ['content','ending','acl','owner','connection_acl','default_acl','default_table_acl']){
   if(drift==='content')await f.db.exec(gate.d.replace('begin','begin -- unknown drift'));
   if(drift==='ending')await f.db.exec(gate.d.replace('\r\n','\n'));
   if(drift==='acl')await f.db.exec('grant execute on function cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) to authenticated');
   if(drift==='owner')await f.db.exec('alter function cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) owner to authenticated');
   if(drift==='connection_acl')await f.db.exec('grant select(provider_account_id) on cetld_accounting_connections to authenticated');
   if(drift==='default_acl'||drift==='default_table_acl'){
    await f.db.exec('create role fixture_unexpected_grantee');
    await f.db.exec(`alter default privileges in schema app grant ${drift==='default_acl'?'execute on functions':'select on tables'} to fixture_unexpected_grantee`);
   }
   await assert.rejects(f.db.exec(await sql()),/foundation (?:predecessor (?:source|ACL|owner\/ACL) drift|connection protection drift|new (?:function|table) ACL\/owner drift)/);await f.db.exec('rollback');
   assert.equal((await f.db.query("select to_regclass('app.accounting_invoice_admissions') t")).rows[0].t,null);
   await f.db.exec('alter function cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) owner to postgres');
   await f.db.exec(gate.d);await f.db.exec('revoke execute on function cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) from authenticated');
   await f.db.exec('revoke select(provider_account_id) on cetld_accounting_connections from authenticated');
   if(drift==='default_acl'||drift==='default_table_acl'){
    await f.db.exec(`alter default privileges in schema app revoke ${drift==='default_acl'?'execute on functions':'select on tables'} from fixture_unexpected_grantee`);
    await f.db.exec('drop role fixture_unexpected_grantee');
   }
  }
  await f.db.exec(await sql());
  const after=(await catalog(f.db)).rows;
  for(const old of before.filter(r=>r.proname!=='cetld_update_accounting_connection_tokens'))assert.deepEqual(after.find(r=>r.oid===old.oid),old,'including exact CRLF bodies and security');
 }finally{await f.close();}
});
