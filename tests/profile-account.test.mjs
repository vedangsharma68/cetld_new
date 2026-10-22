import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {profileFromUser} from '../profile.mjs';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const functionSource = (name) => app.split('\n').find((line) =>
  line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`));

function accountFixture(profile) {
  const user = {id: 'owner', email: 'vedang.sharma+clientqa1@example.com', user_metadata: {}};
  const rows = {
    profiles: profile,
    workspaces: {id: 'workspace', name: 'Studio'},
    workspace_settings: {business_name: 'Studio', default_currency: 'INR', default_timezone: 'UTC'},
  };
  const writes = [];
  const db = {
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; },
        limit: async () => ({data: [rows[table]]}),
        maybeSingle: async () => ({data: rows[table]}),
        single: async () => ({data: rows[table]}),
        upsert(values) { writes.push(table); rows[table] = {...values}; return query; },
        update(values) { writes.push(table); rows[table] = {...rows[table], ...values}; return query; },
      };
      return query;
    },
    auth: {updateUser: async ({data}) => ({data: {user: {...user, user_metadata: data}}})},
  };
  const state = {user, profile: profileFromUser(user), demo: false, invoices: [], aiSettings: {primary_model: 'model', fallback_model: null}};
  const context = vm.createContext({
    state, db, profileFromUser, authSync: Promise.resolve(),
    resetAIModelAvailability() {},
    loadAIWorkspaceConfiguration: async () => ({models: [['model']], fallbackModels: [], aiSettings: state.aiSettings}),
    aiRequest() {}, VERIFIED_AI_MODELS: ['model'], VERIFIED_AI_FALLBACK_MODELS: [],
    AI_MODELS: [['model']], AI_FALLBACK_MODELS: [], CURRENCIES: [['INR']],
    captureReminderPreviewSession() {},
    enterAccount: async () => { throw Error('Unexpected account reload'); },
    authPage: () => assert.fail('Unexpected auth error'),
    businessNameReminderPauseCount: async () => 0, businessNameReminderNotice: () => '',
    readAIModelPickerValues: () => ({primary_model: 'model', fallback_model: null}),
    FormData: class { get(key) { return {full_name: 'Mary-Jane McDonald', business_name: 'Studio', default_currency: 'INR', default_timezone: 'UTC'}[key]; } },
    render() {}, toast() {}, showError: (_form, error) => { throw error; },
    // Capture the name displayed by the real Overview and Settings renderers.
    escape: (value) => value, dashboardGreeting: () => 'Good morning',
    totals: () => ({}), intro: (title) => { context.title = title; return ''; },
    button: () => '', icon: () => '', animatedMoney: () => '', overviewAssistant: () => '',
    collectionsPulseCard: () => '', activityFeed: () => '', invoicePanel: () => '',
    currencyOptions: () => '', modelOptions: () => '', followUpPreferencesForm: () => '',
    ownerNumberForm: () => '', tag: () => '', document: {documentElement: {classList: {contains: () => false}}},
  });
  for (const name of ['ensureAccount', 'saveSettings', 'syncSession', 'overview', 'settings']) {
    vm.runInContext(functionSource(name), context);
  }
  return {context, state, rows, writes, user};
}

function assertDisplayedName(context, fullName, firstName) {
  context.overview();
  assert.equal(context.title, `Good morning, ${firstName}.`);
  assert.ok(context.settings().includes(`name="full_name" value="${fullName}"`));
}

for (const profile of [null, {user_id: 'owner', full_name: null}])
test(`account initializes a sensible name with ${profile ? 'an empty' : 'no'} profile row`, async () => {
  const {context, state, rows} = accountFixture(profile);
  await context.ensureAccount(state.user);
  assert.equal(state.profile.fullName, 'Vedang Sharma');
  assert.equal(state.profile.initials, 'VS');
  if (!profile) assert.equal(rows.profiles.full_name, 'Vedang Sharma');
  assertDisplayedName(context, 'Vedang Sharma', 'Vedang');
});

test('saved profile wins over email and stale metadata, including repeated session refreshes', async () => {
  const {context, state, writes, user} = accountFixture({user_id: 'owner', full_name: 'Mary-Jane McDonald'});
  const staleUser = {...user, user_metadata: {full_name: 'QA'}};
  await context.ensureAccount(staleUser);
  for (let i = 0; i < 2; i++) await context.syncSession({user: staleUser});
  assert.equal(state.profile.fullName, 'Mary-Jane McDonald');
  assert.equal(state.profile.initials, 'MM');
  assert.deepEqual(writes, []);
  assertDisplayedName(context, 'Mary-Jane McDonald', 'Mary-Jane');
});

test('Settings saves the real name and keeps it through refresh and account reload', async () => {
  const {context, state, rows, user} = accountFixture({user_id: 'owner', full_name: null});
  await context.ensureAccount(user);
  const submit = {disabled: false};
  await context.saveSettings({preventDefault() {}, currentTarget: {querySelector: () => submit}});
  assert.equal(submit.disabled, false);
  assert.equal(rows.profiles.full_name, 'Mary-Jane McDonald');
  assert.equal(state.user.user_metadata.full_name, 'Mary-Jane McDonald');
  await context.syncSession({user});
  assertDisplayedName(context, 'Mary-Jane McDonald', 'Mary-Jane');
  await context.ensureAccount(user);
  assertDisplayedName(context, 'Mary-Jane McDonald', 'Mary-Jane');
});
