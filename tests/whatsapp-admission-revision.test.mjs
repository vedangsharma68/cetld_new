import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,cp,copyFile,readFile,writeFile,symlink,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
test('forward admission generation preserves immutable capture and rejects capture, historical SQL or runtime revision drift',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'cetld-admission-revision-'));
 const original='supabase/migrations/20261101120327_private_whatsapp_chat_memory.sql',previous='supabase/migrations/20261121212253_whatsapp_admission_recovery.sql';
 const {forwardAdmissionMigration:forward}=JSON.parse(await readFile('scripts/private-capture-baseline.json','utf8'));
 try{
  await mkdir(path.join(root,'scripts'),{recursive:true});await mkdir(path.join(root,'supabase/migrations'),{recursive:true});await mkdir(path.join(root,'automation/whatsapp'),{recursive:true});
  await cp('ai',path.join(root,'ai'),{recursive:true});await symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');
  for(const file of [original,previous,forward,'package-lock.json','scripts/generate-private-value-sql.mjs','scripts/private-capture-baseline.json','automation/whatsapp/admission-revision.mjs','automation/whatsapp/private-dispatch.mjs'])await copyFile(file,path.join(root,file));
  const run=check=>execFileSync(process.execPath,['scripts/generate-private-value-sql.mjs',...(check?['--check']:[])],{cwd:root,timeout:5000,env:{PATH:process.env.PATH,TMPDIR:tmpdir()},stdio:'pipe'});
  const historical=await readFile(path.join(root,original)),previousBytes=await readFile(path.join(root,previous)),matcherPath=path.join(root,'ai/private-value-matcher.mjs'),matcher=await readFile(matcherPath,'utf8');
  await t.test('current source and both revision contracts check clean',()=>assert.doesNotThrow(()=>run(true)));
  await t.test('capture input drift cannot be blessed by regenerating admission',async()=>{
   await writeFile(matcherPath,matcher.replace('export function createPrivateValueMatcher','// Capture input changed\nexport function createPrivateValueMatcher'));
   try{assert.throws(()=>run(false),error=>error.stderr.toString().includes('Capture input changed'));}finally{await writeFile(matcherPath,matcher);}
  });
  await t.test('historical SQL drift is rejected',async()=>{
   await writeFile(path.join(root,original),Buffer.concat([historical,Buffer.from('\n')]));try{assert.throws(()=>run(true),error=>error.stderr.toString().includes('Capture SQL changed'));}finally{await writeFile(path.join(root,original),historical);}
  });
  await t.test('admission drift requires regeneration only in the forward migration',async()=>{
   const boundary=path.join(root,'ai/private-payload-boundary.mjs');await writeFile(boundary,(await readFile(boundary,'utf8'))+'\n// Admission version transition\n');
   assert.throws(()=>run(true),error=>error.stderr.toString().includes('Forward admission revision needs regeneration'));
   run(false);run(true);assert.deepEqual(await readFile(path.join(root,original)),historical);
   assert.deepEqual(await readFile(path.join(root,previous)),previousBytes,'regeneration must preserve the already applied admission migration');
   assert.notEqual(await readFile(path.join(root,forward),'utf8'),await readFile(forward,'utf8'));
   assert.notEqual(await readFile(path.join(root,'automation/whatsapp/admission-revision.mjs'),'utf8'),await readFile(new URL('../automation/whatsapp/admission-revision.mjs',import.meta.url),'utf8'));
  });
 }finally{await rm(root,{recursive:true,force:true});}
});
