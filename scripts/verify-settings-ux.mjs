import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Run with the repository's local Playwright package, or set CETLD_PLAYWRIGHT_PATH
// to the bundled Playwright module. CETLD_CHROMIUM_EXECUTABLE can select an installed binary.
const playwrightPath = process.env.CETLD_PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(playwrightPath);
const origin = process.env.CETLD_SETTINGS_URL || 'http://127.0.0.1:8765/app/';
const artifactDirectory = process.env.SETTINGS_UX_ARTIFACTS_DIR
  || path.join(os.tmpdir(), 'cetld-settings-ux');

const pickerFixture = {
  initialPrimary: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  initialFallback: '@cf/mistralai/mistral-small-3.1-24b-instruct',
  savedPrimary: '@cf/openai/gpt-oss-20b',
  savedFallback: '@cf/qwen/qwen3-30b-a3b-fp8',
  primaryModels: [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-4-scout-17b-16e-instruct',
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    '@cf/openai/gpt-oss-20b',
    '@cf/qwen/qwen3-30b-a3b-fp8',
  ],
  fallbackModels: [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-4-scout-17b-16e-instruct',
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    '@cf/openai/gpt-oss-20b',
    '@cf/qwen/qwen3-30b-a3b-fp8',
  ],
};

const fixture = {
  user: { id: 'settings-ux-user', email: 'settings-ux@example.test', user_metadata: { full_name: 'Settings QA' } },
  profile: { user_id: 'settings-ux-user', full_name: 'Settings QA' },
  workspace: { id: 'settings-ux-workspace', owner_id: 'settings-ux-user', name: 'Settings QA Studio', created_at: '2026-01-01T00:00:00.000Z' },
  settings: {
    workspace_id: 'settings-ux-workspace', business_name: 'Settings QA Studio',
    default_currency: 'INR', default_timezone: 'Asia/Kolkata',
    whatsapp_owner_phone: '+919876543210',
    follow_up_preferences: { tone: 'professional', interval_days: 3, max_reminders: 4, allowed_weekdays: [1, 2, 3, 4, 5], contact_start: '09:00', contact_end: '18:00', after_max: 'pause', pause_on_reply: true, dailySummary: false },
  },
};

function supabaseModule() {
  return `
const fixture = ${JSON.stringify(fixture)};
const calls = [];
window.__mockSupabase = { rpcCalls: calls, writes: [] };
const session = { access_token: 'local-settings-test-token', refresh_token: 'local-settings-test-refresh', user: fixture.user };
function dataFor(table) {
  if (table === 'profiles') return fixture.profile;
  if (table === 'workspaces') return [fixture.workspace];
  if (table === 'workspace_settings') return fixture.settings;
  return [];
}
class Query {
  constructor(table) { this.table = table; this.operation = 'select'; this.values = null; }
  select() { return this; }
  eq() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return Promise.resolve({ data: dataFor(this.table), error: null }); }
  or() { return this; }
  gte() { return this; }
  maybeSingle() { return Promise.resolve({ data: dataFor(this.table), error: null }); }
  single() { return Promise.resolve({ data: dataFor(this.table), error: null }); }
  upsert(values) { this.operation = 'upsert'; this.values = values; return this; }
  update(values) { this.operation = 'update'; this.values = values; return this; }
  insert(values) { this.operation = 'insert'; this.values = values; return this; }
  then(resolve, reject) { return Promise.resolve({ data: dataFor(this.table), error: null }).then(resolve, reject); }
}
export function createClient() {
  return {
    auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session }, error: null }; },
      async getUser() { return { data: { user: fixture.user }, error: null }; },
      async updateUser() { return { data: { user: fixture.user }, error: null }; },
      async signOut() { return { error: null }; },
    },
    from(table) { return new Query(table); },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'owner_start_whatsapp_verification') return { data: { code: '482916', expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }, error: null };
      if (name === 'owner_whatsapp_verification_status') return { data: 'pending', error: null };
      return { data: null, error: null };
    },
  };
}
`;
}

