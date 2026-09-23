import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [app, css, html, vercel] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
]);

test('all requested Quiet Finance OS surfaces are present', () => {
  for (const surface of [
    'Receivables ageing',
    'Invoice ledger',
    'Conversations',
    'Assistant',
    'Workspace setup',
    'Settings',
    'detail-drawer',
    'activityFeed',
  ]) assert.match(app, new RegExp(surface));
});

test('assistant page has an honest, accessible conversation flow', () => {
  for (const text of [
    'What needs my attention today?',
    'Which invoices are most overdue?',
    'Who owes us the most?',
    'Summarize collections this month.',
    'What should I follow up on next?',
    'Shift + Enter for a new line',
    'assistantClient.send',
  ]) assert.match(app, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(app, /role="log"/);
  assert.match(app, /aria-live="polite"/);
  assert.match(app, /The demo never generates financial answers/);
});

test('liquid chrome is global, subtle and motion-aware', () => {
  assert.match(html, /class="liquid-chrome"/);
  assert.match(css, /chromeDriftOne/);
  assert.match(css, /ambient-paused/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /pointer: fine/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\.dark \.chrome-orb/);
});

test('desktop, tablet and mobile layouts have explicit responsive rules', () => {
  assert.match(css, /@media\(max-width:1150px\)/);
  assert.match(css, /@media\(max-width:800px\)/);
  assert.match(css, /@media\(max-width:520px\)/);
  assert.match(css, /\.conversation-shell/);
  assert.match(css, /dialog\.detail-drawer/);
  assert.match(css, /\.nav-scrim\.open/);
});

test('motion remains optional and CSP-safe', () => {
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\.reduce-motion \*/);
  assert.doesNotMatch(app, /style=/);
  assert.doesNotMatch(html, /<style/i);
  const headers = JSON.parse(vercel).headers[0].headers;
  const csp = headers.find(({key}) => key === 'Content-Security-Policy').value;
  assert.match(csp, /style-src 'self'/);
  assert.doesNotMatch(csp, /style-src[^;]*'unsafe-inline'/);
});

test('interactive controls preserve delegated action contracts', () => {
  for (const action of [
    'new',
    'detail',
    'edit',
    'payment',
    'draft',
    'approve',
    'pause',
    'cancel',
    'select-conversation',
    'onboarding',
  ]) assert.match(app, new RegExp(`['\"]${action}['\"]`));
});
