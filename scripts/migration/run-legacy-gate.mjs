import { cp, mkdtemp, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {releaseTestEnvironment} from '../check-owner-chat-gate.mjs';
// Run the original legacy gates against current retained legacy source. Never
// expose root api/ or legacy cron configuration to a Next deployment.
export async function runLegacyGate(command, args = []) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const target = await mkdtemp(path.join(tmpdir(), 'cetld-legacy-compat-'));
  try {
    await cp(root, target, { recursive: true, filter: (source) => {
      const relative = path.relative(root, source);
      return !relative.split(path.sep)[0].startsWith('.env') && !/^(?:node_modules|\.git|\.next|test-results|playwright-report|tests\/migration|scripts\/migration)(?:\/|$)/.test(relative);
    }});
    for (const name of ['app', 'api', 'src']) {
      await rm(path.join(target, name), {recursive:true, force:true});
      await cp(path.join(root, 'legacy', name), path.join(target, name), {recursive:true});
    }
    for (const name of ['package.json','tsconfig.json','vercel.json','middleware.js'])
      await cp(path.join(root,'legacy',name),path.join(target,name));
    await symlink(path.join(root,'node_modules'),path.join(target,'node_modules'),'dir');
    // Keep the source/fixtures at their old paths. All commands and assertions
    // are the original legacy ones, with only the working directory isolated.
    const manifest=JSON.parse(await readFile(path.join(target,'package.json'),'utf8'));
    if(command!=='shard' && !Object.hasOwn(manifest.scripts,command))throw Error('Unknown legacy gate');
    await writeFile(path.join(target,'legacy-compat-evidence.json'),JSON.stringify({source:'retained legacy modules',command,originalDeploymentBaseline:'ff066b664d2750638e63adba8b64be1a8290c3b9'}));
    const result=spawnSync(command==='shard'?process.execPath:'npm',command==='shard'?['scripts/release-shard.mjs',...args]:['run',command,...(args.length?['--',...args]:[])],{cwd:target,stdio:'inherit',env:releaseTestEnvironment(process.env,{CETLD_LEGACY_COMPAT:'1',...(process.env.EXTRACTION_ROUTE==='offline'?{EXTRACTION_ROUTE:'offline'}:{})})});
    if(result.error)throw result.error;
    return result.status??1;
  } finally {
    // Carry actual browser evidence out of the isolated working directory.
    await cp(path.join(target,'test-results'),path.join(root,'test-results','legacy'),{recursive:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await rm(target,{recursive:true,force:true});
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runLegacyGate(process.argv[2],process.argv.slice(3));
