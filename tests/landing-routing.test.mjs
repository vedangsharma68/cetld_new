import assert from 'node:assert/strict';
import test from 'node:test';
import landingAuthRedirect, {config} from '../middleware.js';
import {LANDING_SESSION_COOKIE, syncLandingSessionCookie} from '../session-cookie.mjs';

test('landing middleware leaves anonymous requests on the crawler-readable page', async () => {
  const response = await landingAuthRedirect(new Request('https://cetld.com/'));
  assert.equal(response.headers.get('x-middleware-next'), '1');
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(config, {matcher: '/'});
});

test('landing middleware server-validates the session cookie before redirecting', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let authRequest;
  globalThis.fetch = async (url, options) => {
    authRequest = {url, options};
    return new Response('{}', {status: 200});
  };

  const request = new Request('https://cetld.com/', {
    headers: {cookie: `${LANDING_SESSION_COOKIE}=signed-access-token`},
  });
  const response = await landingAuthRedirect(request);

  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://cetld.com/app/');
  assert.match(authRequest.url, /\/auth\/v1\/user$/);
  assert.equal(authRequest.options.headers.authorization, 'Bearer signed-access-token');
});

test('invalid or unverifiable cookies still receive the public landing page', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('{}', {status: 401});

  const response = await landingAuthRedirect(new Request('https://cetld.com/', {
    headers: {cookie: `${LANDING_SESSION_COOKIE}=expired-token`},
  }));
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('browser auth lifecycle writes and clears the landing session cookie', () => {
  const target = {cookie: ''};
  syncLandingSessionCookie({access_token: 'one.two.three', expires_at: Math.ceil(Date.now() / 1000) + 3600}, target);
  assert.match(target.cookie, /^cetld-session=one.two.three; Path=\/; Max-Age=3\d{3}; SameSite=Lax$/);

  syncLandingSessionCookie(null, target);
  assert.equal(target.cookie, 'cetld-session=; Path=/; Max-Age=0; SameSite=Lax');
});
