import {
  createClient,
  type AuthError,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";

/**
 * The subset of the Supabase storage adapter contract needed by auth-js.
 * Keeping this structural makes the browser factory easy to use with a
 * custom adapter (for example, an encrypted adapter) without coupling this
 * module to a framework.
 */
export interface SessionStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface BrowserAuthClientOptions {
  supabaseUrl: string;
  publishableKey: string;
  storage?: SessionStorageAdapter;
}

export interface GoogleSignInOptions {
  /** Must exactly equal one of the configured callback URLs. */
  redirectTo: string;
  allowedCallbackUrls: readonly string[];
  scopes?: string;
  queryParams?: Record<string, string>;
}

export interface OAuthCallbackOptions {
  allowedCallbackUrls: readonly string[];
}

export interface RestoredSession {
  session: Session;
  user: User;
}

/** A configuration or callback input was not safe to use. */
export class AuthConfigurationError extends Error {
  readonly code = "auth_configuration_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

/** The OAuth provider returned an error or an unusable callback. */
export class OAuthCallbackError extends Error {
  readonly code = "oauth_callback_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

/** The persisted session could not be verified against Supabase Auth. */
export class SessionRestoreError extends Error {
  readonly code = "session_restore_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "SessionRestoreError";
  }
}

/**
 * Create the one browser Supabase client used by an application.
 *
 * `detectSessionInUrl` stays disabled because the callback is handled
 * explicitly by `exchangeOAuthCode`. This avoids silently accepting an
 * arbitrary URL and makes callback validation part of the application flow.
 * Supabase uses browser localStorage by default when no adapter is supplied.
 */
export function createBrowserAuthClient({
  supabaseUrl,
  publishableKey,
  storage,
}: BrowserAuthClientOptions): SupabaseClient {
  if (!supabaseUrl || !publishableKey) {
    throw new AuthConfigurationError(
      "supabaseUrl and publishableKey are required to create the auth client",
    );
  }

  return createClient(supabaseUrl, publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      ...(storage ? { storage } : {}),
    },
  });
}

/**
 * Require a redirect URI to be an exact configured string.
 *
 * Do not use wildcards, prefix checks, or origin-only checks here: OAuth
 * redirects must be allowlisted by the application and by Supabase Auth.
 */
export function assertAllowedRedirectUrl(
  redirectTo: string,
  allowedCallbackUrls: readonly string[],
): void {
  if (
    typeof redirectTo !== "string" ||
    !allowedCallbackUrls.some((allowed) => allowed === redirectTo)
  ) {
    throw new AuthConfigurationError(
      "The OAuth redirect URL is not an exact match for an allowed callback URL",
    );
  }
}

/**
 * Start Google OAuth using the browser client's PKCE configuration.
 * The returned object is the native Supabase auth response; in a browser the
 * SDK normally redirects immediately unless `skipBrowserRedirect` is added by
 * a caller using the lower-level SDK directly.
 */
export function signInWithGoogle(
  client: SupabaseClient,
  options: GoogleSignInOptions,
) {
  assertAllowedRedirectUrl(options.redirectTo, options.allowedCallbackUrls);

  return client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: options.redirectTo,
      ...(options.scopes ? { scopes: options.scopes } : {}),
      ...(options.queryParams ? { queryParams: options.queryParams } : {}),
    },
  });
}

const OAUTH_CALLBACK_PARAMETERS = new Set([
  "code",
  "state",
  "sb_flow_id",
  "error",
  "error_code",
  "error_description",
]);

function sortedEntries(params: URLSearchParams): string[] {
  return [...params.entries()]
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
    )
    .map(([key, value]) => `${key}=${value}`);
}

/**
 * Validate the callback's fixed destination while allowing only parameters
 * produced by the OAuth callback itself (`code`, `state`, errors, and the
 * optional Supabase PKCE flow id).
 */
function assertAllowedCallbackUrl(
  callbackUrl: URL,
  allowedCallbackUrls: readonly string[],
): void {
  const matches = allowedCallbackUrls.some((allowedValue) => {
    let allowed: URL;
    try {
      allowed = new URL(allowedValue);
    } catch {
      return false;
    }

    if (
      callbackUrl.origin !== allowed.origin ||
      callbackUrl.pathname !== allowed.pathname ||
      callbackUrl.hash !== ""
    ) {
      return false;
    }

    const callbackStaticParams = new URLSearchParams(callbackUrl.search);
    for (const key of OAUTH_CALLBACK_PARAMETERS) {
      callbackStaticParams.delete(key);
    }

    return (
      sortedEntries(callbackStaticParams).join("&") ===
      sortedEntries(allowed.searchParams).join("&")
    );
  });

  if (!matches) {
    throw new AuthConfigurationError(
      "The OAuth callback URL does not match an allowed callback destination",
    );
  }
}

/**
 * Exchange the one-time PKCE code returned by Supabase Auth.
 * This function intentionally accepts a full callback URL so callers can
 * validate the destination before giving the code to the SDK.
 */
export async function exchangeOAuthCode(
  client: SupabaseClient,
  callbackUrl: string | URL,
  options: OAuthCallbackOptions,
) {
  let url: URL;
  try {
    url = callbackUrl instanceof URL ? callbackUrl : new URL(callbackUrl);
  } catch {
    throw new OAuthCallbackError("The OAuth callback is not a valid absolute URL");
  }

  assertAllowedCallbackUrl(url, options.allowedCallbackUrls);

  const providerError = url.searchParams.get("error");
  if (providerError) {
    const description = url.searchParams.get("error_description");
    throw new OAuthCallbackError(
      description ? `${providerError}: ${description}` : providerError,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new OAuthCallbackError("The OAuth callback does not contain an auth code");
  }

  const flowId = url.searchParams.get("sb_flow_id");
  return client.auth.exchangeCodeForSession(
    code,
    flowId ? { flowId } : undefined,
  );
}

/**
 * Restore a persisted session and verify its user with Supabase Auth.
 * `getSession` reads the local persisted session; `getUser` validates the
 * access token with the Auth server before the session is trusted by callers.
 */
export async function restoreSession(
  client: SupabaseClient,
): Promise<{ data: RestoredSession | null; error: AuthError | SessionRestoreError | null }> {
  const sessionResult = await client.auth.getSession();
  if (sessionResult.error) {
    return { data: null, error: sessionResult.error };
  }

  const session = sessionResult.data.session;
  if (!session) {
    return { data: null, error: null };
  }

  const userResult = await client.auth.getUser();
  if (userResult.error) {
    return { data: null, error: userResult.error };
  }

  const user = userResult.data.user;
  if (!user || user.id !== session.user.id) {
    return {
      data: null,
      error: new SessionRestoreError("The persisted session user could not be verified"),
    };
  }

  return { data: { session, user }, error: null };
}

/** Sign out and clear the persisted Supabase Auth session. */
export function logout(client: SupabaseClient) {
  return client.auth.signOut();
}
