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
    'Workspace setup',
    'Settings',
    'detail-drawer',
    'activityFeed',
  ]) assert.match(app, new RegExp(surface));
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
