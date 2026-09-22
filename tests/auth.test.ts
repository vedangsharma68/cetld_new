import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AuthConfigurationError,
  OAuthCallbackError,
  SessionRestoreError,
  assertAllowedRedirectUrl,
  exchangeOAuthCode,
  logout,
  restoreSession,
  signInWithGoogle,
} from "../src/auth.js";

const callback = "https://app.example.test/auth/callback";

function fakeClient(auth: Record<string, unknown>): SupabaseClient {
  return { auth } as unknown as SupabaseClient;
}

test("Google sign-in uses PKCE client flow and an exact callback allowlist", async () => {
  let received: unknown;
  const client = fakeClient({
    signInWithOAuth: async (request: unknown) => {
      received = request;
      return { data: { provider: "google", url: "https://accounts.google.test" }, error: null };
    },
  });

  const result = await signInWithGoogle(client, {
    redirectTo: callback,
    allowedCallbackUrls: [callback],
  });

  assert.deepEqual(result, {
    data: { provider: "google", url: "https://accounts.google.test" },
    error: null,
  });
  assert.deepEqual(received, {
    provider: "google",
    options: { redirectTo: callback },
  });
});

test("OAuth redirect validation rejects lookalike URLs", () => {
  assertAllowedRedirectUrl(callback, [callback]);

  assert.throws(
    () => assertAllowedRedirectUrl(`${callback}/other`, [callback]),
    AuthConfigurationError,
  );
  assert.throws(
    () => assertAllowedRedirectUrl("https://evil.example.test/auth/callback", [callback]),
    AuthConfigurationError,
  );
});

test("callback code is exchanged only after callback destination validation", async () => {
  let exchangeArguments: unknown[] = [];
  const client = fakeClient({
    exchangeCodeForSession: async (...args: unknown[]) => {
      exchangeArguments = args;
      return { data: { session: "session" }, error: null };
    },
  });

  const result = await exchangeOAuthCode(
    client,
    `${callback}?code=one-time-code&state=state-1&sb_flow_id=flow-1`,
    { allowedCallbackUrls: [callback] },
  );

  assert.deepEqual(result, { data: { session: "session" }, error: null });
  assert.deepEqual(exchangeArguments, ["one-time-code", { flowId: "flow-1" }]);

  await assert.rejects(
    exchangeOAuthCode(
      client,
      "https://evil.example.test/auth/callback?code=stolen",
      { allowedCallbackUrls: [callback] },
    ),
    AuthConfigurationError,
  );
  assert.deepEqual(exchangeArguments, ["one-time-code", { flowId: "flow-1" }]);
});

test("provider callback errors and missing codes fail clearly", async () => {
  const client = fakeClient({
    exchangeCodeForSession: async () => ({ data: null, error: null }),
  });

  await assert.rejects(
    exchangeOAuthCode(
      client,
      `${callback}?error=access_denied&error_description=User%20cancelled`,
      { allowedCallbackUrls: [callback] },
    ),
    (error: unknown) =>
      error instanceof OAuthCallbackError &&
      error.message === "access_denied: User cancelled",
  );

  await assert.rejects(
    exchangeOAuthCode(client, callback, { allowedCallbackUrls: [callback] }),
    OAuthCallbackError,
  );
});

test("session persistence is restored from storage and verified with getUser", async () => {
  const session = {
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    expires_at: 1_900_000_000,
    token_type: "bearer",
    user: { id: "user-1" },
  } as any;
  const user = { id: "user-1", email: "user@example.test" } as any;
  const calls: string[] = [];
  const client = fakeClient({
    getSession: async () => {
      calls.push("getSession");
      return { data: { session }, error: null };
    },
    getUser: async () => {
      calls.push("getUser");
      return { data: { user }, error: null };
    },
  });

  const result = await restoreSession(client);

  assert.deepEqual(calls, ["getSession", "getUser"]);
  assert.deepEqual(result, { data: { session, user }, error: null });
});

test("session restore rejects a user mismatch instead of trusting persisted data", async () => {
  const session = { user: { id: "user-1" } } as any;
  const client = fakeClient({
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async () => ({ data: { user: { id: "user-2" } }, error: null }),
  });

  const result = await restoreSession(client);

  assert.equal(result.data, null);
  assert.ok(result.error instanceof SessionRestoreError);
});

test("logout delegates to Supabase and therefore clears its persisted session", async () => {
  let called = false;
  const client = fakeClient({
    signOut: async () => {
      called = true;
      return { error: null };
    },
  });

  const result = await logout(client);

  assert.equal(called, true);
  assert.deepEqual(result, { error: null });
});
