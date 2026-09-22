import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const modulePath=process.env.PGLITE_MODULE;
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
test('Postgres installation, payment gates, permissions and accounting CAS',{skip:!modulePath},async()=>{
  const {PGlite}=await import(modulePath);const db=new PGlite();
  try{
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema public,auth to anon,authenticated,service_role;
      create table public.cetld_workspaces(id uuid primary key,owner_id uuid not null references auth.users(id));
      create table public.cetld_invoices(id uuid primary key,owner_id uuid not null references auth.users(id),workspace_id uuid not null references public.cetld_workspaces(id),amount_minor bigint not null,paid_minor bigint not null default 0,followup_state text not null,next_follow_up_at timestamptz);
      grant select,update on public.cetld_invoices to service_role;
      grant select on public.cetld_workspaces to authenticated,service_role;
      insert into auth.users values ('${id(1)}'),('${id(2)}');
      insert into public.cetld_workspaces values ('${id(3)}','${id(1)}'),('${id(4)}','${id(2)}');
      insert into public.cetld_invoices values ('${id(5)}','${id(1)}','${id(3)}',1000,0,'approved',now()-interval '1 minute');`);
    for(const path of ['automation_persistence','accounting_integrations']) await db.exec(await readFile(new URL(`../supabase/install/${path}.sql`,import.meta.url),'utf8'));
    // Idempotent installs are safe to re-run before adopting into core migrations.
    for(const path of ['automation_persistence','accounting_integrations']) await db.exec(await readFile(new URL(`../supabase/install/${path}.sql`,import.meta.url),'utf8'));
    await db.exec('set role service_role');
    const claims=await db.query(`select * from cetld_claim_due_followups('${id(1)}','${id(3)}')`);assert.equal(claims.rows.length,1);
    assert.equal((await db.query(`select * from cetld_claim_due_followups('${id(1)}','${id(3)}')`)).rows.length,0);
    const claim=claims.rows[0].claim_id;
    await db.query(`update cetld_invoices set paid_minor=amount_minor where id='${id(5)}'`);
    assert.equal((await db.query(`select * from cetld_authorize_follow_up_delivery('${claim}','${id(1)}','${id(3)}')`)).rows[0].authorized,false);
    await db.query(`update cetld_invoices set paid_minor=0,next_follow_up_at=now()-interval '2 minutes' where id='${id(5)}'`);
    const second=(await db.query(`select * from cetld_claim_due_followups('${id(1)}','${id(3)}')`)).rows[0];
    const auth=(await db.query(`select * from cetld_authorize_follow_up_delivery('${second.claim_id}','${id(1)}','${id(3)}')`)).rows[0];assert.equal(auth.authorized,true);
    assert.equal((await db.query(`select * from cetld_mark_follow_up_sent('${second.claim_id}','${id(1)}','${id(3)}','${auth.token}','provider-1')`)).rows[0].ok,true);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(db.query(`select * from cetld_accounting_connections`),/permission denied/);
    await assert.rejects(db.query(`select * from cetld_claim_due_followups('${id(1)}','${id(3)}')`),/permission denied/);
    await db.exec('reset role; set role service_role');
    await db.query(`insert into cetld_accounting_connections(owner_id,workspace_id,provider,token_ciphertext,token_iv,token_tag,token_expires_at) values ('${id(1)}','${id(3)}','quickbooks','cipher','iv','tag',now())`);
    assert.equal((await db.query(`select * from cetld_claim_accounting_connection_refresh('${id(1)}','${id(3)}','quickbooks','lease')`)).rows[0].claimed,true);
    assert.equal((await db.query(`select * from cetld_claim_accounting_connection_refresh('${id(1)}','${id(3)}','quickbooks','other')`)).rows[0].claimed,false);
    assert.equal((await db.query(`select * from cetld_update_accounting_connection_tokens('${id(1)}','${id(3)}','quickbooks',1,'wrong','cipher2','iv2','tag2',now())`)).rows.length,0);
    assert.equal((await db.query(`select * from cetld_update_accounting_connection_tokens('${id(1)}','${id(3)}','quickbooks',1,'lease','cipher2','iv2','tag2',now())`)).rows.length,1);
  }finally{await db.close();}
});
