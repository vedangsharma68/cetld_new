import {readdir,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {releaseTestEnvironment} from './check-owner-chat-gate.mjs';
export function releaseShardFiles(files,index,count){
 if(!Number.isInteger(index)||!Number.isInteger(count)||count<1||index<0||index>=count)throw Error('invalid shard');
 return [...files].filter(f=>/\.test\.(?:mjs|ts)$/.test(f)).sort().filter((_,i)=>i%count===index);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const index=Number(process.argv[2]),count=Number(process.argv[3]),all=await readdir('tests'),selected=releaseShardFiles(all,index,count);if(!selected.length)throw Error('empty shard');
 console.log(JSON.stringify({shard:index,count,totalFiles:all.filter(f=>/\.test\.(?:mjs|ts)$/.test(f)).length,selected}));
 const cache=await mkdtemp(path.join(tmpdir(),'cetld-release-shard-'));
 try{const r=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=2',...selected.map(f=>'tests/'+f)],{stdio:'inherit',env:releaseTestEnvironment(process.env,{CETLD_SQL_FIXTURE_CACHE_DIR:cache})});process.exitCode=r.status??1;}finally{await rm(cache,{recursive:true,force:true});}
}
