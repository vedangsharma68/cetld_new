import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {cents,remaining,payment,paymentRequestKey} from '../core.mjs';

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
  assert.match(app, /<form class="assistant-composer"[^>]*><label class="assistant-attach"/);
  assert.match(app, /aria-label="Attach invoice image or PDF"/);
  assert.doesNotMatch(app, /<span>Add invoice<\/span>/);
});

test('assistant progress line reflects loading versus streamed response without exposing reasoning', () => {
  assert.match(app, /const busy=state\.assistantStatus==='loading',streaming=busy/);
  assert.match(app, /class="assistant-thought-line" role="status" aria-live="polite"/);
  assert.match(app, /const thought=busy&&!streaming/);
  assert.match(app, /Preparing response…/);
  assert.match(app, /Checking follow-up history…/);
  assert.match(app, /busy&&!streaming\?/);
  assert.doesNotMatch(app, /chain.of.thought|internal reasoning/i);
  assert.match(css, /\.assistant-thought-line/);
  assert.match(css, /\.assistant-thought-dot/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.assistant-thought-line/);
  assert.match(css, /@media\(max-width:520px\)\{\.assistant-thought-line/);
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

test('payment retries bind the same idempotency key to amount and reference', () => {
  assert.match(app, /paymentRequestKey\(form\.dataset,\{amount,reference\}\)/);
  assert.match(app, /p_reference:reference/);
});

function extractedAppFunction(startMarker,endMarker,sandbox) {
  const start=app.indexOf(startMarker),end=app.indexOf(endMarker,start);
  assert.notEqual(start,-1,`missing app handler ${startMarker}`);
  assert.notEqual(end,-1,`missing end marker ${endMarker}`);
  const name=startMarker.match(/function\s+(\w+)/)?.[1];
  assert.ok(name,`could not read function name from ${startMarker}`);
  return vm.runInNewContext(`${app.slice(start,end)}; ${name}`,sandbox);
}

test('Assistant invoice submit executes the save request with values and a retry-stable key',async()=>{
  const requests=[],buttonEl={disabled:false},fields={invoiceNumber:'INV-1',clientName:'Client',invoiceDate:'2026-09-01',dueDate:'2026-10-01',total:'100',currency:'INR'};
  const form={dataset:{},elements:{dueDate:{focus(){}}},querySelector(selector){return selector==='[type=submit]'?buttonEl:{textContent:''}}};
  class FormValues {get(key){return fields[key]??''}has(key){return key==='alreadyPaid'&&!!fields.alreadyPaid}}
  const handler=extractedAppFunction('async function saveAssistantInvoice(event){','async function retryAssistantSync',{
    state:{workspace:{id:'workspace-1'},assistantInvoiceFile:null},FormData:FormValues,crypto:{randomUUID:()=> 'assistant-key-1234'},
    aiRequest:async(action,request)=>{requests.push({action,request});return{saved:false}},showError(){},
  });
  for(let i=0;i<2;i++)await handler({preventDefault(){},currentTarget:form});
  assert.equal(requests.length,2);
  assert.equal(requests[0].action,'save-invoice');
  assert.equal(requests[0].request.body.workspaceId,'workspace-1');
  assert.equal(requests[0].request.body.invoice.invoiceNumber,'INV-1');
  assert.equal(requests[0].request.body.idempotencyKey,'assistant-key-1234');
  assert.equal(requests[1].request.body.idempotencyKey,requests[0].request.body.idempotencyKey);
});

test('payment form executes the RPC with the declared reference and bound request key',async()=>{
  const calls=[],buttonEl={disabled:false},invoice={id:'invoice-1',amount_minor:10000,paid_minor:0,currency:'INR',client:'Client',number:'INV-1',status:'sent'};
  const form={dataset:{},querySelector(selector){return selector==='[type=submit]'?buttonEl:null},addEventListener(_name,handler){this.submit=handler}};
  class FormValues {get(key){return key==='amount'?'12.34':key==='reference'?'receipt-1':''}}
  const handler=extractedAppFunction('function paymentForm(id){','function draftForm(id)',{
    state:{demo:false,workspace:{id:'workspace-1'},invoices:[invoice]},FormData:FormValues,crypto:{randomUUID:()=> 'payment-key-1234'},
    openDialog(){},$:selector=>selector==='#payment-form'?form:{close(){}},escape:String,money:()=>'',button:()=>'',terminalInvoice:()=>false,
    remaining,payment,cents,paymentRequestKey,db:{rpc:async(...args)=>{calls.push(args);return{error:null}}},loadData:async()=>{},toast(){},showError(){},
  });
  handler('invoice-1');
  await form.submit({preventDefault(){},currentTarget:form});
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'record_invoice_payment');
  assert.equal(calls[0][1].p_amount,12.34);
  assert.equal(calls[0][1].p_reference,'receipt-1');
  const savedKey=calls[0][1].p_idempotency_key;
  assert.ok(savedKey);
  assert.equal(form.dataset.paymentRequestKey,savedKey);
  assert.equal(paymentRequestKey(form.dataset,{amount:1234,reference:'receipt-1'}),savedKey);
  assert.throws(()=>paymentRequestKey(form.dataset,{amount:1235,reference:'receipt-1'}),/pending.*same amount and reference/i);
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
  for (const code of ['INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF']) assert.ok(app.includes("['"+code+"'"));
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
  assert.match(app, /\['tally'/);
  assert.match(app, /\/tallyprime-logo\.svg/);
  for (const infrastructure of ["['supabase'", "['whatsapp'", "['resend'", "['sentry'"]) assert.doesNotMatch(app, new RegExp(infrastructure.replace('[', '\\[')));
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
  for (const code of ['INR','USD','EUR','GBP','AED','AUD','SGD','CAD','CHF']) {
    assert.match(app, new RegExp(`\\['${code}',`));
  }
  assert.doesNotMatch(app,/\['JPY',/);
  assert.equal((app.match(/<select name="currency"/g) || []).length, 2);
  assert.equal((app.match(/currencyOptions\(/g) || []).length >= 3, true);
  assert.match(app, /currencyOptions\(x\?\.currency\|\|state\.settings\?\.default_currency\|\|'INR'\)/);
  assert.match(app, /currencyOptions\(currency\)/);
  assert.match(app, /input\.tagName==='SELECT'.*input\.add\(new Option/);
  assert.match(app, /amount_minor:cents\(rawAmount\),currency/);
  assert.match(app, /currency:String\(values\.get\('currency'\)\|\|''\)\.trim\(\)\.toUpperCase\(\)/);
  assert.match(app,/isSupportedCurrency\(currency\)/);
  assert.match(app,/unsupported precision/);
  assert.doesNotMatch(app, /<input name="currency"/);
});

test('invoice writes leave amount paid and lifecycle status to the settlement RPC',()=>{
  assert.doesNotMatch(app,/amount_paid:\(x\?\.paid_minor\|\|0\)\/100/);
  assert.doesNotMatch(app,/status:x\?\.status\|\|'draft'/);
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
test('auth brand backdrop is subtle, theme-aware, lightweight, and motion-safe', () => {
  assert.match(css, /\.auth-brand-panel:before\{[^}]*pointer-events:none[^}]*radial-gradient/);
  assert.match(css, /animation:auth-iridescence 42s ease-in-out infinite alternate/);
  assert.match(css, /\.dark \.auth-brand-panel:before\{[^}]*background-image:radial-gradient/);
  assert.match(css, /@media\(max-width:640px\)\{\.auth-brand-panel:before/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.auth-brand-panel:before\{animation:none/);
  assert.match(css, /\.reduce-motion \.auth-brand-panel:before\{animation:none/);
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
