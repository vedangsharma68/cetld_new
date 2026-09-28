export const LANDING_SESSION_COOKIE = 'cetld-session';

export function syncLandingSessionCookie(session, cookieTarget = document) {
  const secure = globalThis.location?.protocol === 'https:' ? '; Secure' : '';
  const base = `${LANDING_SESSION_COOKIE}=`;

  if (!session?.access_token || !session?.expires_at) {
    cookieTarget.cookie = `${base}; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    return;
  }

  const maxAge = Math.max(0, Math.floor(session.expires_at - Date.now() / 1000));
  cookieTarget.cookie = `${base}${encodeURIComponent(session.access_token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}