async function installMocks(page) {
  const ai = {
    settings: {
      primary_model: pickerFixture.initialPrimary,
      fallback_model: pickerFixture.initialFallback,
      role: 'owner',
    },
    requests: [],
  };
  await page.route('https://esm.sh/@supabase/supabase-js@2.116.0', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: supabaseModule(),
  }));
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    if (url.pathname === '/api/ai' && url.searchParams.get('action') === 'models') {
      body = {
        models: pickerFixture.primaryModels,
        fallbackModels: pickerFixture.fallbackModels,
        extractionModels: [],
      };
    } else if (url.pathname === '/api/ai' && url.searchParams.get('action') === 'settings') {
      if (request.method() === 'PUT') {
        const selection = request.postDataJSON();
        ai.requests.push({ method: request.method(), query: url.searchParams.toString(), body: selection });
        ai.settings = {
          primary_model: selection.primary_model,
          fallback_model: selection.fallback_model,
          role: 'owner',
        };
      } else {
        ai.requests.push({ method: request.method(), query: url.searchParams.toString() });
      }
      body = { ...ai.settings };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return ai;
}

async function waitForSettings(page) {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.utility-nav [data-page="Settings"]', { timeout: 20000 });
  await page.locator('.utility-nav [data-page="Settings"]').click();
  await page.waitForSelector('#owner-whatsapp', { timeout: 20000 });
  await page.locator('#owner-whatsapp-title').waitFor();
}

async function waitForActive(page, id) {
  await page.waitForFunction(id => document.querySelector('.settings-nav a[aria-current="location"]')?.getAttribute('href') === `#${id}`, id, { timeout: 3000 });
}

async function captureViewport(page, width, height, report, browserName) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  const layout = await page.evaluate(browserName => {
    const nav = document.querySelector('.settings-nav');
    const topbar = document.querySelector('.topbar');
    const sections = [...document.querySelectorAll('.settings-content > .panel')];
    const gapValues = sections.slice(0, -1).map((section, index) => {
      const next = sections[index + 1];
      return Math.round(next.getBoundingClientRect().top - section.getBoundingClientRect().bottom);
    });
    const whatsapp = document.querySelector('#owner-whatsapp');
    const groups = [...document.querySelectorAll('.owner-whatsapp-status, .owner-whatsapp-actions, .owner-whatsapp-change')].map(group => ({
      name: group.className,
      top: Math.round(group.getBoundingClientRect().top),
      height: Math.round(group.getBoundingClientRect().height),
    }));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      browser: browserName,
      pageWidth: document.documentElement.scrollWidth,
      topbarBottom: Math.round(topbar.getBoundingClientRect().bottom),
      navTop: Math.round(nav.getBoundingClientRect().top),
      navScrollWidth: nav.scrollWidth,
      navClientWidth: nav.clientWidth,
      sectionGaps: gapValues,
      whatsapp: {
        top: Math.round(whatsapp.getBoundingClientRect().top),
        height: Math.round(whatsapp.getBoundingClientRect().height),
        groups,
        groupGaps: groups.slice(0, -1).map((group, index) => Math.round(groups[index + 1].top - (group.top + group.height))),
      },
    };
  }, browserName);
  report.viewports.push(layout);
  assert.ok(layout.pageWidth <= width, `horizontal overflow at ${width}px: page is ${layout.pageWidth}px`);
  assert.ok(layout.sectionGaps.every(gap => gap >= 16), `settings cards are touching at ${width}px: ${layout.sectionGaps}`);
  assert.ok(layout.whatsapp.groups.length >= 3, 'connected WhatsApp card must render separate status, action, and number-change clusters');
  assert.ok(layout.whatsapp.groupGaps.every(gap => gap >= 12), `WhatsApp clusters are cramped at ${width}px: ${layout.whatsapp.groupGaps}`);
  if (width <= 800) assert.ok(layout.navTop >= layout.topbarBottom - 1, `sticky settings nav overlaps the topbar at ${width}px: top=${layout.navTop}, topbar bottom=${layout.topbarBottom}`);
  await page.screenshot({ path: `${artifactDirectory}/${browserName}-settings-${width}x${height}.png`, fullPage: true, animations: 'disabled' });
}

