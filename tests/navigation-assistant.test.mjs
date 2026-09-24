import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('primary navigation leads with assistant without removing existing destinations', () => {
  assert.match(app, /const nav=\[\['Overview','grid'\],\['Assistant','assistant'\],\['Invoices','invoice'\],\['Conversations','chat'\],\['Payments','wallet'\],\['Connections','link'\]\]/);
  assert.match(app, /data-page="Settings"[\s\S]*icon\('cog'\)/);
});

test('overview includes a restrained entry point to the real assistant', () => {
  assert.match(app, /Ask cetld about your receivables…/);
  assert.match(app, /data-action="assistant-suggest"/);
  assert.match(app, /data-action="navigate" data-page="Assistant"/);
  assert.match(app, /action==='assistant-suggest'\)\{if\(state\.page!=='Assistant'\)state\.page='Assistant';return await sendAssistant\(b\.dataset\.prompt\)\}/);
  assert.match(app, /overviewAssistant\(\)\+`<div class="insight-grid">/);
  assert.doesNotMatch(app, /overviewAssistantObserver/);
});

test('collapsed profile remains an accessible avatar control while expanded identity is available', () => {
  assert.match(app, /class="workspace-badge"[^>]*aria-label=/);
  assert.match(app, /class="avatar" aria-hidden="true"/);
  assert.match(app, /class="workspace-badge"[\s\S]*<strong[\s\S]*<small/);
});

test('collapsed sidebar hides profile text and leaves only the avatar', () => {
  const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.shell\.sidebar-collapsed \.workspace-badge>div\{display:none\}/);
});

test('assistant is available in one click and invoice review exposes paid and retry controls',()=>{
  const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  assert.match(app,/class="assistant-fab"[\s\S]*data-page="Assistant"/);
  assert.match(css,/\.assistant-fab\{position:fixed/);
  assert.match(css,/@media\(max-width:600px\)[\s\S]*\.assistant-fab/);
  assert.match(app,/name="alreadyPaid"/);
  assert.match(app,/data-action="retry-assistant-sync"/);
  assert.match(app,/What is the due date for this invoice\?/);
});

test('connections only surfaces supported accounting integrations and neutral credential copy',()=>{
  const connectionSource=app.slice(app.indexOf('function connections()'),app.indexOf('function onboarding()'));
  assert.match(connectionSource,/Zoho Books/);
  assert.match(connectionSource,/QuickBooks/);
  assert.match(connectionSource,/TallyPrime/);
  assert.match(connectionSource,/Coming soon/);
  assert.match(connectionSource,/Credentials are stored securely\./);
  for(const hidden of ['Supabase','WhatsApp / WAPI','Resend','Sentry'])assert.doesNotMatch(connectionSource,new RegExp(hidden));
});

test('settings navigation only points to existing sections; untracked setup progress is absent',()=>{
  const settingsSource=app.slice(app.indexOf('function settings()'),app.indexOf('async function saveSettings'));
  for(const section of ['profile','preferences','account'])assert.match(settingsSource,new RegExp(`href="#${section}"`));
  assert.match(settingsSource,/class="settings-branch-label">Workspace/);
  assert.doesNotMatch(settingsSource,/Setup guide/);
  const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  assert.match(css,/\.setup-card\{display:none!important\}/);
  assert.match(css,/\.settings-layout:has\(#preferences:target\)/);
  assert.match(css,/\.settings-branch-children>a:active\{transform:translateX\(2px\) scale\(\.985,\.96\)\}/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.settings-branch-children>a/);
});
