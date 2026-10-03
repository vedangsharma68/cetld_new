import {spawn} from 'node:child_process';
import {writeFile,readFile,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Each command must finish successfully before Vercel may publish this build.
// Child tests receive no production service credentials or messaging flags.
export async function runReleaseGate({run=runCommand}={}) {
  await run('test:owner-chat');
  await run('typecheck');
  await run('test');
}
function runCommand(script) {
  const env={...process.env,NODE_ENV:'test'};
  for(const key of Object.keys(env))if(/^(?:WHATSAPP_|SUPABASE_|CLOUDFLARE_|GEMINI_|OPENROUTER_|OPENCODE_|ZOHO_|QUICKBOOKS_|ACCOUNTING_|CRON_SECRET|AUTOMATION_)/.test(key)
    ||/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE|API_KEY|DATABASE_URL)/i.test(key))delete env[key];
  // npm exposes its actual JS entrypoint, avoiding shell quoting on Windows.
  const npm=process.env.npm_execpath;
  const child=npm?spawn(process.execPath,[npm,'run',script],{stdio:'inherit',env})
    :spawn(process.platform==='win32'?'npm.cmd':'npm',['run',script],{stdio:'inherit',env,shell:process.platform==='win32'});
  return new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(`Release gate failed: ${script}`)));
  });
}
async function manifest() {
  const paths=['ai/provider.mjs','automation/whatsapp/owner-agent.mjs','automation/whatsapp/owner-handler.mjs',
    'automation/whatsapp/owner-workspace-tools.mjs','automation/whatsapp/workspace-data.mjs','automation/whatsapp/owner-reply-store.mjs',
    'automation/whatsapp/cloud-inbound.mjs','scripts/owner-chat-battery.mjs','tests/fixtures/owner-chat-battery.mjs'];
  const files={};for(const path of paths)files[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  let commit=process.env.VERCEL_GIT_COMMIT_SHA||process.env.GITHUB_SHA;
  if(!commit)try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{commit=null;}
  await writeFile('owner-chat-build.json',JSON.stringify({version:1,commit,files,checks:['owner-chat-fast','typecheck','full-suite']})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try{
    await unlink('owner-chat-build.json').catch(error=>{if(error.code!=='ENOENT')throw error;});
    await runReleaseGate();await manifest();
    console.log('Owner chat release gate passed.');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
