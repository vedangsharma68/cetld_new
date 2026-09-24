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
    'Collections Pulse',
    'collectionsPulse',
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

test('mobile tables, drawers and navigation remain usable at small widths', () => {
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(max-width:360px\)/);
  assert.match(css, /\.responsive-table thead\{display:none\}/);
  assert.match(css, /\.responsive-table td::before/);
  assert.match(css, /dialog\.detail-drawer\[open\]\{display:flex\}/);
  assert.match(app, /class="responsive-table invoice-table"/);
  assert.match(app, /class="responsive-table payment-table"/);
  assert.match(app, /aria-controls="app-navigation"/);
  assert.match(app, /action="collapse-nav"/);
});
test('settings persist workspace currency and account model preferences', () => {
  for (const code of ['INR','USD','EUR','GBP','AED','SGD','AUD','CAD','JPY','CHF']) assert.ok(app.includes("['"+code+"'"));
  assert.match(app, /name="primary_ai_model"/);
  assert.match(app, /name="fallback_ai_model"/);
  assert.match(app, /db\.auth\.updateUser/);
  assert.match(app, /default_currency:currency/);
  assert.match(app, /\(x\.currency\|\|currency\)===currency/);
  assert.match(app, /x\?\.currency\|\|state\.settings\?\.default_currency/);
  assert.match(app, /Intl\.NumberFormat/);
});
test('client wording, official integration logos and global contact links are present', () => {
  assert.match(app, /Client phone \(optional\)/);
  assert.match(app, /Client email \(optional\)/);
  assert.doesNotMatch(app, /Debtor (?:phone|email)/);
  assert.match(app, /\['zoho'/);
  assert.match(app, /\['quickbooks'/);
  assert.match(app, /\['whatsapp'/);
  assert.match(app, /cdn\.simpleicons\.org/);
  assert.match(app, /mailto:vedangsharma52@gmail\.com/);
  assert.match(app, /tel:\+919871367051/);
  const csp=JSON.parse(vercel).headers[0].headers.find(({key})=>key==='Content-Security-Policy').value;
  assert.match(csp,/img-src[^;]*https:\/\/cdn\.simpleicons\.org/);
});

test('workspace AI settings and invoice extraction use the centralized server API', () => {
  assert.match(app, /aiRequest\('settings'/);
  assert.match(app, /method:'PUT'/);
  assert.match(app, /primary_model:primaryModel/);
  assert.match(app, /fallback_model:fallbackModel/);
  assert.match(app, /aiRequest\('extract'/);
  assert.match(app, /reviewRequired!==true/);
  assert.match(app, /applyInvoiceExtraction/);
  assert.match(app, /value\('currency'\)/);
  assert.doesNotMatch(app, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(app, /cetld_primary_ai_model:primaryModel/);
});

test('invoice currency is a shared dropdown in manual, edit, extraction review, and Assistant review flows', () => {
  for (const code of ['INR','USD','EUR','GBP','AED','AUD','SGD','CAD','JPY','CHF']) {
    assert.match(app, new RegExp(`\\['${code}',`));
  }
  assert.equal((app.match(/<select name="currency"/g) || []).length, 2);
  assert.equal((app.match(/currencyOptions\(/g) || []).length >= 3, true);
  assert.match(app, /currencyOptions\(x\?\.currency\|\|state\.settings\?\.default_currency\|\|'INR'\)/);
  assert.match(app, /currencyOptions\(currency\)/);
  assert.match(app, /input\.tagName==='SELECT'.*input\.add\(new Option/);
  assert.match(app, /amount_minor:cents\(rawAmount\),currency/);
  assert.match(app, /currency:String\(values\.get\('currency'\)\|\|''\)\.trim\(\)\.toUpperCase\(\)/);
  assert.doesNotMatch(app, /<input name="currency"/);
});

test('Collections Pulse uses complete workspace-scoped data and explicit multi-currency presentation', () => {
  assert.match(app, /workspaceRows\('invoices',workspaceId\)/);
  assert.match(app, /workspaceRows\('payments',workspaceId/);
  assert.match(app, /Currencies are shown separately\. No FX conversion is applied\./);
  assert.match(css, /\.dark \.btn\.primary:hover:not\(:disabled\)/);
  assert.match(css, /\.dark \.btn\.primary:disabled/);
});

test('sign-in uses the approved Cetld message and simple settlement sequence', () => {
  assert.match(app, /<h1>Get it cetld\.<\/h1>/);
  assert.match(app, /Less chasing\. More getting paid\./);
  assert.match(app, /settlement-animation/);
  for (const event of ['Payment received','Follow-up stopped','Invoice settled']) assert.ok(app.includes(event));
  assert.match(app, /class="balance-zero"/);
  assert.match(app, /class="status-settled"/);
});
test('sign-in brand panel fits desktop and tablet and respects reduced motion', () => {
  assert.match(css, /\.auth-brand-copy h1[^}]*white-space:nowrap/);
  assert.match(css, /@media\(min-width:801px\) and \(max-width:1150px\)/);
  assert.match(css, /@media\(max-width:800px\)\{\.auth-brand-panel/);
  assert.match(css, /@media\(max-width:640px\)\{\.auth-brand-panel/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.settlement-animation/);
  assert.match(css, /\.reduce-motion \.settlement-animation/);
});
test('Google sign-in mark stays legible and consistent in light and dark themes', () => {
  assert.match(app, /class="google-mark"[^>]*>\s*<svg viewBox="0 0 18 18"/);
  assert.match(css, /\.google-mark svg/);
  assert.match(css, /\.google\{gap:10px;background:var\(--white\)/);
  assert.match(css, /\.dark \.google\{background:#fff[^}]*color:#202124/);
});
test('auth page restores sibling desktop panels and gives dark mode readable controls', () => {
  assert.match(app, /auth\.innerHTML=auth\.innerHTML\.replace\('<section class="auth-panel">','<\/section><section class="auth-panel">'\)/);
  assert.match(css, /\.auth\{[^}]*display:grid;grid-template-columns:1\.05fr 1fr/);
  assert.match(css, /\.dark \.auth-panel \.field input\{background:#1b2c24;border-color:#40584a;color:#e7eee2\}/);
  assert.match(css, /\.dark \.auth-panel \.auth-links button,\.dark \.auth-panel \.text-link\{color:#a9d9bd\}/);
  assert.match(css, /\.dark \.auth-brand-copy h1\{color:#f7f9f7\}/);
});
