"""Run with POSTGRES_BIN pointing to an installed PostgreSQL bin directory.
Uses only a new temporary loopback database with synthetic fixture data.
No hosted connection, credentials or Docker needed. Requires psql and npm.
"""
import pathlib,subprocess,os,time,tempfile,sys
root=pathlib.Path(__file__).resolve().parents[2]
bindir=pathlib.Path(os.environ['POSTGRES_BIN'])
data=pathlib.Path(tempfile.mkdtemp(prefix='cetld-next-synthetic-pg-'))/'data'
env=os.environ.copy();env.update(DATABASE_URL='postgresql://fixture@127.0.0.1:6543/postgres',DIRECT_URL='postgresql://fixture@127.0.0.1:5432/postgres',SUPABASE_URL='https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY='synthetic-test-only',AUTH_SECRET='synthetic-test-only-secret-32-characters',AUTH_GOOGLE_ID='synthetic-test',AUTH_GOOGLE_SECRET='synthetic-test',APP_URL='http://127.0.0.1:3107',APP_ENV='test',LOG_LEVEL='silent',NEXT_TELEMETRY_DISABLED='1')
subprocess.run([str(bindir/'initdb'),'-D',str(data),'-U','fixture','-A','trust','--no-locale'],check=True,capture_output=True)
log=open(data.parent/'postgres.log','w');pg=subprocess.Popen([str(bindir/'postgres'),'-D',str(data),'-h','127.0.0.1','-p','6543','-k',str(data.parent)],stdout=log,stderr=log)
try:
 for _ in range(50):
  if pg.poll() is not None:raise RuntimeError('Synthetic DB failed to start; no tests run')
  result=subprocess.run(['psql',env['DATABASE_URL'],'-c','select 1'],capture_output=True)
  if result.returncode==0:break
  time.sleep(.1)
 else:raise RuntimeError('Synthetic DB unavailable')
 for file in sorted((root/'src/server/db/migrations').glob('*.sql')):subprocess.run(['psql',env['DATABASE_URL'],'-v','ON_ERROR_STOP=1','-f',str(file)],check=True,capture_output=True)
 subprocess.run(['node','--conditions=react-server','--import','tsx','scripts/migration/seed-local-test.ts'],cwd=root,env=env,check=True)
 if '--browser-only' not in sys.argv:
  proofs = [sys.argv[sys.argv.index('--proof')+1]] if '--proof' in sys.argv else ['auth','import','lifecycle','financial-preservation','settings-constraints','financial-history','number-parity']
  for proof in proofs:
   subprocess.run(['node','--conditions=react-server','--import','tsx','scripts/migration/run-native-proof.ts',proof],cwd=root,env=env,check=True)
 if '--native-only' not in sys.argv:
  commands = [['npm','run','test:e2e']] if '--use-existing-build' in sys.argv else [['npm','run','build'],['npm','run','test:e2e']]
  for command in commands:subprocess.run(command,cwd=root,env=env,check=True)
finally:
 pg.terminate()
 try:pg.wait(timeout=10)
 except subprocess.TimeoutExpired:pg.kill();pg.wait()
 log.close()