async function verifyScrollSpy(page, report, viewport) {
  const ids = await page.locator('.settings-nav .settings-branch-children a[href^="#"]').evaluateAll(links => links.map(link => link.getAttribute('href').slice(1)));
  const measurements = [];
  const clamped = [];
  const clicked = [];
  const activationOffset = await page.evaluate(() => {
    const first = document.querySelector('.settings-content > .panel');
    const style = getComputedStyle(first);
    return (parseFloat(style.scrollMarginBlockStart) || parseFloat(style.scrollMarginTop) || 0) + 8;
  });

  for (const id of ids.slice(0, -1)) {
    const before = await page.locator(`#${id}`).evaluate(section => section.getBoundingClientRect().top + window.scrollY);
    const targetTop = Math.max(0, before - Math.max(16, activationOffset - 18));
    const maxScroll = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
    if (targetTop > maxScroll - 2) {
      clamped.push({ id, targetTop: Math.round(targetTop), maxScroll: Math.round(maxScroll) });
      continue;
    }
    await page.evaluate(top => window.scrollTo(0, top), targetTop);
    await page.waitForTimeout(100);
    const state = await page.evaluate(id => ({
      scrollY: Math.round(window.scrollY),
      sectionTop: Math.round(document.getElementById(id).getBoundingClientRect().top),
      active: document.querySelector('.settings-nav a[aria-current="location"]')?.getAttribute('href'),
    }), id);
    measurements.push({ id, ...state });
    assert.equal(state.active, `#${id}`, `scrolling to ${id} did not update the active settings tab`);
  }

  for (const id of [...ids.slice(0, -1)].reverse().filter(id => !clamped.some(item => item.id === id))) {
    const before = await page.locator(`#${id}`).evaluate(section => section.getBoundingClientRect().top + window.scrollY);
    await page.evaluate(({ top, offset }) => window.scrollTo(0, Math.max(0, top - Math.max(16, offset - 18))), { top: before, offset: activationOffset });
    await page.waitForTimeout(100);
    await waitForActive(page, id);
  }

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await waitForActive(page, ids.at(-1));
  for (const id of ids) {
    await page.locator(`.settings-nav a[href="#${id}"]`).click();
    await page.waitForFunction(id => location.hash === `#${id}`, id, { timeout: 3000 });
    const target = await page.locator(`#${id}`).evaluate(section => {
      const rect = section.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), visible: rect.bottom > 0 && rect.top < innerHeight };
    });
    assert.ok(target.visible, `clicking ${id} did not scroll its section into view`);
    clicked.push({ id, ...target });
  }
  report.scrollSpy ||= [];
  report.scrollSpy.push({ viewport, activationOffset, downAndUp: measurements, bottomSelection: ids.at(-1), clampedSections: clamped, clicked });
}

async function verifyControls(page, report, suffix) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const textInput = page.locator('#settings-form input[name="full_name"]');
  const select = page.locator('#settings-form select[name="default_currency"]');
  const checkbox = page.locator('#follow-up-preferences-form input[type="checkbox"]').first();
  const styleOf = locator => locator.evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName, height: Math.round(rect.height), borderWidth: style.borderTopWidth, borderColor: style.borderTopColor, borderRadius: style.borderTopLeftRadius, outline: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  });

  const textStyle = await styleOf(textInput);
  const selectStyle = await styleOf(select);
  assert.ok(textStyle.height >= 44 && selectStyle.height >= 44, `text/select controls below 44px: ${JSON.stringify({ textStyle, selectStyle })}`);
  assert.notEqual(textStyle.borderWidth, '0px');
  assert.notEqual(selectStyle.borderWidth, '0px');
  await textInput.focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return { name: element.name, visible: element.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  });
  assert.ok(focused.visible && (focused.outlineWidth !== '0px' || focused.boxShadow !== 'none'), `keyboard focus ring is missing: ${JSON.stringify(focused)}`);
  const wasChecked = await checkbox.isChecked();
  await checkbox.click();
  assert.equal(await checkbox.isChecked(), !wasChecked, 'checkbox did not toggle natively');
  report.controls[suffix] = { text: textStyle, select: selectStyle, keyboardFocus: focused, checkboxToggled: true };
}

async function verifyWhatsAppActions(page, report) {
  const connectedStatus = await page.locator('.owner-whatsapp-status').innerText();
  assert.match(connectedStatus, /Connected/);
  await page.locator('#whatsapp-owner-form input[name="phone"]').fill('+919871367051');
  await page.locator('#whatsapp-owner-form [type="submit"]').click();
  await page.waitForFunction(() => window.__mockSupabase.rpcCalls.some(call => call.name === 'owner_start_whatsapp_verification'), null, { timeout: 3000 });
  const connect = await page.evaluate(() => window.__mockSupabase.rpcCalls.find(call => call.name === 'owner_start_whatsapp_verification'));
  assert.equal(connect.args.p_phone, '+919871367051');
  const verificationLink = await page.locator('.owner-whatsapp-verification a[href*="wa.me"]').getAttribute('href');
  assert.match(decodeURIComponent(verificationLink), /LINK 482916/, 'connect flow did not render the mocked verification link');
  await page.locator('[data-action="owner-verify-cancel"]').click();
  await page.waitForFunction(() => window.__mockSupabase.rpcCalls.some(call => call.name === 'owner_cancel_whatsapp_verification'), null, { timeout: 3000 });
  await page.locator('[data-action="owner-disconnect"]').click();
  await page.waitForFunction(() => window.__mockSupabase.rpcCalls.some(call => call.name === 'owner_unbind_whatsapp'), null, { timeout: 3000 });
  await page.waitForFunction(() => !document.querySelector('.owner-whatsapp-status'), null, { timeout: 3000 });
  assert.match(await page.locator('#owner-whatsapp').innerText(), /Connect WhatsApp/);
  report.whatsappFrontend = {
    startedVerification: connect.name,
    requestedPhone: connect.args.p_phone,
    canceledVerification: true,
    disconnected: true,
    rpcCalls: await page.evaluate(() => window.__mockSupabase.rpcCalls.map(call => call.name)),
    environment: 'local signed-in mock; no Supabase writes, WhatsApp send, or live-provider proof',
  };
}

