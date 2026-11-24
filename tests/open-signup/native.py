import pathlib,subprocess,tempfile,time,os
root=pathlib.Path(__file__).resolve().parents[2];b=pathlib.Path(os.environ['POSTGRES_BIN']);d=pathlib.Path(tempfile.mkdtemp(prefix='cetld-open-synthetic-'));subprocess.run([str(b/'initdb'),'-D',str(d/'data'),'-U','fixture','-A','trust','--no-locale'],check=True,capture_output=True);log=open(d/'log','w');p=subprocess.Popen([str(b/'postgres'),'-D',str(d/'data'),'-h','127.0.0.1','-p','6544','-k',str(d)],stdout=log,stderr=log)
try:
 for i in range(60):
  if subprocess.run(['psql','postgresql://fixture@127.0.0.1:6544/postgres','-c','select 1'],capture_output=True).returncode==0:break
  time.sleep(.1)
 function=(root/'supabase/migrations/20261124091000_open_verified_signup.sql').read_text().split('create or replace function app.require_workspace_invite()')[1].split('-- Name kept')[0]
 setup="""create schema auth;create schema app;create role anon;create role authenticated;create role service_role;create table auth.users(id uuid primary key,email_confirmed_at timestamptz);create table public.workspaces(id uuid primary key default gen_random_uuid(),owner_id uuid,name text,slug text,created_at timestamptz default now());create table public.workspace_members(workspace_id uuid,user_id uuid,role text);create table public.workspace_settings(workspace_id uuid,business_name text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;"""
 rpc=__import__('json').load(open(root/'tests/open-signup/live-workspace-rpc.json'))[0]['detail']
 tests="""create trigger require_workspace_invite before insert on public.workspaces for each row execute function app.require_workspace_invite();
insert into auth.users values('11111111-1111-4111-8111-111111111111',now()),('22222222-2222-4222-8222-222222222222',null);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select app.create_workspace('verified business',null);
do $$begin begin insert into public.workspaces(owner_id) values('22222222-2222-4222-8222-222222222222');raise exception 'foreign accepted';exception when insufficient_privilege then null;end;end$$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
do $$begin begin perform app.create_workspace('unverified business',null);raise exception 'unverified accepted';exception when insufficient_privilege then null;end;end$$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
insert into public.workspaces(owner_id) select '11111111-1111-4111-8111-111111111111'::uuid from generate_series(1,9);
do $$begin begin insert into public.workspaces(owner_id) values('11111111-1111-4111-8111-111111111111');raise exception 'cap ignored';exception when program_limit_exceeded then null;end;end$$;
select count(*) as expected_ten_only from workspaces;
grant usage on schema public,app,auth to anon,service_role;grant insert on public.workspaces to anon,service_role;
select set_config('request.jwt.claim.sub','',false);
set role anon;
do $$begin begin insert into public.workspaces(owner_id) values('11111111-1111-4111-8111-111111111111');raise exception 'anon accepted';exception when insufficient_privilege then null;end;end$$;
reset role;set role service_role;
do $$begin begin insert into public.workspaces(owner_id) values('11111111-1111-4111-8111-111111111111');raise exception 'service role accepted';exception when insufficient_privilege then null;end;end$$;
reset role;
"""
 q=d/'test.sql';q.write_text(setup+rpc+';\n'+'create or replace function app.require_workspace_invite()'+function+tests);r=subprocess.run(['psql','postgresql://fixture@127.0.0.1:6544/postgres','-v','ON_ERROR_STOP=1','-f',str(q)],capture_output=True,text=True);print(r.stdout,r.stderr);r.check_returncode();print('PASS verified-owner allowed, foreign-owner rejected, unverified rejected, per-account cap enforced; real RPC owner/membership/settings; anon/service_role rejected')
finally:p.terminate();p.wait(timeout=10);log.close()
