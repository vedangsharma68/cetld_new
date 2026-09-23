import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('primary navigation leads with assistant without removing existing destinations', () => {
  assert.match(app, /const nav=\[\['Overview','grid'\],\['Assistant','assistant'\],\['Invoices','invoice'\],\['Conversations','chat'\],\['Payments','wallet'\],\['Connections','link'\]\]/);
  assert.match(app, /data-page="Settings"[\s\S]*icon\('settings'\)/);
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