async function verifyModelPickers(page, report, ai, browserName) {
  const advanced = page.locator('#settings-form details.settings-advanced summary');
  await advanced.click();
  const primary = page.locator('#settings-form select[name="primary_ai_model"]');
  const fallback = page.locator('#settings-form select[name="fallback_ai_model"]');
  const initial = {
    primary: await primary.inputValue(),
    fallback: await fallback.inputValue(),
  };
  assert.deepEqual(initial, {
    primary: pickerFixture.initialPrimary,
    fallback: pickerFixture.initialFallback,
  }, `${browserName} did not load both mocked AI model selections`);

  const initiallyExcluded = await page.evaluate(() => {
    const primarySelect = document.querySelector('#settings-form select[name="primary_ai_model"]');
    const fallbackSelect = document.querySelector('#settings-form select[name="fallback_ai_model"]');
    return {
      fallbackDisabledInPrimary: [...primarySelect.options].find(option => option.value === fallbackSelect.value)?.disabled,
      primaryDisabledInFallback: [...fallbackSelect.options].find(option => option.value === primarySelect.value)?.disabled,
    };
  });
  assert.deepEqual(initiallyExcluded, {
    fallbackDisabledInPrimary: true,
    primaryDisabledInFallback: true,
  }, `${browserName} must prevent the same model from filling both roles`);

  await primary.evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, pickerFixture.initialFallback);
  const afterPrimaryCollision = {
    primary: await primary.inputValue(),
    fallback: await fallback.inputValue(),
  };
  assert.deepEqual(afterPrimaryCollision, {
    primary: pickerFixture.initialFallback,
    fallback: '',
  }, `${browserName} should clear fallback if the primary is changed to that model`);

  await fallback.evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, pickerFixture.initialFallback);
  assert.equal(await fallback.inputValue(), '', `${browserName} should clear a fallback that duplicates primary`);

  await primary.selectOption(pickerFixture.savedPrimary);
  await fallback.selectOption(pickerFixture.savedFallback);
  const chosen = {
    primary: await primary.inputValue(),
    fallback: await fallback.inputValue(),
  };
  assert.deepEqual(chosen, {
    primary: pickerFixture.savedPrimary,
    fallback: pickerFixture.savedFallback,
  }, `${browserName} should allow two distinct available models`);

  const saveResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/ai'
      && url.searchParams.get('action') === 'settings'
      && response.request().method() === 'PUT';
  }, { timeout: 5000 });
  await page.locator('#settings-form [type="submit"]').click();
  const response = await saveResponse;
  assert.equal(response.status(), 200);
  const saved = await response.json();
  assert.deepEqual({ primary: saved.primary_model, fallback: saved.fallback_model }, chosen);
  assert.ok(ai.requests.some(request => request.method === 'PUT'
    && request.body.workspaceId === 'settings-ux-workspace'
    && request.body.primary_model === chosen.primary
    && request.body.fallback_model === chosen.fallback), `${browserName} did not save the selected pair through the mocked API`);
  await page.getByText('Settings saved', { exact: true }).waitFor({ timeout: 5000 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.utility-nav [data-page="Settings"]', { timeout: 20000 });
  await page.locator('.utility-nav [data-page="Settings"]').click();
  await page.waitForSelector('#owner-whatsapp', { timeout: 20000 });
  await page.locator('#owner-whatsapp-title').waitFor();
  await page.locator('#settings-form details.settings-advanced summary').click();
  const reloaded = {
    primary: await page.locator('#settings-form select[name="primary_ai_model"]').inputValue(),
    fallback: await page.locator('#settings-form select[name="fallback_ai_model"]').inputValue(),
  };
  assert.deepEqual(reloaded, chosen, `${browserName} did not reload the saved primary/fallback pair`);
  report.modelPickers ||= [];
  report.modelPickers.push({
    browser: browserName,
    loaded: initial,
    distinctOptionsDisabled: initiallyExcluded,
    primaryCollisionClearedFallback: afterPrimaryCollision.fallback === '',
    fallbackCollisionCleared: true,
    saved: chosen,
    reloaded,
    apiRequests: ai.requests,
    environment: 'local signed-in mock; AI API calls are intercepted in Playwright',
  });
}

async function run() {
  await mkdir(artifactDirectory, { recursive: true });
  const report = {
    url: origin,
    reducedMotion: true,
    environment: 'local UI served from the worktree with mocked Supabase and /api responses',
    browsers: [],
    viewports: [],
    controls: {},
  };
  const browser = await chromium.launch({ headless: true, ...(process.env.CETLD_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CETLD_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ reducedMotion: 'reduce', colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', error => { report.pageErrors ||= []; report.pageErrors.push(error.message); });
  const chromiumMocks = await installMocks(page);
  await waitForSettings(page);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);

  for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await captureViewport(page, width, height, report, 'chromium');
    await verifyControls(page, report, `${width}x${height}-light`);
    await verifyScrollSpy(page, report, `${width}x${height}`);
  }

  await verifyModelPickers(page, report, chromiumMocks, 'chromium');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.locator('[data-action="theme"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true, 'dark theme toggle did not switch themes');
  await verifyControls(page, report, '1440x900-dark');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  await page.screenshot({ path: `${artifactDirectory}/chromium-settings-1440x900-dark.png`, fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.locator('[data-action="theme"]').click();
  assert.equal(await page.evaluate(() => !document.documentElement.classList.contains('dark')), true, 'light theme toggle did not switch themes');

  await page.setViewportSize({ width: 1440, height: 900 });
  await verifyWhatsAppActions(page, report);
  assert.deepEqual(report.pageErrors || [], [], 'page raised browser errors');
  report.browsers.push({
    name: process.env.CETLD_CHROMIUM_EXECUTABLE
      ? 'Playwright Chromium using configured browser executable'
      : 'Playwright Chromium headless shell',
    passed: true,
  });

  let chromeBrowser;
  try {
    chromeBrowser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 8000 });
    const chromePage = await chromeBrowser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const chromeMocks = await installMocks(chromePage);
    await waitForSettings(chromePage);
    await captureViewport(chromePage, 390, 844, report, 'chrome');
    await captureViewport(chromePage, 768, 1024, report, 'chrome');
    await captureViewport(chromePage, 1440, 900, report, 'chrome');
    await verifyControls(chromePage, report, 'native-chrome-1440x900');
    for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
      await chromePage.setViewportSize({ width, height });
      await verifyScrollSpy(chromePage, report, `native-chrome-${width}x${height}`);
    }
    await verifyModelPickers(chromePage, report, chromeMocks, 'native-chrome');
    await verifyWhatsAppActions(chromePage, report);
    report.browsers.push({ name: 'Installed Google Chrome', passed: true });
  } catch (error) {
    report.browsers.push({ name: 'Installed Google Chrome', passed: false, reason: error.message });
    throw error;
  } finally {
    await chromeBrowser?.close();
  }
  for (const channel of ['msedge']) {
    let optional;
    try {
      optional = await chromium.launch({ channel, headless: true, timeout: 3000 });
      const optionalPage = await optional.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const optionalMocks = await installMocks(optionalPage);
      await waitForSettings(optionalPage);
      await captureViewport(optionalPage, 390, 844, report, channel);
      await captureViewport(optionalPage, 768, 1024, report, channel);
      await captureViewport(optionalPage, 1440, 900, report, channel);
      await verifyControls(optionalPage, report, `${channel}-1440x900`);
      for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
        await optionalPage.setViewportSize({ width, height });
        await verifyScrollSpy(optionalPage, report, `${channel}-${width}x${height}`);
      }
      await verifyModelPickers(optionalPage, report, optionalMocks, channel);
      await verifyWhatsAppActions(optionalPage, report);
      report.browsers.push({ name: channel, passed: true });
    } catch (error) {
      report.browsers.push({ name: channel, unavailable: error.message.split('\n')[0] });
    } finally {
      await optional?.close();
    }
  }
  report.unavailableEngines = ['Firefox', 'WebKit'];
  await writeFile(`${artifactDirectory}/settings-ux-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
