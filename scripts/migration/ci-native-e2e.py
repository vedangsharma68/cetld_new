import json
"""Run the same complete native proof matrix as the local fresh-db runner."""
import os,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
env=os.environ.copy();env.update(DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:6543/postgres',DIRECT_URL='postgresql://fixture:fixture@127.0.0.1:5432/postgres',APP_URL='http://127.0.0.1:3107',APP_ENV='test')
encoding=subprocess.check_output(['psql',env['DATABASE_URL'],'-At','-c','show server_encoding'],env=env,text=True).strip()
if encoding!='UTF8':raise RuntimeError('Native proof database must use UTF8 like the hosted database')
for file in sorted((root/'src/server/db/migrations').glob('*.sql')):subprocess.run(['psql',env['DATABASE_URL'],'-v','ON_ERROR_STOP=1','-f',str(file)],check=True,capture_output=True)
subprocess.run(['node','--conditions=react-server','--import','tsx','scripts/migration/seed-local-test.ts'],cwd=root,env=env,check=True)
for proof in json.loads((root/'scripts/migration/native-proof-matrix.json').read_text()):
 subprocess.run(['node','--conditions=react-server','--import','tsx','scripts/migration/run-native-proof.ts',proof],cwd=root,env=env,check=True)
for command in [['npm','run','build'],['npm','run','test:e2e']]:subprocess.run(command,cwd=root,env=env,check=True)
