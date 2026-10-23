export const AUTH_CALLBACK_PATH = '/app/';

export function authRedirectUrl(origin) {
  return new URL(AUTH_CALLBACK_PATH, origin).href;
}

// Email callbacks use implicit tokens, while Google/signup keep their PKCE flow.
// Detect partial and failed callbacks too, so they cannot restore an old account.
export function readEmailAuthLink(location) {
  const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const query = new URLSearchParams(location.search || '');
  const recovery = hash.get('type') === 'recovery';
  const problem = hash.get('error_description') || hash.get('error') || hash.get('error_code')
    || query.get('error_description') || query.get('error') || query.get('error_code');
  if (!problem && !['access_token', 'refresh_token', 'token_type'].some(key => hash.has(key))
      && !['recovery', 'magiclink', 'signup', 'invite', 'email', 'email_change'].includes(hash.get('type'))) return null;
  return {recovery, problem, accessToken: hash.get('access_token'), refreshToken: hash.get('refresh_token')};
}

export async function consumeEmailAuthLink(client, link, {clearUrl, clearLandingSession} = {}) {
  if (!link) return {handled: false};
  // Sign out locally first, including when the new link is invalid. A failed B
  // callback must never silently fall back to the browser's existing A session.
  clearLandingSession?.();
  try {
    const signedOut = await client.auth.signOut({scope: 'local'});
    if (signedOut.error) throw signedOut.error;
    if (link.problem || !link.accessToken || !link.refreshToken) throw new Error('Invalid email callback');
    const {data, error} = await client.auth.setSession({access_token: link.accessToken, refresh_token: link.refreshToken});
    if (error || !data.session?.user?.id) throw error || new Error('Missing email session');
    const verified = await client.auth.getUser();
    if (verified.error || !verified.data.user || verified.data.user.id !== data.session.user.id) {
      throw verified.error || new Error('Email session identity mismatch');
    }
    return {handled: true, recovery: link.recovery, session: {...data.session, user: verified.data.user}};
  } catch {
    // setSession can persist before a later verification fails; clear that too.
    await client.auth.signOut({scope: 'local'}).catch(() => {});
    clearLandingSession?.();
    return {handled: true, error: true, recovery: link.recovery, notice: link.recovery
      ? 'That reset link expired or could not be verified. You are signed out. Request a new one below.'
      : 'That sign-in link could not be verified. You are signed out. Please sign in below.'};
  } finally {
    clearUrl?.();
  }
}
