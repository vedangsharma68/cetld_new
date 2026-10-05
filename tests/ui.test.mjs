import {isExternallyManagedInvoice} from '../invoice/business-fields.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {cents,remaining,payment,paymentRequestKey} from '../core.mjs';

const [app, css, html, vercel] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../app/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
]);

test('all requested Quiet Finance OS surfaces are present', () => {
  for (const surface of [
    'Collections Pulse',
    'collectionsPulse',
    'Invoice ledger',
    'Conversations',
    'Assistant',
    'Business setup',
    'Settings',
    'detail-drawer',
    'activityFeed',
  ]) assert.match(app, new RegExp(surface));
});

test('overview labels default-currency cards and counts invoices across currencies in agent status', () => {
  assert.match(app, /Top cards show \$\{escape\(currency\)\} only\. Other currencies appear in Collections Pulse\./);
  assert.match(app, /allOpen=state\.invoices\.filter\(x=>remaining\(x\)>0\)/);
  assert.match(app, /<h2>\$\{allOpen\.length\} invoice/);
});

test('invoice extraction remains cancellable after an earlier Assistant answer', () => {
  assert.match(app, /streaming=busy&&!state\.assistantInvoiceExtractionController&&state\.assistantMessages\.at\(-1\)\?\.role==='assistant'/);
  assert.match(app, /data-action="assistant-manual-invoice">Continue manually now/);
  assert.match(app, /state\.assistantInvoiceFile!==selected&&selected\.size<=10\*1024\*1024/, 'preflight size errors must remain visible');
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
  assert.match(app, /class="assistant-message assistant assistant-pending" aria-live="polite"/);
  assert.match(app, /LatticeLoader\(\{status:'working',label:state\.assistantStatusLabel/);
  assert.match(app, /const thought=busy&&!streaming/);
  for (const label of ['Checking invoices', 'Checking payments', 'Checking follow-ups', 'Reading invoice', 'Syncing books', 'Preparing reply']) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /\$\{busy\?'':'<span class="assistant-presence"><i><\/i>Ready<\/span>'\}/);
  assert.doesNotMatch(app, /Thinking…|assistant-thinking/);
  assert.doesNotMatch(app, /chain.of.thought|internal reasoning/i);
  assert.match(css, /\.assistant-thought-line/);
  assert.match(css, /@media\(max-width:520px\)\{\.assistant-thought-line/);
  assert.doesNotMatch(css, /\.assistant-thinking|assistantDot|assistantThoughtPulse/);
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
  assert.doesNotMatch(css, /\.reduce-motion/);
  assert.doesNotMatch(app, /data-setting="motion"|Reduce motion|pref\('cetld\.motion'/);
  assert.match(app, /localStorage\.removeItem\('cetld\.motion'\)/);
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

test('invoice detail exposes the operator-gated TEST review and one-shot confirmation flow', () => {
  assert.match(app, /whatsappTestRequest\(id\)\.then/);
  assert.match(app, /data-action="whatsapp-test-send"/);
  assert.match(app, /Send test update/);
  assert.match(app, /Actual recipient/);
  assert.match(app, /Sending bot/);
  assert.match(app, /escape\(cost\.currency\).*escape\(cost\.amount\)/);
  assert.match(app, /Meta acceptance is not delivery confirmation/);
  assert.match(app, /Result unknown · do not retry/);
  assert.match(app, /body:JSON\.stringify\(body\)/);
  assert.doesNotMatch(app, /WHATSAPP_TEST_OPERATOR_USER_ID|WHATSAPP_ACCESS_TOKEN/);
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
  const calls=[],buttonEl={disabled:false},invoice={id:'invoice-1',invoice_direction:'receivable',amount_minor:10000,paid_minor:0,currency:'INR',client:'Client',number:'INV-1',status:'sent'};
  const form={dataset:{},querySelector(selector){return selector==='[type=submit]'?buttonEl:null},addEventListener(_name,handler){this.submit=handler}};
  class FormValues {get(key){return key==='amount'?'12.34':key==='reference'?'receipt-1':''}}
  const handler=extractedAppFunction('function paymentForm(id){','function draftForm(id)',{
    state:{demo:false,workspace:{id:'workspace-1'},invoices:[invoice]},FormData:FormValues,crypto:{randomUUID:()=> 'payment-key-1234'},
    openDialog(){},$:selector=>selector==='#payment-form'?form:{close(){}},escape:String,money:()=>'',button:()=>'',terminalInvoice:()=>false,
    remaining,payment,cents,paymentRequestKey,isExternallyManagedInvoice,db:{rpc:async(...args)=>{calls.push(args);return{error:null}}},loadData:async()=>{},toast(){},showError(){},
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
test('shared modal shell stays within the viewport and keeps actions reachable', () => {
  assert.match(css, /dialog\{[^}]*max-height:calc\(100dvh - 32px\)[^}]*overflow:hidden/);
  assert.match(css, /dialog:not\(\.detail-drawer\)\[open\]\{display:flex;flex-direction:column\}/);
  assert.match(css, /dialog:not\(\.detail-drawer\)>form\{[^}]*min-height:0[^}]*flex-direction:column/);
  assert.match(css, /\.dialog-body\{[^}]*overflow-y:auto/);
  assert.match(css, /\.dialog-foot\{[^}]*flex:0 0 auto/);
  assert.match(css, /body:has\(#dialog\[open\]\)\{overflow:hidden\}/);
  assert.doesNotMatch(css, /#dialog:has\(\.invoice-entry-form\)[^}]*max-height:none/);
  assert.doesNotMatch(css, /#dialog:has\(\.invoice-entry-form\)[^}]*overflow:(?:auto|visible)/);
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
  const aiSettingsImport = app.match(/import \{([^}]+)\} from '\.\/settings-ai\.js';/)?.[1] || '';
  for (const helper of ['loadAIWorkspaceConfiguration', 'saveAISettings', 'renderAIModelOptions', 'bindAIModelPickers', 'readAIModelPickerValues']) {
    assert.ok(aiSettingsImport.split(',').some(name => name.trim() === helper), `settings-ai.js must provide ${helper}`);
  }
  assert.match(app, /loadAIWorkspaceConfiguration\(aiRequest,workspace\.id,/);
  assert.match(app, /readAIModelPickerValues\(form\.querySelector/);
  assert.match(app, /saveAISettings\(aiRequest,state\.workspace\.id,\{primary_model:primaryModel,fallback_model:fallbackModel\}/);
  assert.match(app, /bindAIModelPickers\(settingsForm\.querySelector/);
  assert.doesNotMatch(app, /aiRequest\(['"]settings['"]/);
  assert.match(app, /aiRequest\('extract'/);
  assert.match(app, /reviewRequired!==true/);
  assert.match(app, /applyInvoiceExtraction/);
  assert.match(app, /value\('currency'\)/);
  assert.doesNotMatch(app, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(app, /cetld_primary_ai_model:primaryModel/);
});

test('settings rerenders clean up and mount the shared section navigation', () => {
  assert.match(app, /function render\(\)\{destroySettingsNavigation\(\)/);
  assert.match(app, /if\(state\.page==='Settings'\)mountSettingsNavigation\(document\.querySelector\("#app"\)\)/);
});

test('New Invoice extraction does not persist line items without an item review control', () => {
  const items = [
    { description: 'Labour', quantity: 3, unitPrice: 130, amount: 390, confidence: 0.99 },
    { description: 'Oil filter', quantity: 1, unitPrice: 20, amount: 20, confidence: 0.98 },
  ];
  const form = { dataset: {}, elements: { namedItem: () => null } };
  const apply = extractedAppFunction('function applyInvoiceExtraction(form,result){', 'async function ingestFile', {
    setIngestionState() {},
  });
  apply(form, { reviewRequired: true, lineItems: { value: items, confidence: 0.98 } });
  assert.equal(form.dataset.lineItems, '[]');
});

test('Assistant manual escape aborts extraction and keeps the original file for New Invoice', () => {
  const file={name:'workshop.png'},controller={aborted:false,abort(){this.aborted=true}},form={};
  const state={assistantInvoiceFile:file,assistantInvoiceExtractionController:controller,assistantStatus:'loading',assistantError:'',page:'Assistant',pendingFile:null};
  let opened=false;
  const continueManually=extractedAppFunction('function continueWithAssistantInvoiceManually(){','async function retryAssistantSync',{
    state,render(){},invoiceForm(){opened=true;},setIngestionState(){},
    $:()=>form,
  });
  continueManually();
  assert.equal(controller.aborted,true);
  assert.equal(state.assistantInvoiceFile,null);
  assert.equal(state.pendingFile,file);
  assert.equal(state.page,'Invoices');
  assert.equal(opened,true);
  assert.match(app,/const manual=busy&&state\.assistantInvoiceFile[\s\S]*Continue manually now/);
});

test('late extraction results do not overwrite manually edited invoice fields', () => {
  const fields = {
    client: { value: 'Workshop Software', dataset: { userEdited: 'true' } },
    amount: { value: '', dataset: {} },
  };
  const form = { dataset: {}, elements: { namedItem: name => fields[name] || null } };
  const apply = extractedAppFunction('function applyInvoiceExtraction(form,result){', 'async function ingestFile', {
    setIngestionState() {},
  });
  apply(form, {
    reviewRequired: true,
    customerName: { value: 'ABC Electrical' },
    total: { value: 472.7 },
    lineItems: { value: [] },
  });
  assert.equal(fields.client.value, 'Workshop Software');
  assert.equal(fields.amount.value, '472.7');
});

test('editing an invoice keeps its previously extracted itemized lines', () => {
  const items = [{ description: 'Consulting', quantity: 2, unitPrice: 50, amount: 100, confidence: 0.9 }];
  const invoice = { id: 'invoice-1', line_items: items, amount_minor: 10000, paid_minor: 0, currency: 'INR' };
  const form = { dataset: {}, addEventListener() {} };
  const renderForm = extractedAppFunction('function invoiceForm(id){', 'async function saveInvoice', {
    state: { pendingFile: null, invoices: [invoice], settings: { default_currency: 'INR' } },
    openDialog() {},
    $: () => form,
    escape: String,
    remaining: () => 10000,
    icon: () => '',
    button: () => '',
    currencyOptions: () => '',
  });
  renderForm(invoice.id);
  assert.equal(form.dataset.lineItems, JSON.stringify(items));
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
});
test('auth brand backdrop is subtle, theme-aware, lightweight, and motion-safe', () => {
  assert.match(css, /\.auth-brand-panel:before\{[^}]*pointer-events:none[^}]*radial-gradient/);
  assert.match(css, /animation:auth-iridescence 42s ease-in-out infinite alternate/);
  assert.match(css, /\.dark \.auth-brand-panel:before\{[^}]*background-image:radial-gradient/);
  assert.match(css, /@media\(max-width:640px\)\{\.auth-brand-panel:before/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.auth-brand-panel:before\{animation:none/);
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
