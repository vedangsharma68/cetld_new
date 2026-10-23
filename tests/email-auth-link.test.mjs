import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {createClient} from '@supabase/supabase-js';
import {AUTH_CALLBACK_PATH, authRedirectUrl, readEmailAuthLink, consumeEmailAuthLink} from '../auth-link.mjs';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const redirectSource = (await readFile(new URL('../auth-redirect.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
const token = id => [
  {alg: 'HS256', typ: 'JWT'}, {sub: id, exp: Math.floor(Date.now() / 1000) + 3600},
].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat(Buffer.from('test-signature').toString('base64url')).join('.');
const tokens = {a: token('account-a'), b: token('account-b')};
const user = id => ({id, email: `${id}@example.test`, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z'});

function fixture({rejectB = false, logoutStatus = 204, mismatch = false} = {}) {
  const values = new Map(), calls = [];
  let bReads = 0;
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const client = createClient('https://auth.example.test', 'test-publishable-key', {
    auth: {storage, storageKey: 'email-auth-regression', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce'},
    global: {fetch: async (url, options) => {
      calls.push({url: String(url), options});
      if (String(url).includes('/logout')) return new Response(logoutStatus === 204 ? null : JSON.stringify({message: 'unavailable'}), {status: logoutStatus});
      assert.match(String(url), /\/user$/);
      const bearer = new Headers(options.headers).get('authorization');
      const isB = bearer === `Bearer ${tokens.b}`;
      if (isB && rejectB) return Response.json({message: 'Invalid JWT', code: 'bad_jwt'}, {status: 401});
      if (isB) bReads++;
      return Response.json(user(isB && !(mismatch && bReads > 1) ? 'account-b' : 'account-a'));
    }},
  });
  return {client, storage, calls};
}

const callback = (type = 'magiclink') => readEmailAuthLink(new URL(`https://cetld.com/app/#access_token=${tokens.b}&refresh_token=refresh-b&type=${type}`));

for (const type of ['magiclink', 'recovery', 'signup']) test(`real SDK replaces stored account A with verified B for ${type} tokens`, async () => {
  const {client, calls, storage} = fixture();
  assert.equal((await client.auth.setSession({access_token: tokens.a, refresh_token: 'refresh-a'})).error, null);
  const order = [];
  const result = await consumeEmailAuthLink(client, callback(type), {clearUrl: () => order.push('scrubbed'), clearLandingSession: () => order.push('cookie-cleared')});
  assert.equal(result.error, undefined);
  assert.equal(result.session.user.id, 'account-b');
  assert.equal(result.recovery, type === 'recovery');
  assert.equal((await client.auth.getSession()).data.session.user.id, 'account-b');
  assert.equal(JSON.parse(storage.getItem('email-auth-regression')).user.id, 'account-b');
  assert.match(calls.find(call => call.url.includes('/logout')).url, /scope=local/);
  assert.equal(order[0], 'cookie-cleared');
  assert.equal(order.at(-1), 'scrubbed');
});

for (const options of [{rejectB: true}, {mismatch: true}, {logoutStatus: 503}]) test(`failed email callback stays signed out with ${JSON.stringify(options)}`, async () => {
  const {client, storage} = fixture(options);
  await client.auth.setSession({access_token: tokens.a, refresh_token: 'refresh-a'});
  const result = await consumeEmailAuthLink(client, callback());
  assert.equal(result.error, true);
  assert.match(result.notice, /could not be verified/);
  assert.equal((await client.auth.getSession()).data.session, null);
  assert.equal(storage.getItem('email-auth-regression'), null);
});

test('partial and expired callbacks clear A instead of restoring it', async () => {
  for (const suffix of ['#access_token=partial', '#refresh_token=partial', '#type=recovery', '#error=access_denied&error_description=Expired', '?error_description=Invalid']) {
    const {client} = fixture();
    await client.auth.setSession({access_token: tokens.a, refresh_token: 'refresh-a'});
    const result = await consumeEmailAuthLink(client, readEmailAuthLink(new URL(`https://cetld.com/app/${suffix}`)));
    assert.equal(result.error, true);
    assert.equal((await client.auth.getSession()).data.session, null);
  }
});

test('actual Forgot-password submit requests an implicit link back to exact /app/', async () => {
  let request;
  const recoveryDb = createClient('https://auth.example.test', 'test-publishable-key', {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit'},
    global: {fetch: async (url, options) => {request = {url: new URL(url), body: JSON.parse(options.body)};return Response.json({});}},
  });
  const submit = {innerHTML: 'Send reset link'};
  const form = {querySelector: selector => selector === '[type=submit]' ? submit : {classList: {add() {}, remove() {}}}};
  let rendered = 0;
  const context = vm.createContext({state: {authMode: 'reset'}, db: recoveryDb, recoveryDb, authRedirectUrl, location: {origin: 'https://cetld.com'}, FormData: class {get() {return 'owner@example.test';}}, authPage() {rendered++;}, authError: ''});
  const source = appSource.slice(appSource.indexOf('async function submitAuth('), appSource.indexOf('async function googleSignIn('));
  vm.runInContext(source, context);
  await context.submitAuth({preventDefault() {}, currentTarget: form});
  assert.equal(request.url.pathname, '/auth/v1/recover');
  assert.equal(request.url.searchParams.get('redirect_to'), 'https://cetld.com/app/');
  assert.equal(request.body.email, 'owner@example.test');
  assert.equal(request.body.code_challenge ?? null, null, 'recovery works without the original browser PKCE verifier');
  assert.equal(context.state.authMode, 'login');
  assert.equal(rendered, 1);
});

test('public routes forward auth artifacts to the app while normal anchors remain public', async () => {
  for (const path of ['/', '/privacy/', '/terms/']) {
    const htmlPath = path === '/' ? '../index.html' : `..${path}index.html`;
    const html = await readFile(new URL(htmlPath, import.meta.url), 'utf8');
    assert.match(html, /<script type="module" src="\/auth-redirect\.js"><\/script>/);
    for (const suffix of ['#access_token=opaque&refresh_token=refresh&type=magiclink', '#type=recovery', '#error=access_denied', '?code=opaque&sb_flow_id=flow', '?error_description=Expired']) {
      const location = new URL(`https://cetld.com${path}${suffix}`);
      let target;
      location.replace = value => {target = value;};
      vm.runInNewContext(redirectSource, {location, URLSearchParams, AUTH_CALLBACK_PATH, readEmailAuthLink});
      assert.equal(target, `/app/${location.search}${location.hash}`);
    }
  }
  const location = new URL('https://cetld.com/#features');
  location.replace = () => assert.fail('normal public-page anchors must not redirect');
  vm.runInNewContext(redirectSource, {location, URLSearchParams, AUTH_CALLBACK_PATH, readEmailAuthLink});
  assert.equal(readEmailAuthLink(location), null);
  assert.equal(authRedirectUrl('https://cetld.com'), 'https://cetld.com/app/');
});

test('manual sign-in after a rejected link restores the landing cookie and opens the new account', async () => {
  const session = {access_token: tokens.b, user: user('account-b')};
  const submit = {innerHTML: 'Sign in'};
  const form = {querySelector: selector => selector === '[type=submit]' ? submit : {classList: {add() {}, remove() {}}}};
  let cookieSession, entered;
  const context = vm.createContext({
    state: {authMode: 'login'}, authLinkBlocked: true, authRedirectUrl,
    location: {origin: 'https://cetld.com'},
    FormData: class {get() {return 'test-value';}},
    db: {auth: {signInWithPassword: async () => ({data: {session, user: session.user}, error: null})}},
    syncLandingSessionCookie(value) {cookieSession = value;},
    async enterAccount(value) {entered = value;},
    showError(_form, error) {throw error;},
  });
  const source = appSource.slice(appSource.indexOf('async function submitAuth('), appSource.indexOf('async function googleSignIn('));
  vm.runInContext(source, context);
  await context.submitAuth({preventDefault() {}, currentTarget: form});
  assert.equal(context.authLinkBlocked, false);
  assert.equal(cookieSession, session);
  assert.equal(entered.id, 'account-b');
});
