import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {createServer} from 'node:net';
import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';
import {OFFLINE_SQL_BOOTSTRAP} from './fixtures/offline-sql-network.mjs';

test('Supabase auth INSERT boundary gates password and Google account creation atomically',async t=>{
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const pg=await createNativePostgresFixture({port});let db,other;
 try{
  await pg.initialise();await pg.start();db=pg.getPgClient();other=pg.getPgClient();await db.connect();await other.connect();
  await db.query(OFFLINE_SQL_BOOTSTRAP);
  await db.query("create role supabase_auth_admin;alter table auth.users add column raw_app_meta_data jsonb default '{}';create unique index auth_email_unique on auth.users(lower(email));grant usage on schema auth to supabase_auth_admin;grant select,insert,update on auth.users to supabase_auth_admin;");
  await db.query(await readFile(new URL('../supabase/migrations/20260922090000_core_backend.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../supabase/migrations/20261120125758_signup_invites.sql',import.meta.url),'utf8'));
  const issue=async email=>{await db.query('set role service_role');try{return(await db.query('select issue_signup_invite($1) value',[email])).rows[0].value;}finally{await db.query('reset role');}};
  const prepare=async(email,code)=>{await db.query('set role anon');try{return await db.query('select prepare_signup_invite($1,$2)',[email,code]);}finally{await db.query('reset role');}};
  const insert=async(provider,email,code,client=db,extra={})=>{
   await client.query('begin');try{await client.query('set local role supabase_auth_admin');const r=await client.query('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,$2,$3,$4) returning *',[randomUUID(),email,{provider},{signup_invite_code:code,...extra}]);await client.query('commit');return r.rows[0];}catch(e){await client.query('rollback');throw e;}
  };
  const counts=async email=>(await db.query('select (select count(*)::int from auth.users where lower(email)=lower($1)) users,(select count(*)::int from profiles p join auth.users u on u.id=p.user_id where lower(u.email)=lower($1)) profiles,(select count(*)::int from workspaces w join auth.users u on u.id=w.owner_id where lower(u.email)=lower($1)) workspaces',[email])).rows[0];
  for(const provider of ['email','google']){
   await t.test(provider+'/valid email-bound code creates user/profile and consumes once',async()=>{
    const email=provider+'-valid@example.test',invite=await issue(' '+email.toUpperCase()+' ');
    if(provider==='google')await prepare(email,invite.code);
    const user=await insert(provider,email,invite.code);
    assert.equal(user.raw_user_meta_data.signup_invite_code,undefined);
    const row=(await db.query('select * from app.signup_invites where id=$1',[invite.id])).rows[0];
    assert.equal(row.consumed_by,user.id);assert.ok(row.consumed_at);assert.notEqual(row.code_hash.toString(),invite.code);
    assert.deepEqual(await counts(email),{users:1,profiles:1,workspaces:1});
    await db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[user.id]);
    await db.query('set role authenticated');try{assert.ok((await db.query('select id from workspaces where owner_id=$1',[user.id])).rows[0].id);await assert.rejects(db.query("select create_workspace('Uninvited second business',$1)",[randomUUID()]),/Access is by invite/);}finally{await db.query('reset role');}
    assert.equal((await counts(email)).workspaces,1);
    await assert.rejects(prepare(email,invite.code),/Access is by invite/);
    await assert.rejects(insert(provider,email,invite.code),/Access is by invite/);
    // Existing account access/token metadata updates never invoke INSERT gating.
    await db.query('set role supabase_auth_admin');try{assert.equal((await db.query("update auth.users set raw_user_meta_data='{}' where id=$1 returning id",[user.id])).rowCount,1);}finally{await db.query('reset role');}
   });
   for(const failure of ['missing','wrong-code','wrong-email','expired','revoked'])await t.test(provider+'/'+failure+' leaves no user/profile/workspace',async()=>{
    const email=provider+'-'+failure+'@example.test',invite=await issue(email);let target=email,code=invite.code;
    if(failure==='missing')code=undefined;
    if(failure==='wrong-code')code='0'.repeat(64);
    if(failure==='wrong-email')target='other-'+email;
    if(failure==='expired')await db.query("update app.signup_invites set expires_at=now()-interval '1 second' where id=$1",[invite.id]);
    if(failure==='revoked')await issue(email);
    if(provider==='google')await assert.rejects(prepare(target,code),/Access is by invite/);
    await assert.rejects(insert(provider,target,code),/Access is by invite/);
    assert.deepEqual(await counts(target),{users:0,profiles:0,workspaces:0});
   });
  }
  await t.test('Google cannot bypass preparation or transfer its admission to another email',async()=>{
   const email='google-owner@example.test',invite=await issue(email);
   await assert.rejects(insert('google',email,invite.code),/Access is by invite/);
   await prepare(email,invite.code);
   await assert.rejects(insert('google','other-google@example.test',invite.code),/Access is by invite/);
   await db.query("update app.signup_invites set google_authorized_until=now()-interval '1 second' where id=$1",[invite.id]);
   await assert.rejects(insert('google',email,invite.code),/Access is by invite/);
  });
  await t.test('editable metadata cannot impersonate Google or manufacture invitation authority',async()=>{
   const email='metadata@example.test',invite=await issue(email);await prepare(email,invite.code);
   await assert.rejects(insert('email',email,undefined,db,{provider:'google',invited:true}),/Access is by invite/);
   await assert.rejects(insert('anonymous',email,invite.code),/Access is by invite/);
  });
  await t.test('rollback of a failed account leaves its invite reusable',async()=>{
   const email='rollback@example.test',invite=await issue(email);
   await db.query("create function app.reject_fixture_user() returns trigger language plpgsql as $$begin raise exception 'fixture downstream failure';end$$;create trigger z_reject_fixture_user after insert on auth.users for each row execute function app.reject_fixture_user()");
   await assert.rejects(insert('email',email,invite.code),/fixture downstream failure/);
   assert.equal((await db.query('select consumed_at from app.signup_invites where id=$1',[invite.id])).rows[0].consumed_at,null);
   assert.deepEqual(await counts(email),{users:0,profiles:0,workspaces:0});await db.query('drop trigger z_reject_fixture_user on auth.users');
   assert.ok((await insert('email',email,invite.code)).id);
  });
  for(const provider of ['email','google'])await t.test(provider+'/two concurrent uses commit exactly one user and one consumption',async()=>{
   const email=provider+'-concurrent@example.test',invite=await issue(email);if(provider==='google')await prepare(email,invite.code);
   const results=await Promise.allSettled([insert(provider,email,invite.code,db),insert(provider,email,invite.code,other)]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
   assert.equal((await counts(email)).users,1);
  });
  await t.test('clients cannot issue or inspect invite codes',async()=>{
   for(const role of ['anon','authenticated']){await db.query('set role '+role);try{
    await assert.rejects(db.query("select issue_signup_invite('self@example.test')"),{code:'42501'});
    await assert.rejects(db.query('select * from app.signup_invites'),{code:'42501'});
   }finally{await db.query('reset role');}}
  });
 }finally{if(other)await other.end().catch(()=>{});if(db)await db.end().catch(()=>{});await pg.stop();}
});
