import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [app, css] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

function sourceBetween(start, end) {
  const startAt = app.indexOf(start);
  const endAt = app.indexOf(end, startAt);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return app.slice(startAt, endAt);
}

async function runZohoRefresh(refreshedSyncStatus, ledgerLoaded, mutationSyncStatus) {
  const state = {accountingStatus: null};
  const source = sourceBetween('async function refreshZohoLedger(', 'function demo()').trim();
  const build = new Function('refreshAccountingStatus', 'loadData', 'state', `return (${source});`);
  const refresh = build(async () => { state.accountingStatus = {syncStatus: refreshedSyncStatus}; }, async () => ledgerLoaded, state);
  return refresh(mutationSyncStatus);
}

test('selecting a Zoho organization refreshes status and ledger before success is reported', () => {
  const selection = sourceBetween("if(action==='select-zoho-organization')", "if(action==='connect-zoho')");
  const refresh = sourceBetween('async function refreshZohoLedger(', 'function demo()');
  assert.match(selection, /const syncResult=await accountingRequest\('select-organization',[\s\S]*?const refreshed=await refreshZohoLedger\(syncResult\.syncStatus\)/);
  assert.match(selection, /if\(!refreshed\.syncSucceeded\)[\s\S]*?initial sync failed[\s\S]*?if\(!refreshed\.loaded\)[\s\S]*?Zoho Books organization connected\. Ledger refreshed\./);
  assert.match(refresh, /await refreshAccountingStatus\(\);const loaded=await loadData\(\)/);
  assert.match(refresh, /const refreshedSyncStatus=String\(state\.accountingStatus\?\.syncStatus\|\|'unknown'\)/);
  assert.match(refresh, /const mutationStatus=String\(mutationSyncStatus\|\|''\)\.toLowerCase\(\)/);
  assert.match(refresh, /const syncSucceeded=refreshedSyncStatus==='synced'&&\(!mutationStatus\|\|mutationStatus==='synced'\)/);
  assert.match(refresh, /refreshedSyncStatus==='failed'\|\|mutationStatus==='failed'\?'failed'/);
  assert.match(refresh, /ready:loaded&&syncSucceeded/);
});

test('non-synced provider status cannot mark a successful ledger reload ready', async () => {
  for (const status of ['failed', 'pending', 'never', 'unknown']) {
    const result = await runZohoRefresh(status, true, status);
    assert.equal(result.loaded, true);
    assert.equal(result.syncSucceeded, false);
    assert.equal(result.ready, false);
  }
});

test('an explicit failed sync result overrides a stale synced connection status', async () => {
  const result = await runZohoRefresh('synced', true, 'failed');
  assert.equal(result.syncSucceeded, false);
  assert.equal(result.syncStatus, 'failed');
  assert.equal(result.ready, false);
});

test('failed organization sync cannot be reported as connected with a ready ledger', () => {
  const selection = sourceBetween("if(action==='select-zoho-organization')", "if(action==='connect-zoho')");
  assert.match(selection, /if\(!refreshed\.syncSucceeded\)[\s\S]*?initial sync failed[\s\S]*?return\}/);
  assert.match(selection, /if\(!refreshed\.loaded\)[\s\S]*?return\}/);
  assert.match(selection, /Zoho Books organization connected\. Ledger refreshed\./);
});

test('OAuth completion refreshes the ledger and only then reports synced data ready', () => {
  const callback = sourceBetween("window.addEventListener('message'", "document.addEventListener('click',async event=>");
  assert.match(callback, /event\.data\.status==='connected'[\s\S]*?const refreshed=await refreshZohoLedger\(event\.data\.syncStatus\)/);
  assert.match(callback, /if\(!refreshed\.syncSucceeded\)[\s\S]*?initial sync failed[\s\S]*?else if\(!refreshed\.loaded\)[\s\S]*?Zoho Books connected\. Synced data is ready\./);
  assert.doesNotMatch(callback, /Initial sync is starting/);
});

test('OAuth syncStatus failed cannot claim synced data is ready after a successful ledger reload', () => {
  const callback = sourceBetween("window.addEventListener('message'", "document.addEventListener('click',async event=>");
  assert.match(callback, /refreshZohoLedger\(event\.data\.syncStatus\)/);
  assert.match(callback, /if\(!refreshed\.syncSucceeded\)toast\(refreshed\.syncStatus==='failed'\?[\s\S]*?initial sync failed[\s\S]*?else if\(!refreshed\.loaded\)[\s\S]*?else toast\('Zoho Books connected\. Synced data is ready\.'/);
});

test('manual Zoho sync reloads the ledger before reporting visible synced data', () => {
  const manualSync = sourceBetween("if(buttonEl.dataset.action==='sync-zoho')", "else if(buttonEl.dataset.action==='disconnect-zoho')");
  assert.match(manualSync, /const syncResult=await accountingRequest\('sync'\);const refreshed=await refreshZohoLedger\(syncResult\.syncStatus\)/);
  assert.match(manualSync, /if\(!refreshed\.syncSucceeded\)toast\(refreshed\.syncStatus==='failed'\?[\s\S]*?sync failed[\s\S]*?else if\(!refreshed\.loaded\)[\s\S]*?else toast\('Zoho Books sync and ledger refresh completed\.'/);
});

test('ledger refresh failure retains rows and displays its cause and last successful load time', () => {
  const loadData = sourceBetween('async function loadData()', 'async function accountingRequest');
  const page = sourceBetween('function pageContent()', 'function reminder(');
  const render = sourceBetween('function render()', 'function intro(');
  assert.match(loadData, /Promise\.all\([\s\S]*?state\.customers=customers/);
  assert.match(loadData, /state\.lastSuccessfulLoadAt=new Date\(\)\.toISOString\(\)/);
  assert.match(loadData, /state\.ledgerStaleMessage=''/);
  assert.match(loadData, /state\.ledgerStaleMessage=state\.lastSuccessfulLoadAt\?state\.error:''/);
  assert.match(loadData, /return true/);
  assert.match(loadData, /return false/);
  assert.match(page, /class="error ledger-stale load-error" role="alert"/);
  assert.match(page, /Ledger data may be out of date/);
  assert.match(page, /last successful ledger snapshot from/);
  assert.match(page, /state\.ledgerStaleMessage/);
  assert.match(render, /Could not load your workspace: \$\{escape\(state\.error\)\}/);
  assert.match(css, /\.ledger-stale/);
});

test('a successful ledger reload clears the stale indicator', () => {
  const loadData = sourceBetween('async function loadData()', 'async function accountingRequest');
  assert.match(loadData, /state\.ledgerStaleMessage='';[\s\S]*?state\.lastSuccessfulLoadAt=new Date\(\)\.toISOString\(\)/);
});
