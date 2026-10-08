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
export async function writeReleaseManifest({outputPath='owner-chat-build.json'}={}) {
  const paths=['automation/whatsapp/invoice-reopening.mjs','payment-reversals.mjs','collections-pulse.mjs','automation/whatsapp/owner-next-actions.mjs','custom-fields.mjs','automation/whatsapp/workspace-records.mjs','automation/preferences.mjs','owner-whatsapp-ui.mjs','followup-preferences-ui.mjs','app.js','automation/whatsapp/owner-grounding.mjs','automation/whatsapp/owner-direct-runtime.mjs',
    'automation/whatsapp/direct-owner-write.mjs','automation/whatsapp/owner-action-buttons.mjs','automation/whatsapp/bot-preferences.mjs','ai/provider.mjs','ai/zen-responses.mjs','ai/tool-calls.mjs','ai/provider-health.mjs','automation/whatsapp/owner-agent.mjs','automation/whatsapp/owner-handler.mjs',
    'automation/whatsapp/owner-workspace-tools.mjs','automation/whatsapp/workspace-data.mjs','automation/whatsapp/owner-reply-store.mjs','automation/whatsapp/owner-reply-safety.mjs',
    'automation/whatsapp/cloud-inbound.mjs','automation/whatsapp/cloud-outbound.mjs','automation/whatsapp/owner-binding.mjs',
    'automation/whatsapp/owner-diagnostics.mjs','scripts/owner-chat-battery.mjs','tests/fixtures/owner-chat-battery.mjs',
    'automation/whatsapp/invoice-corrections.mjs','invoice/business-fields.mjs','invoice/correction-form.mjs','invoice/correction-client.mjs','styles.css',
    'automation/engine.mjs','automation/core-store.mjs','automation/local-reminder-payment.mjs','automation/accounting/store.mjs',
    'automation/whatsapp/cloud-reminders.mjs','automation/whatsapp/reminder-fingerprint.mjs','automation/whatsapp/reminder-receipts.mjs'];
  paths.push('automation/runtime.mjs','automation/worker.mjs','automation/first-party-reminder-runtime.mjs',
    'automation/whatsapp/invoice-review-payment-resolution.mjs','supabase/migrations/20261008025552_invoice_review_unpaid_stamp_resolution.sql',
    'automation/whatsapp/assistant-handler.mjs','automation/whatsapp/invoice-store.mjs','ai/extraction.mjs','ai/pdf-invoice-parser.mjs','ai/invoice-ops.mjs',
    'automation/reminder-cron.mjs','api/whatsapp-process.js','vercel.json','automation/preferences.mjs','followup-preferences-ui.mjs',
    'automation/whatsapp/reminder-templates.mjs','automation/whatsapp/approved-reminders.mjs',
    'automation/whatsapp/template-diagnostic.mjs','automation/whatsapp/test-send.mjs','automation/whatsapp/reminder-proof.mjs','automation/whatsapp/webhook.mjs',
    'supabase/migrations/20261005070000_approved_whatsapp_reminders.sql');
  paths.push('automation/whatsapp/owner-payment-intent.mjs','automation/whatsapp/owner-payment-readback.mjs',
    'supabase/migrations/20261008031733_owner_partial_payment_confirmation.sql',
    'supabase/migrations/20261008153500_owner_live_clarification_evidence.sql');
  paths.push('settings-ai.js','ai/store.mjs','ai/routes.mjs');
  const files={};for(const path of paths)files[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  let commit=process.env.VERCEL_GIT_COMMIT_SHA||process.env.GITHUB_SHA;
  if(!commit)try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{commit=null;}
  await writeFile(outputPath,JSON.stringify({version:1,commit,files,checks:['owner-chat-fast','typecheck','full-suite']})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try{
    await unlink('owner-chat-build.json').catch(error=>{if(error.code!=='ENOENT')throw error;});
    await runReleaseGate();await writeReleaseManifest();
    console.log('Owner chat release gate passed.');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
